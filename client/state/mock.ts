// Mock transport: replays fixtures/events.json on a timeline and answers commands locally,
// so the scene and the UI run without a server (open the app with ?mock=1).
// Owned by the coordinator.

import { DEFAULT_REPORT_DIR } from '../../shared/folders';
import type { AgentPresence, ClientCommand, Department, ServerEvent } from '../../shared/types';
import type { Store } from './store';

export interface TimedEvent {
  at: number; // milliseconds after start
  event: ServerEvent;
}

export function startMock(store: Store, timeline: TimedEvent[], speed = 1): () => void {
  const timers: number[] = [];
  let managerReplyCount = 0;

  store.setTransport({
    send(command: ClientCommand) {
      switch (command.type) {
        case 'chat.send': {
          const now = new Date().toISOString();
          store.dispatch({
            type: 'chat.message',
            message: { id: `m-${Date.now()}`, department: command.department, role: 'user', text: command.text, at: now, streaming: false },
          });
          const reply = `mock-reply-${(managerReplyCount += 1)}`;
          const text = `Noted. I will put that on the board and start a subagent. (mock reply to: ${command.text.slice(0, 40)})`;
          const manager = store.getState().agents.find((a) => a.id === `manager:${command.department}`);
          if (manager) store.dispatch({ type: 'agent.upsert', agent: { ...manager, status: 'thinking' } });
          let i = 0;
          const tick = window.setInterval(() => {
            const chunk = text.slice(i, i + 6);
            i += 6;
            store.dispatch({ type: 'chat.delta', department: command.department, messageId: reply, text: chunk });
            if (i >= text.length) {
              window.clearInterval(tick);
              store.dispatch({ type: 'chat.done', department: command.department, messageId: reply });
              if (manager) store.dispatch({ type: 'agent.upsert', agent: { ...manager, status: 'idle' } });
            }
          }, 40 / speed);
          timers.push(tick);
          break;
        }
        case 'department.create': {
          const state = store.getState();
          const slot = Math.max(-1, ...state.config.departments.map((d) => d.slot)) + 1;
          const id = command.input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 32) || `dept-${slot}`;
          const department: Department = {
            id,
            name: command.input.name,
            color: command.input.color,
            responsibility: command.input.responsibility,
            cwd: command.input.cwd,
            model: command.input.model,
            permission: command.input.permission,
            repos: command.input.repos ?? [],
            reportDirs: command.input.reportDirs?.length ? command.input.reportDirs : [DEFAULT_REPORT_DIR],
            ...(command.input.knowledgeDirs?.length ? { knowledgeDirs: command.input.knowledgeDirs } : {}),
            trellaBoardId: null,
            sessionId: null,
            slot,
            createdAt: new Date().toISOString(),
          };
          store.dispatch({ type: 'department.created', department });
          store.dispatch({ type: 'session.state', state: { department: id, status: 'off', sessionId: null, model: null, startedAt: null, error: null, bypass: false } });
          const manager: AgentPresence = {
            id: `manager:${id}`,
            department: id,
            kind: 'manager',
            title: `${department.name} manager`,
            cardKey: null,
            model: department.model,
            status: 'idle',
            currentTool: null,
            lastText: null,
            startedAt: new Date().toISOString(),
            endedAt: null,
            parentToolUseId: null,
          };
          store.dispatch({ type: 'agent.upsert', agent: manager });
          break;
        }
        case 'department.update': {
          const department = store.getState().config.departments.find((d) => d.id === command.id);
          if (department) {
            const updated: Department = { ...department, ...command.patch };
            // An empty list clears the folders, as the server does.
            if (command.patch.knowledgeDirs && command.patch.knowledgeDirs.length === 0) delete updated.knowledgeDirs;
            store.dispatch({ type: 'department.updated', department: updated });
          }
          break;
        }
        case 'department.remove':
          store.dispatch({ type: 'department.removed', id: command.id });
          break;
        case 'session.start': {
          const now = new Date().toISOString();
          store.dispatch({ type: 'session.state', state: { department: command.department, status: 'starting', sessionId: null, model: null, startedAt: now, error: null, bypass: false } });
          timers.push(
            window.setTimeout(() => {
              store.dispatch({ type: 'session.state', state: { department: command.department, status: 'ready', sessionId: 'mock-session', model: 'claude-opus-5-5', startedAt: now, error: null, bypass: false } });
            }, 800 / speed),
          );
          break;
        }
        case 'session.stop':
          store.dispatch({ type: 'session.state', state: { department: command.department, status: 'off', sessionId: null, model: null, startedAt: null, error: null, bypass: false } });
          break;
        case 'session.interrupt':
          break;
        case 'session.bypass': {
          const current = store.getState().sessions.find((x) => x.department === command.department);
          if (current) store.dispatch({ type: 'session.state', state: { ...current, bypass: command.on } });
          break;
        }
        case 'permission.answer':
          store.dispatch({ type: 'permission.resolved', id: command.id, allow: command.allow });
          break;
      }
    },
  });
  store.setConnection('mock');

  for (const item of timeline) {
    timers.push(window.setTimeout(() => store.dispatch(item.event), item.at / speed));
  }
  return () => {
    for (const t of timers) {
      window.clearTimeout(t);
      window.clearInterval(t);
    }
  };
}
