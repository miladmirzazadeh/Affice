// The office: the departments (OfficeStore), one manager session per department, approvals, and the
// live snapshot. Every event goes through the client's own reducer (client/state/store.ts), so the
// snapshot a new connection gets is exactly what a client that saw every event would hold.

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { OfficeState } from '../shared/scene-api';
import { RouteError } from '../shared/server-api';
import { GENERAL_ID, PERMISSION_PART_CAP, type ChatMessage, type ClientCommand, type DepartmentInput, type DepartmentPatch, type OfficeCommand, type OfficeSnapshot, type ServerEvent } from '../shared/types';
import { emptySnapshot, reduce } from '../client/state/store';
import { Approvals } from './approvals';
import { describeRequest, visible } from './claude/approval-card';
import { summarizeTool, type ManagerSession } from './claude/driver';
import type { OfficeStore } from './office-store';
import type { HttpRouter } from './router';
import type { CreateBoard } from './trella-cli';

const MAX_MESSAGE = 100_000;
/** How long ask_manager waits for the end of the department manager's turn. */
export const ASK_TIMEOUT_MS = 10 * 60 * 1000;
/** A request chain is at most this many managers deep: the general manager asks one, which may ask one more. */
export const MAX_ASK_DEPTH = 2;

/** The tool name of the approval card for an ask_manager call to a manager that accepts edits. */
export const ASK_APPROVAL_TOOL = 'mcp__office__ask_manager';
/** A message to a manager that accepts edits must fit in its approval card whole: the user decides on all of it. */
export const MAX_APPROVED_ASK = PERMISSION_PART_CAP;

/** The card summary of an ask_manager call: who asks whom, and the whole message. */
export function askSummary(from: string, to: string, message: string): string {
  return visible(`${from} asks ${to}: ${message}`);
}

/** The first line of a colleague message in the target manager's stdin, so it knows who asks. */
export function colleaguePrefix(fromName: string): string {
  return `From ${fromName}, another manager of this office, not the user. Your reply in this turn goes back to ${fromName}.`;
}

/** An ask_manager call that is waiting for its answer. The office tracks these itself; the caller never says how deep it is. */
interface OpenAsk {
  from: string;
  to: string;
  /** 1 for a manager that is not itself answering a colleague, else one more than the ask it is answering. */
  depth: number;
  /** The message reached the target (the target's turn for it is queued or running). */
  sent: boolean;
}

export interface AskResult {
  reply: string;
  /** False when the turn had not ended within the wait. */
  done: boolean;
}

export interface OfficeOptions {
  store: OfficeStore;
  createSession: (departmentId: string) => ManagerSession;
  createBoard: CreateBoard;
  log?: (line: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A frame from the socket as a ClientCommand, or the reason it is not one. */
export function parseCommand(raw: string): ClientCommand | string {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return 'The command is not JSON.';
  }
  if (!isRecord(value) || typeof value.type !== 'string') return 'A command needs a type.';
  const s = (key: string) => typeof value[key] === 'string';
  switch (value.type) {
    case 'chat.send':
      return s('department') && s('text') ? (value as ClientCommand) : 'chat.send needs a department and a text.';
    case 'session.start':
    case 'session.stop':
    case 'session.interrupt':
      return s('department') ? (value as ClientCommand) : `${value.type} needs a department.`;
    case 'session.bypass':
      return s('department') && typeof value.on === 'boolean' ? (value as ClientCommand) : 'session.bypass needs a department and on.';
    case 'department.create':
      return isRecord(value.input) ? (value as ClientCommand) : 'department.create needs an input.';
    case 'department.update':
      return s('id') && isRecord(value.patch) ? (value as ClientCommand) : 'department.update needs an id and a patch.';
    case 'department.remove':
      return s('id') ? (value as ClientCommand) : 'department.remove needs an id.';
    case 'permission.answer':
      return s('id') && typeof value.allow === 'boolean' ? (value as ClientCommand) : 'permission.answer needs an id and allow.';
    case 'claude.refresh':
    case 'claude.login':
    case 'claude.cancelLogin':
    case 'project.close':
      return value as ClientCommand;
    case 'project.open':
      return s('path') ? (value as ClientCommand) : 'project.open needs a path.';
    default:
      return `Unknown command: ${value.type}.`;
  }
}

export class Office extends EventEmitter {
  readonly approvals: Approvals;
  private live: OfficeState;
  private readonly sessions = new Map<string, ManagerSession>();
  private readonly asks = new Set<OpenAsk>();
  private readonly store: OfficeStore;
  private readonly log: (line: string) => void;

  constructor(private readonly options: OfficeOptions) {
    super();
    this.store = options.store;
    this.log = options.log ?? ((line) => console.log(`[affice] ${line}`));
    this.approvals = new Approvals({
      emit: (event) => this.apply(event),
      describe: ({ department, tool, input, toolUseId }) => {
        const session = this.sessions.get(department);
        const config = this.store.byId(department);
        if (!session || !config) throw new RouteError(404, `No session for department ${department}.`);
        const fields = isRecord(input) ? input : {};
        const asking = tool === ASK_APPROVAL_TOOL && typeof fields.from === 'string' && typeof fields.to === 'string' && typeof fields.message === 'string';
        // An ask card carries the whole message in its summary; every other card shows the working directory,
        // the file, and the command or the edit in full (server/claude/approval-card.ts).
        const summary = asking ? askSummary(fields.from as string, fields.to as string, fields.message as string) : summarizeTool(tool, input, config.cwd);
        const { path, parts } = asking ? { path: null, parts: [] } : describeRequest(tool, input);
        return { department, agentId: session.ownerOf(toolUseId), tool, input, summary, cwd: visible(config.cwd), path, parts };
      },
      waiting: (department, agentId, waiting) => {
        if (agentId) this.sessions.get(department)?.setWaiting(agentId, waiting);
      },
    });

    const sessions = [];
    const agents = [];
    const messages: ChatMessage[] = [];
    for (const department of this.store.departments()) {
      const snapshot = this.addSession(department.id).snapshot();
      sessions.push(snapshot.state);
      agents.push(...snapshot.agents);
      messages.push(...this.store.loadChat(department.id));
    }
    messages.sort((a, b) => a.at.localeCompare(b.at));
    this.live = { ...emptySnapshot, config: this.store.config, sessions, agents, messages, permissions: [], selected: null, connection: 'live', app: null };
  }

  snapshot(): OfficeSnapshot {
    return {
      config: this.store.config,
      sessions: this.live.sessions,
      agents: this.live.agents,
      messages: this.live.messages,
      permissions: this.live.permissions,
    };
  }

  /** One command of the office. The app commands (Claude, project) are the host's (server/host.ts). */
  async handle(command: OfficeCommand): Promise<void> {
    try {
      switch (command.type) {
        case 'chat.send':
          return this.chatSend(command.department, command.text);
        case 'session.start':
          return this.session(command.department).start();
        case 'session.stop':
          return await this.session(command.department).stop();
        case 'session.interrupt':
          return this.session(command.department).interrupt();
        case 'session.bypass':
          return await this.session(command.department).setBypass(command.on);
        case 'department.create':
          return await this.createDepartment(command.input);
        case 'department.update':
          return this.updateDepartment(command.id, command.patch);
        case 'department.remove':
          return await this.removeDepartment(command.id);
        case 'permission.answer':
          if (!this.approvals.answer(command.id, command.allow)) throw new Error('This approval is no longer open.');
          return;
      }
    } catch (error) {
      const department = 'department' in command ? command.department : 'id' in command && command.type !== 'permission.answer' ? command.id : null;
      this.apply({ type: 'error', department, message: error instanceof Error ? error.message : String(error) });
    }
  }

  // The office tools of every manager (server/claude/approvals-mcp.ts calls these over HTTP) ---------

  /** list_departments: who is in the office. */
  listDepartments(): unknown[] {
    return this.store.departments().map((d) => ({
      id: d.id,
      name: d.name,
      kind: d.kind ?? 'room',
      responsibility: d.responsibility,
      model: d.model,
      session: this.sessions.get(d.id)?.snapshot().state.status ?? 'off',
      trellaBoardId: d.trellaBoardId,
      repos: d.repos,
    }));
  }

  /** office_status: per department the session, the agents and the open approvals. */
  status(): unknown[] {
    return this.store.departments().map((d) => {
      const snapshot = this.sessions.get(d.id)?.snapshot();
      return {
        id: d.id,
        name: d.name,
        session: snapshot ? { status: snapshot.state.status, bypass: snapshot.state.bypass, error: snapshot.state.error } : null,
        agents: (snapshot?.agents ?? []).map((a) => ({ id: a.id, kind: a.kind, title: a.title, status: a.status, cardKey: a.cardKey, currentTool: a.currentTool })),
        approvals: this.live.permissions.filter((p) => p.department === d.id).map((p) => ({ tool: p.tool, summary: p.summary, at: p.at })),
      };
    });
  }

  /**
   * ask_manager: `from` (a manager) asks `target` something. Posts the message in the target's chat as a
   * colleague message that names `from`, starts the session when it is off, waits for a turn of its own
   * (the session ready, then priority later), and returns that turn's reply. After `timeoutMs` it returns
   * what it has. Loop guard, tracked here and not trusted from the caller: never to itself, never to a
   * manager running with approvals off, never to a manager that is itself waiting for an answer (which
   * also rules out every cycle), and at most MAX_ASK_DEPTH managers deep. `from` defaults to the general
   * manager. An ask to a manager whose policy is `accept-edits` waits for the user first (an approval card
   * with the whole message), because that manager acts on it with no card of its own for edits: without
   * this, a read-only manager, or text it read, would be a way around the policy of the manager it asks.
   * Asks to `ask` and `read-only` managers need no card: their own actions go through their own rules.
   */
  async askManager(target: string, message: string, timeoutMs = ASK_TIMEOUT_MS, from = GENERAL_ID): Promise<AskResult> {
    const caller = this.store.byId(from);
    if (!caller) throw new RouteError(404, `There is no department ${from} to ask from.`);
    const fromName = caller.kind === 'lobby' ? caller.name : `${caller.name} manager`;
    if (target === from) throw new RouteError(400, `${fromName} cannot ask itself.`);
    const department = this.store.byId(target);
    const session = this.sessions.get(target);
    if (!department || !session) throw new RouteError(404, `There is no department ${target}. Call list_departments for the ids.`);
    if (!message.trim()) throw new RouteError(400, 'The message is empty.');
    if (message.length > MAX_MESSAGE) throw new RouteError(400, 'The message is too long.');
    const name = `the ${department.name} manager`;
    const cap = `${name[0].toUpperCase()}${name.slice(1)}`;
    // A manager running with approvals off would act on another agent's words with no check by the
    // user, so no manager may ask it anything until the user switches bypass off.
    const bypassed = `${cap} is running with approvals off (bypass), so it does not take questions from other agents. Ask the user to switch bypass off first, or tell the user what you wanted to ask.`;
    if (session.snapshot().state.bypass) throw new RouteError(409, bypassed);
    // A manager that is waiting for an answer cannot answer: asking it would deadlock the chain that waits on it.
    if ([...this.asks].some((ask) => ask.from === target)) {
      throw new RouteError(409, `${cap} is waiting for an answer from another manager, so it cannot be asked now (a request must not loop back). Ask again later, or tell the user.`);
    }
    // How deep this request is: one more than the ask the caller is answering right now, if any.
    const depth = 1 + Math.max(0, ...[...this.asks].filter((ask) => ask.to === from && ask.sent).map((ask) => ask.depth));
    if (depth > MAX_ASK_DEPTH) {
      throw new RouteError(409, `A request can pass through at most ${MAX_ASK_DEPTH} managers, and this one is answering a request that already passed through ${depth - 1}. Do not ask another manager; answer with what you have, or tell the user.`);
    }
    const accepting = department.permission === 'accept-edits';
    if (accepting && message.length > MAX_APPROVED_ASK) {
      throw new RouteError(400, `${cap} accepts edits, so the user must approve this message first, and the approval card shows at most ${MAX_APPROVED_ASK} characters (this one has ${message.length}). Shorten it, or put the details in a report file and ask the manager to read it.`);
    }
    const open: OpenAsk = { from, to: target, depth, sent: false };
    this.asks.add(open);
    if (accepting) {
      // The caller is waiting for the user, so it counts as waiting for an answer (nobody can ask it now).
      let allowed = false;
      try {
        allowed = await this.approveAsk(from, fromName, department.name, message);
      } finally {
        if (!allowed) this.asks.delete(open);
      }
      if (!allowed) {
        throw new RouteError(403, `The user did not allow this question to ${name}, so it was not sent. ${cap} accepts edits, so it only takes questions the user approves. Do not look for another way to reach it; tell the user what you wanted to ask.`);
      }
      // The office may have changed while the card waited.
      if (this.sessions.get(target) !== session || !this.store.byId(target)) {
        this.asks.delete(open);
        throw new RouteError(404, `There is no department ${target} any more. Call list_departments for the ids.`);
      }
      if (session.snapshot().state.bypass) {
        this.asks.delete(open);
        throw new RouteError(409, bypassed);
      }
    }

    return new Promise<AskResult>((resolve) => {
      let sent = false;
      let reply = '';
      // When the asking session ends nobody is waiting any more: release the ask, so the caller can be asked again.
      const callerSession = this.sessions.get(from);
      const callerListener = (event: ServerEvent) => {
        if (event.type === 'session.state' && (event.state.status === 'off' || event.state.status === 'error')) {
          finish({ reply: `(The session of ${fromName} ended before ${name} replied.)`, done: false });
        }
      };
      const finish = (result: AskResult) => {
        clearTimeout(timer);
        session.off('event', listener);
        callerSession?.off('event', callerListener);
        this.asks.delete(open);
        resolve(result);
      };
      const timer = setTimeout(() => {
        const note = sent ? `(${name} is still working on it after ${Math.round(timeoutMs / 60000)} minutes; check office_status or ask again later.)` : `(${name} was busy the whole time, so the message was not sent.)`;
        finish({ reply: reply ? `${reply}\n\n${note}` : note, done: false });
      }, timeoutMs);
      const send = () => {
        sent = true;
        open.sent = true;
        this.apply({ type: 'chat.message', message: { id: `msg_${randomUUID()}`, department: target, role: 'colleague', fromName, text: message, at: new Date().toISOString(), streaming: false } });
        session.send(`${colleaguePrefix(fromName)}\n\n${message}`, { priority: 'later' });
      };
      const listener = (event: ServerEvent) => {
        if (event.type === 'session.state') {
          const { status, error } = event.state;
          if (status === 'off' || status === 'error') finish({ reply: `${reply}${reply ? '\n\n' : ''}(The session of ${name} ended${error ? `: ${error}` : ''}.)`, done: true });
          else if (!sent && event.state.bypass) finish({ reply: `(${bypassed})`, done: false });
          else if (!sent && status === 'ready') send();
        } else if (sent && event.type === 'chat.delta') {
          reply += event.text;
        } else if (sent && event.type === 'turn.result') {
          finish({ reply: reply.trim() || `(${name} finished the turn without a reply.)`, done: true });
        }
      };
      session.on('event', listener);
      callerSession?.on('event', callerListener);
      const { status } = session.snapshot().state;
      if (status === 'ready') send();
      else if (status === 'off' || status === 'error') session.start();
      // Otherwise (starting, busy, waiting) the listener sends once the session is ready.
    });
  }

  /**
   * The approval card of an ask_manager call to a manager that accepts edits. It sits in the asking
   * manager's chat (that manager is the one waiting) and carries the whole message. True when the user
   * allows it; false when the user denies it or the asking session ends (which closes its cards).
   */
  private async approveAsk(from: string, fromName: string, toName: string, message: string): Promise<boolean> {
    const request = this.approvals.create({ department: from, tool: ASK_APPROVAL_TOOL, input: { from: fromName, to: toName, message }, toolUseId: null });
    for (;;) {
      try {
        const result = await this.approvals.wait(request.id, 25_000);
        if (result.status === 'answered') return result.allow;
      } catch {
        return false;
      }
    }
  }

  /** Stops every manager process (server shutdown). */
  async shutdown(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.stop()));
  }

  /**
   * Closes the office (the project closes or switches): stops and disposes every session, so its
   * session.state off events still go out, then drops every listener. The office is not used again.
   */
  async dispose(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((session) => session.dispose()));
    this.removeAllListeners();
  }

  private session(id: string): ManagerSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`There is no department ${id}.`);
    return session;
  }

  private addSession(id: string): ManagerSession {
    const session = this.options.createSession(id);
    session.on('event', (event) => this.apply(event));
    this.sessions.set(id, session);
    return session;
  }

  private chatSend(department: string, text: string): void {
    const session = this.session(department);
    if (!text.trim()) throw new Error('The message is empty.');
    if (text.length > MAX_MESSAGE) throw new Error('The message is too long.');
    const message: ChatMessage = { id: `msg_${randomUUID()}`, department, role: 'user', text, at: new Date().toISOString(), streaming: false };
    this.apply({ type: 'chat.message', message });
    session.send(text);
  }

  private async createDepartment(input: DepartmentInput): Promise<void> {
    const errors = this.store.validateInput(input);
    if (errors.length) throw new Error(errors.join(' '));
    const name = input.name.trim();
    const board = await this.options.createBoard(name);
    if (board.error) this.log(`Trella board for ${name} not created: ${board.error}`);
    const department = this.store.create(input, board.boardId);
    const session = this.addSession(department.id);
    this.apply({ type: 'department.created', department });
    const snapshot = session.snapshot();
    this.apply({ type: 'session.state', state: snapshot.state });
    for (const agent of snapshot.agents) this.apply({ type: 'agent.upsert', agent });
    // After department.created: the form waits for that event and takes an error before it for a failed create.
    if (board.error) this.apply({ type: 'error', department: null, message: `The Trella board for ${name} was not created: ${board.error}` });
  }

  private updateDepartment(id: string, patch: DepartmentPatch): void {
    const department = this.store.update(id, patch);
    this.apply({ type: 'department.updated', department });
    this.sessions.get(id)?.refresh();
  }

  private async removeDepartment(id: string): Promise<void> {
    if (this.store.byId(id)?.kind === 'lobby') throw new Error('The general manager cannot be removed.');
    const session = this.session(id);
    await session.dispose();
    this.sessions.delete(id);
    this.approvals.closeDepartment(id);
    this.store.remove(id);
    this.apply({ type: 'department.removed', id });
  }

  private apply(event: ServerEvent): void {
    this.live = reduce(this.live, event);
    switch (event.type) {
      case 'chat.message':
        this.store.appendChat(event.message);
        break;
      case 'chat.done': {
        const message = this.live.messages.find((m) => m.id === event.messageId);
        if (message) this.store.appendChat(message);
        break;
      }
      case 'session.state': {
        const { department, sessionId } = event.state;
        if (this.store.byId(department)) this.store.setSessionId(department, sessionId);
        break;
      }
      case 'error':
        this.log(`error${event.department ? ` in ${event.department}` : ''}: ${event.message}`);
        break;
    }
    this.emit('event', event);
    // After the broadcast, so clients see the session end before its cards close.
    if (event.type === 'session.state' && (event.state.status === 'off' || event.state.status === 'error')) {
      this.approvals.closeDepartment(event.state.department);
    }
  }
}

function field(body: unknown, key: string): unknown {
  return isRecord(body) ? body[key] : undefined;
}

/**
 * The HTTP side of the office tools every manager has (served by the office MCP server). `office`
 * returns the open project's office, or throws a RouteError while none is open. All three are agent routes
 * (server/auth.ts): the caller of ask is the department of the agent token, never a field of the body.
 */
export function registerOfficeToolRoutes(router: HttpRouter, office: () => Office): void {
  router.get('/api/office/departments', () => office().listDepartments(), { agent: true });
  router.get('/api/office/status', () => office().status(), { agent: true });
  router.post(
    '/api/office/ask',
    ({ body, caller }) => {
      const department = field(body, 'department');
      const message = field(body, 'message');
      if (typeof department !== 'string' || typeof message !== 'string') throw new RouteError(400, 'department and message are required.');
      if (!caller) throw new RouteError(403, 'The caller is not known.');
      return office().askManager(department, message, ASK_TIMEOUT_MS, caller);
    },
    { agent: true },
  );
}
