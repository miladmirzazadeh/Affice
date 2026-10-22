// The client store: one state object, a reducer over ServerEvents, and a transport for commands.
// Owned by the coordinator. UI-only state belongs in client/state/ui.ts, not here.

import type { Connection, OfficeState, OfficeStore, Selection } from '../../shared/scene-api';
import type { ClientCommand, OfficeSnapshot, ServerEvent } from '../../shared/types';

const MAX_MESSAGES_PER_DEPARTMENT = 200;

export const emptySnapshot: OfficeSnapshot = {
  config: { version: 1, company: 'Your office', trellaUrl: 'http://localhost:4174', departments: [] },
  sessions: [],
  agents: [],
  messages: [],
  permissions: [],
};

function keepSelection(selected: Selection, snapshot: OfficeSnapshot): Selection {
  if (!selected) return null;
  const exists =
    selected.kind === 'department' ? snapshot.config.departments.some((d) => d.id === selected.id) : snapshot.agents.some((a) => a.id === selected.id);
  return exists ? selected : null;
}

export function reduce(state: OfficeState, event: ServerEvent): OfficeState {
  switch (event.type) {
    case 'app.state':
      return { ...state, app: event.state };
    case 'office.state':
      // A project switch sends a whole new office: a selection that is not in it any more (a department or
      // an agent of the project that was closed) goes, one that still exists (a reconnect) stays.
      return { ...state, ...event.snapshot, selected: keepSelection(state.selected, event.snapshot) };
    case 'department.created':
    case 'department.updated': {
      const others = state.config.departments.filter((d) => d.id !== event.department.id);
      const departments = [...others, event.department].sort((a, b) => a.slot - b.slot);
      return { ...state, config: { ...state.config, departments } };
    }
    case 'department.removed':
      return {
        ...state,
        config: { ...state.config, departments: state.config.departments.filter((d) => d.id !== event.id) },
        sessions: state.sessions.filter((s) => s.department !== event.id),
        agents: state.agents.filter((a) => a.department !== event.id),
        messages: state.messages.filter((m) => m.department !== event.id),
        permissions: state.permissions.filter((p) => p.department !== event.id),
        selected: state.selected?.kind === 'department' && state.selected.id === event.id ? null : state.selected,
      };
    case 'session.state': {
      const sessions = state.sessions.filter((s) => s.department !== event.state.department);
      return { ...state, sessions: [...sessions, event.state] };
    }
    case 'chat.message': {
      const messages = [...state.messages.filter((m) => m.id !== event.message.id), event.message];
      return { ...state, messages: trimMessages(messages) };
    }
    case 'chat.delta': {
      const existing = state.messages.find((m) => m.id === event.messageId);
      const messages = existing
        ? state.messages.map((m) => (m.id === event.messageId ? { ...m, text: m.text + event.text } : m))
        : [
            ...state.messages,
            {
              id: event.messageId,
              department: event.department,
              role: 'manager' as const,
              text: event.text,
              at: new Date().toISOString(),
              streaming: true,
            },
          ];
      return { ...state, messages: trimMessages(messages) };
    }
    case 'chat.done':
      return {
        ...state,
        messages: state.messages.map((m) => (m.id === event.messageId ? { ...m, streaming: false } : m)),
      };
    case 'agent.upsert': {
      const agents = state.agents.filter((a) => a.id !== event.agent.id);
      return { ...state, agents: [...agents, event.agent] };
    }
    case 'agent.removed':
      return {
        ...state,
        agents: state.agents.filter((a) => a.id !== event.id),
        selected: state.selected?.kind === 'agent' && state.selected.id === event.id ? null : state.selected,
      };
    case 'tool.started':
      return {
        ...state,
        agents: state.agents.map((a) =>
          a.id === event.agentId ? { ...a, currentTool: event.name, status: a.status === 'waiting' ? 'waiting' : 'working' } : a,
        ),
      };
    case 'tool.finished':
      return {
        ...state,
        agents: state.agents.map((a) => (a.id === event.agentId ? { ...a, currentTool: null } : a)),
      };
    case 'permission.requested':
      return {
        ...state,
        permissions: [...state.permissions.filter((p) => p.id !== event.request.id), event.request],
        agents: state.agents.map((a) => (a.id === event.request.agentId ? { ...a, status: 'waiting' } : a)),
      };
    case 'permission.resolved': {
      const request = state.permissions.find((p) => p.id === event.id);
      return {
        ...state,
        permissions: state.permissions.filter((p) => p.id !== event.id),
        agents: state.agents.map((a) =>
          request && a.id === request.agentId && a.status === 'waiting' ? { ...a, status: 'working' } : a,
        ),
      };
    }
    case 'turn.result':
    case 'error':
      return state;
    default:
      // A newer server may send an event this client does not know: keep the state as it is.
      return state;
  }
}

function trimMessages(messages: OfficeState['messages']): OfficeState['messages'] {
  const counts = new Map<string, number>();
  const kept: OfficeState['messages'] = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    const n = (counts.get(m.department) ?? 0) + 1;
    counts.set(m.department, n);
    if (n <= MAX_MESSAGES_PER_DEPARTMENT) kept.unshift(m);
  }
  return kept;
}

export interface Transport {
  send(command: ClientCommand): void;
}

export function createStore(transport: Transport, connection: Connection = 'connecting'): OfficeStore & {
  setConnection(connection: Connection): void;
  setTransport(transport: Transport): void;
} {
  let state: OfficeState = { ...emptySnapshot, selected: null, connection, app: null };
  let current = transport;
  const listeners = new Set<(s: OfficeState, p: OfficeState) => void>();

  function set(next: OfficeState) {
    if (next === state) return;
    const previous = state;
    state = next;
    for (const listener of listeners) listener(state, previous);
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch(event) {
      set(reduce(state, event));
    },
    send(command) {
      current.send(command);
    },
    select(selection: Selection) {
      set({ ...state, selected: selection });
    },
    setConnection(next) {
      set({ ...state, connection: next });
    },
    setTransport(next) {
      current = next;
    },
  };
}

export type Store = ReturnType<typeof createStore>;
