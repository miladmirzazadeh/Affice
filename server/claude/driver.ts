// The manager sessions: one Claude Code process per department, driven over stream-json.
//
// `ManagerSession` is the seam the rest of the server uses. `CliManagerSession` implements it with the
// `claude` CLI (the documented path for the user's own subscription login). `SessionMapper` turns
// the stream-json messages into ServerEvents; it holds no process, so an Agent SDK implementation
// (whose messages have the same shapes) can reuse it, and the tests drive it from a recorded fixture.
// The appended prompt and the MCP servers of a manager come from the protocol seam (server/protocol).

import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { createInterface } from 'node:readline';
import type { OfficeLayout } from '../../shared/server-api';
import type { AgentPresence, AgentStatus, Department, ServerEvent, SessionState, SessionStatus } from '../../shared/types';
import { plainLine } from '../../shared/plain-line';
import { isModelId, isSessionId, parseCardKey } from '../../shared/types';
import { knowledgeSources, managerMcpServers, managerPrompt, type McpRuntime } from '../protocol/index';
import { visible } from './approval-card';

// ------------------------------------------------------------------------------------- the interface

export interface ManagerSession {
  readonly department: string;
  /** Starts the process if it is not running. */
  start(): void;
  /** Sends a message, starting the process first when needed. `priority: 'later'` queues it for its own turn. */
  send(text: string, options?: SendOptions): void;
  /** Ends the running turn; the session stays open. */
  interrupt(): void;
  /** Closes stdin, waits, then SIGTERM. Resolves when the process is gone. */
  stop(): Promise<void>;
  /**
   * Restarts the process (with --resume) with every permission check skipped, or back to the department's
   * policy. Starts the session when it is off and `on` is true. Throws while a turn runs and `on` is true.
   */
  setBypass(on: boolean): Promise<void>;
  on(event: 'event', listener: (event: ServerEvent) => void): this;
  off(event: 'event', listener: (event: ServerEvent) => void): this;
  /** The session state and the agents this session owns (the manager always, subagents while shown). */
  snapshot(): { state: SessionState; agents: AgentPresence[] };
  /** The department's name or model changed: refresh the manager presence. */
  refresh(): void;
  /** A permission request for one of this session's agents opened or closed. */
  setWaiting(agentId: string, waiting: boolean): void;
  /** The agent that issued a tool call (for approval cards); the manager when unknown. */
  ownerOf(toolUseId: string | null): string;
  /** Stops the process and drops every timer; the session is not used again. */
  dispose(): Promise<void>;
}

export interface SendOptions {
  /** The stream-json user message priority (Claude Code 2.1.287 accepts now, next, later). */
  priority?: 'now' | 'next' | 'later';
}

// ---------------------------------------------------------------------------------- the command line

export const PERMISSION_PROMPT_TOOL = 'mcp__office__approve';
/**
 * Pre-approved in every policy: subagents and Trella's board tools. Reading files is pre-approved only
 * inside the project and the department's knowledge folders (readRules), and the web tools are in no
 * list: WebFetch and WebSearch always go to an approval card (`ask`, `accept-edits`) or are refused
 * (`read-only`), because a manager that reads a hostile file could otherwise send what it reads out.
 */
export const READ_ONLY_TOOLS = 'Agent,Task,mcp__trella__*';
/** In `ask` and `accept-edits` these pass without an approval card; writes, Bash, the web and the rest still reach the user. */
export const PRE_APPROVED_TOOLS = 'Agent,Task,TodoWrite,mcp__trella__*';
/** The tools that can carry text out of the machine. Never pre-approved; not offered to a `read-only` manager. */
export const WEB_TOOLS = ['WebFetch', 'WebSearch'];
/** --forward-subagent-text appeared in Claude Code 2.1.211. */
export const FORWARD_SUBAGENT_TEXT_SINCE = '2.1.211';
/**
 * The office tools every manager has, served by the same MCP server as `approve` and pre-approved in every
 * policy. `ask_manager` is pre-approved as a tool, and the office itself asks the user first when the manager
 * it reaches runs with `accept-edits` (Office.askManager).
 */
export const OFFICE_TOOLS = ['mcp__office__list_departments', 'mcp__office__office_status', 'mcp__office__ask_manager'];

export interface CommandOptions extends McpRuntime {
  /** The open project's office: the prompts and MCP servers come from the protocol seam with it, and TRELLA_PROJECT is its Trella workspace. */
  layout: OfficeLayout;
  /** Pass --forward-subagent-text (the installed CLI supports it). */
  forwardSubagentText: boolean;
  /** The company name for the prompts, read at every start; the protocol's default when absent or empty. */
  company?: () => string | null | undefined;
}

/** The --mcp-config of a manager: the servers of the protocol seam (server/protocol). */
export function approvalsMcpConfig(department: Pick<Department, 'id' | 'kind' | 'name'>, options: CommandOptions): string {
  return JSON.stringify({ mcpServers: managerMcpServers(options.layout, department, options) });
}

/**
 * One `Read(...)` allow rule for a folder, in Claude Code's permission rule syntax: the `//` prefix is
 * an absolute path, `/**` is everything below it, and the gitignore characters of the path are escaped.
 * Null when the path cannot be written safely (not absolute, a comma, which separates the rules in
 * --allowedTools, or a control character): then no rule exists and reads there go to an approval card.
 */
export function readRule(folder: string): string | null {
  if (!folder.startsWith('/') || /[,\u0000-\u001f\u007f]/.test(folder)) return null;
  const path = folder.replace(/\/+$/, '').replace(/[\\*?[\]]/g, '\\$&');
  return `Read(/${path}/**)`;
}

/**
 * The only folders whose files a manager reads without an approval card: the project (with its Office
 * folder) and the department's knowledge folders. Claude Code itself also lets a manager read its own
 * working directory and the folders passed with --add-dir (the same knowledge folders). Grep and Glob follow
 * the Read rules. A folder that is a symlink gets a rule for where it leads too, because an allow rule
 * applies only when the path asked for and the file it resolves to both match.
 */
export function readRules(layout: OfficeLayout, department: Pick<Department, 'kind' | 'knowledgeDirs'>): string[] {
  const folders = [layout.project, layout.officeDir, ...knowledgeSources(layout, department).dirs];
  const rules = new Set<string>();
  for (const folder of folders) {
    for (const spelling of [folder, realFolder(folder)]) {
      const rule = readRule(spelling);
      if (rule) rules.add(rule);
    }
  }
  return [...rules];
}

function realFolder(folder: string): string {
  try {
    return realpathSync(folder);
  } catch {
    return folder;
  }
}

export function permissionArgs(
  department: Pick<Department, 'id' | 'kind' | 'name' | 'permission' | 'knowledgeDirs'>,
  options: CommandOptions,
  bypass = false,
): string[] {
  // Every manager gets the trella and office servers, in every policy (the user's own servers stay: no strict flag).
  const mcp = ['--mcp-config', approvalsMcpConfig(department, options)];
  const approvals = [...mcp, '--permission-prompt-tool', PERMISSION_PROMPT_TOOL];
  // The office tools pass without approval in every policy, and so do reads inside the project and the knowledge folders.
  const allowed = (tools: string) => [tools, ...OFFICE_TOOLS, ...readRules(options.layout, department)].join(',');
  // session.bypass: every check skipped, so no prompt tool and no allowed list; the servers stay served.
  if (bypass) return ['--permission-mode', 'bypassPermissions', ...mcp];
  // WebFetch and WebSearch are in no allowed list. Claude Code lets WebFetch read a built-in set of
  // documentation sites without asking, so an ask rule makes those ask too.
  const webAsks = ['--settings', JSON.stringify({ permissions: { ask: WEB_TOOLS } })];
  switch (department.permission) {
    case 'read-only':
      // dontAsk refuses everything that would ask; the web tools are also removed, so a read-only manager cannot browse.
      return ['--permission-mode', 'dontAsk', '--allowedTools', allowed(READ_ONLY_TOOLS), '--disallowedTools', WEB_TOOLS.join(','), ...mcp];
    case 'accept-edits':
      return ['--permission-mode', 'acceptEdits', '--allowedTools', allowed(PRE_APPROVED_TOOLS), ...webAsks, ...approvals];
    case 'ask':
    default:
      // Explicit, so a defaultMode in the user's settings never decides it.
      return ['--permission-mode', 'default', '--allowedTools', allowed(PRE_APPROVED_TOOLS), ...webAsks, ...approvals];
  }
}

/**
 * The command line of a manager's `claude`. Every flag and its value are separate argv entries (nothing is
 * joined into one string, and no shell is involved). The model and the session id are checked here too, so
 * the argv does not depend on what the office store checked: a value that starts with a hyphen could be read
 * as another option, and `--resume` takes its value as an optional one, so a session id that is not a plain
 * id is left out (the manager then starts a new conversation) and a model that is not a model id stops the start.
 */
export function buildArgs(department: Department, options: CommandOptions, run: { bypass?: boolean } = {}): string[] {
  const general = department.kind === 'lobby';
  if (!isModelId(department.model)) {
    throw new Error(`The model of ${department.name} is not a model id (opus, sonnet, haiku, or a claude-... id). Choose one in the department's settings.`);
  }
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model', department.model,
    '--name', general ? department.name : `${department.name} manager`,
    '--append-system-prompt', managerPrompt(options.layout, department, options.company?.()),
  ];
  // The knowledge folders that exist (the general manager's default: the Office folder), one --add-dir each.
  for (const dir of knowledgeSources(options.layout, department).dirs) args.push('--add-dir', dir);
  if (options.forwardSubagentText) args.push('--forward-subagent-text');
  if (isSessionId(department.sessionId)) args.push('--resume', department.sessionId);
  args.push(...permissionArgs(department, options, run.bypass === true));
  return args;
}

/**
 * The child's environment: the server's, without anything that would change how Claude Code signs in
 * or make it act as a child of another Claude Code session (when the server itself runs inside one).
 * The user's subscription login is then the only credential, and settings files still apply.
 * TRELLA_PROJECT is the folder that holds the office's .agentboard (OfficeLayout.trellaWorkspace).
 */
export function childEnv(base: NodeJS.ProcessEnv, trellaWorkspace: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (key !== 'CLAUDE_CONFIG_DIR' && /^(CLAUDE|ANTHROPIC|MCP_)/.test(key)) continue;
    env[key] = value;
  }
  env.TRELLA_PROJECT = trellaWorkspace;
  return env;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** `claude --version`, for example "2.1.287"; null when the CLI does not answer. */
export function detectCliVersion(claudeBin = 'claude', root = process.cwd()): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(claudeBin, ['--version'], { timeout: 15_000, env: childEnv(process.env, root) }, (error, stdout) => {
      const match = /(\d+\.\d+\.\d+)/.exec(String(stdout));
      resolve(error || !match ? null : match[1]);
    });
  });
}

// ------------------------------------------------------------------------------------------ summaries

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * The line the speech bubble and the agent row show for what an agent said: its markdown without the markers
 * (**bold**, `code`, # headings, list dashes; the chat renders them, a one line label cannot), then clipped.
 */
export function sayLine(text: string, max: number): string {
  return clip(plainLine(text), max);
}

/**
 * One line a person can read: "Edit src/config/settings.py", "Run git status", "Claim task ENG-11". It is a
 * label, not the request: an approval card also shows the whole command or edit (server/claude/approval-card.ts).
 */
export function summarizeTool(name: string, input: unknown, cwd: string | null): string {
  const fields = isRecord(input) ? input : {};
  const path = str(fields.file_path) ?? str(fields.notebook_path) ?? str(fields.path);
  let label = name;
  let detail: string | null;
  if (name === 'Bash') {
    label = 'Run';
    // The first line only, and it says when there are more: a card must not read as a one line command.
    const lines = str(fields.command)?.trim().split('\n') ?? [];
    detail = lines.length ? `${clip(lines[0], 70)}${lines.length > 1 ? ` (+${lines.length - 1} more line${lines.length > 2 ? 's' : ''})` : ''}` : null;
  } else if (name === 'Agent' || name === 'Task') {
    label = 'Delegate';
    detail = str(fields.description);
  } else if (path) {
    detail = cwd && isAbsolute(path) && !relative(cwd, path).startsWith('..') ? relative(cwd, path) || path : path;
  } else {
    detail = str(fields.url) ?? str(fields.query) ?? str(fields.pattern) ?? str(fields.task_id) ?? str(fields.title) ?? str(fields.description) ?? str(fields.department);
  }
  if (name.startsWith('mcp__')) {
    const tool = name.split('__').slice(2).join(' ').replace(/_/g, ' ');
    label = tool ? tool.charAt(0).toUpperCase() + tool.slice(1) : name;
  }
  return visible(clip(detail ? `${label} ${detail}` : label, 100));
}

const MODEL_ALIASES: Record<string, string> = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  fable: 'claude-fable-5-1',
};

// ------------------------------------------------------------------------------------------ the mapper

export interface MapperDepartment {
  id: string;
  kind?: Department['kind'];
  name: string;
  cwd: string;
  model: string;
}

/** "Development manager"; the lobby's general manager is called by its own name. */
export function managerTitle(department: Pick<MapperDepartment, 'kind' | 'name'>): string {
  return department.kind === 'lobby' ? department.name : `${department.name} manager`;
}

export interface MapperOptions {
  now?: () => string;
  newId?: () => string;
}

const ACTIVE: AgentStatus[] = ['arriving', 'working', 'waiting', 'thinking'];
const SAME_KEYS: (keyof AgentPresence)[] = ['title', 'cardKey', 'model', 'status', 'currentTool', 'lastText', 'startedAt', 'endedAt', 'parentToolUseId'];

function samePresence(a: AgentPresence, b: AgentPresence): boolean {
  return SAME_KEYS.every((key) => a[key] === b[key]);
}

/**
 * The state machine of one department's session. Feed it the CLI's stdout lines and the lifecycle
 * calls (starting, spawned, sent, exited, setWaiting); each call returns the ServerEvents to broadcast.
 */
export class SessionMapper {
  readonly managerId: string;
  private department: MapperDepartment;
  private state: SessionState;
  private manager: AgentPresence;
  private readonly subagents = new Map<string, AgentPresence>();
  /** The Agent tool_use id that spawned a subagent, to its task_id. */
  private readonly byParent = new Map<string, string>();
  /** Every tool call seen and not finished: its name and the agent that made it. */
  private readonly tools = new Map<string, { name: string; agentId: string }>();
  /** Agent tool inputs (model, prompt), read when task_started arrives. */
  private readonly agentInputs = new Map<string, Json>();
  private readonly running = new Map<string, Set<string>>();
  private readonly waiting = new Set<string>();
  private alive = false;
  private spawnedOk = false;
  private initSeen = false;
  private turnActive = false;
  private chatId: string | null = null;
  private chatText = '';
  private segment = '';
  private separatorPending = false;
  private currentMessageId: string | null = null;
  /** API message ids whose text already arrived as stream_event deltas. */
  private readonly streamed = new Set<string>();
  /**
   * The conversation's running total_cost_usd at the last result (results report the running total, and
   * a resumed run starts from the earlier runs' total). Null when unknown: a resume after a restart.
   */
  private costTotal: number | null = null;
  private readonly now: () => string;
  private readonly newId: () => string;

  constructor(department: MapperDepartment, sessionId: string | null, options: MapperOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? (() => `msg_${randomUUID()}`);
    this.department = department;
    this.managerId = `manager:${department.id}`;
    this.state = { department: department.id, status: 'off', bypass: false, sessionId, model: null, startedAt: null, error: null };
    this.manager = {
      id: this.managerId,
      department: department.id,
      kind: 'manager',
      title: managerTitle(department),
      cardKey: null,
      model: department.model,
      status: 'idle',
      currentTool: null,
      lastText: null,
      startedAt: this.now(),
      endedAt: null,
      parentToolUseId: null,
    };
  }

  sessionState(): SessionState {
    return { ...this.state };
  }

  agents(): AgentPresence[] {
    return [{ ...this.manager }, ...[...this.subagents.values()].map((agent) => ({ ...agent }))];
  }

  /** True after system/init in the current process (a failed --resume never gets there). */
  get initialized(): boolean {
    return this.initSeen;
  }

  ownerOf(toolUseId: string | null): string {
    return (toolUseId && this.tools.get(toolUseId)?.agentId) || this.managerId;
  }

  updateDepartment(department: MapperDepartment): ServerEvent[] {
    this.department = department;
    return this.patchManager({ title: managerTitle(department), model: this.alive ? this.manager.model : department.model });
  }

  // Lifecycle -----------------------------------------------------------------------------------

  /** `bypass`: this run skips every permission check (session.bypass). Every other start is false. */
  starting(sessionId: string | null, bypass = false): ServerEvent[] {
    this.alive = true;
    this.spawnedOk = false;
    this.initSeen = false;
    this.turnActive = false;
    this.tools.clear();
    this.agentInputs.clear();
    this.running.clear();
    this.waiting.clear();
    this.resetChat();
    // A fresh conversation counts from zero; a resumed one from what this server last saw of it.
    if (sessionId === null || sessionId !== this.state.sessionId) this.costTotal = sessionId === null ? 0 : null;
    this.state = { ...this.state, bypass, sessionId, model: this.department.model, startedAt: this.now(), error: null };
    return [
      ...this.patchManager({ model: this.department.model, startedAt: this.state.startedAt ?? this.now(), currentTool: null, endedAt: null }),
      ...this.syncSession(true),
    ];
  }

  spawned(): ServerEvent[] {
    this.spawnedOk = true;
    return this.syncSession();
  }

  sent(): ServerEvent[] {
    return this.beginTurn();
  }

  exited(error: string | null, options: { forgetSession?: boolean } = {}): ServerEvent[] {
    const out = this.closeChat();
    this.alive = false;
    this.spawnedOk = false;
    this.turnActive = false;
    this.tools.clear();
    this.running.clear();
    this.waiting.clear();
    for (const agent of [...this.subagents.values()]) {
      if (ACTIVE.includes(agent.status)) {
        out.push(...this.patchSubagent(agent.id, { status: 'failed', currentTool: null, lastText: 'The session ended.', endedAt: this.now() }));
      }
    }
    // Bypass never outlives its process: a stop, a crash or a switch turns it off.
    this.state = { ...this.state, error, bypass: false, sessionId: options.forgetSession ? null : this.state.sessionId };
    out.push(...this.patchManager({ currentTool: null }), ...this.syncSession(true));
    return out;
  }

  setWaiting(agentId: string, on: boolean): ServerEvent[] {
    if (on) this.waiting.add(agentId);
    else this.waiting.delete(agentId);
    const out = agentId === this.managerId ? this.syncManager() : this.patchSubagent(agentId, {});
    return [...out, ...this.syncSession()];
  }

  /** Drops a finished subagent (two minutes after done or failed). */
  forget(agentId: string): ServerEvent[] {
    if (!this.subagents.delete(agentId)) return [];
    for (const [parent, taskId] of this.byParent) if (taskId === agentId) this.byParent.delete(parent);
    return [{ type: 'agent.removed', id: agentId }];
  }

  // stream-json ---------------------------------------------------------------------------------

  /** One line of the CLI's stdout. Lines that are not JSON objects are ignored. */
  line(raw: string): ServerEvent[] {
    const text = raw.trim();
    if (!text.startsWith('{')) return [];
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return [];
    }
    return isRecord(message) ? this.message(message) : [];
  }

  message(m: Json): ServerEvent[] {
    switch (m.type) {
      case 'system':
        return this.system(m);
      case 'stream_event':
        return this.streamEvent(m);
      case 'assistant':
        return this.assistant(m);
      case 'user':
        return this.user(m);
      case 'result':
        return this.result(m);
      default:
        return [];
    }
  }

  private system(m: Json): ServerEvent[] {
    switch (m.subtype) {
      case 'init': {
        // Emitted at the start of every turn; only a new session id or model is news.
        this.initSeen = true;
        this.spawnedOk = true;
        const sessionId = str(m.session_id) ?? this.state.sessionId;
        const model = str(m.model) ?? this.state.model;
        const changed = sessionId !== this.state.sessionId || model !== this.state.model;
        this.state = { ...this.state, sessionId, model };
        return [...this.syncSession(changed), ...(model ? this.patchManager({ model }) : [])];
      }
      case 'task_started':
        return this.taskStarted(m);
      case 'task_progress': {
        const id = str(m.task_id);
        const agent = id ? this.subagents.get(id) : undefined;
        if (!agent || !ACTIVE.includes(agent.status)) return [];
        const patch: Partial<AgentPresence> = { status: 'working' };
        const tool = str(m.last_tool_name);
        if (tool) patch.currentTool = tool;
        const summary = str(m.summary);
        if (summary) patch.lastText = sayLine(summary, 120);
        return this.patchSubagent(agent.id, patch);
      }
      case 'task_notification': {
        const id = str(m.task_id);
        const agent = id ? this.subagents.get(id) : undefined;
        if (!agent) return [];
        this.running.delete(agent.id);
        this.waiting.delete(agent.id);
        const summary = str(m.summary);
        return [
          ...this.patchSubagent(agent.id, {
            status: m.status === 'completed' ? 'done' : 'failed',
            currentTool: null,
            lastText: summary ? sayLine(summary, 120) : agent.lastText,
            endedAt: this.now(),
          }),
          ...this.syncSession(),
        ];
      }
      default:
        return [];
    }
  }

  private taskStarted(m: Json): ServerEvent[] {
    const taskId = str(m.task_id);
    if (!taskId || m.ambient === true) return [];
    const toolUseId = str(m.tool_use_id);
    const input = toolUseId ? this.agentInputs.get(toolUseId) : undefined;
    const taskType = str(m.task_type);
    // Only subagents get a desk: not background shell commands, monitors or Claude Code's own work.
    if (taskType ? taskType !== 'local_agent' && taskType !== 'remote_agent' : !input) return [];
    const description = str(m.description) ?? str(input?.description) ?? 'Subagent';
    const prompt = str(m.prompt) ?? str(input?.prompt);
    const requested = str(input?.model);
    const agent: AgentPresence = {
      id: taskId,
      department: this.department.id,
      kind: 'subagent',
      title: description,
      cardKey: parseCardKey(description) ?? parseCardKey(prompt),
      model: requested ? (requested === 'inherit' ? this.manager.model : MODEL_ALIASES[requested] ?? requested) : null,
      status: 'arriving',
      currentTool: null,
      lastText: null,
      startedAt: this.now(),
      endedAt: null,
      parentToolUseId: toolUseId,
    };
    this.subagents.set(taskId, agent);
    if (toolUseId) this.byParent.set(toolUseId, taskId);
    return [{ type: 'agent.upsert', agent: { ...agent } }, ...this.syncManager()];
  }

  private streamEvent(m: Json): ServerEvent[] {
    if (m.parent_tool_use_id) return []; // partial messages exist for the main thread only
    const event = isRecord(m.event) ? m.event : null;
    if (!event) return [];
    switch (event.type) {
      case 'message_start':
        this.currentMessageId = isRecord(event.message) ? str(event.message.id) : null;
        return this.beginTurn();
      case 'content_block_start':
        if (isRecord(event.content_block) && event.content_block.type === 'text') {
          this.segment = '';
          this.separatorPending = this.chatText.length > 0;
        }
        return [];
      case 'content_block_delta': {
        const delta = isRecord(event.delta) ? event.delta : null;
        if (delta?.type !== 'text_delta' || typeof delta.text !== 'string' || delta.text === '') return [];
        if (this.currentMessageId) this.streamed.add(this.currentMessageId);
        return this.appendChat(delta.text);
      }
      case 'content_block_stop':
        return this.endSegment();
      default:
        return [];
    }
  }

  private assistant(m: Json): ServerEvent[] {
    const message = isRecord(m.message) ? m.message : null;
    if (!message) return [];
    const content = Array.isArray(message.content) ? message.content.filter(isRecord) : [];
    const parent = str(m.parent_tool_use_id);
    if (parent) return this.subagentAssistant(parent, message, content);

    const out = this.beginTurn();
    const messageId = str(message.id);
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
        // Without partial messages (or when a delta was lost) the full text arrives only here.
        if (messageId && this.streamed.has(messageId)) continue;
        this.segment = '';
        this.separatorPending = this.chatText.length > 0;
        out.push(...this.appendChat(block.text), ...this.endSegment());
      } else if (block.type === 'tool_use') {
        out.push(...this.toolStarted(this.managerId, block));
      }
    }
    return out;
  }

  private subagentAssistant(parent: string, message: Json, content: Json[]): ServerEvent[] {
    const agentId = this.byParent.get(parent);
    const agent = agentId ? this.subagents.get(agentId) : undefined;
    if (!agent || !ACTIVE.includes(agent.status)) return [];
    const out: ServerEvent[] = [];
    const patch: Partial<AgentPresence> = { status: 'working' };
    const model = str(message.model);
    if (model && !model.startsWith('<')) patch.model = model;
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) patch.lastText = sayLine(block.text, 120);
      else if (block.type === 'tool_use') out.push(...this.toolStarted(agent.id, block));
    }
    return [...out, ...this.patchSubagent(agent.id, patch)];
  }

  private user(m: Json): ServerEvent[] {
    const message = isRecord(m.message) ? m.message : null;
    const content = message && Array.isArray(message.content) ? message.content.filter(isRecord) : [];
    const out: ServerEvent[] = [];
    for (const block of content) {
      if (block.type !== 'tool_result') continue;
      const id = str(block.tool_use_id);
      const tool = id ? this.tools.get(id) : undefined;
      if (!id || !tool) continue;
      this.tools.delete(id);
      this.running.get(tool.agentId)?.delete(id);
      out.push({ type: 'tool.finished', department: this.department.id, agentId: tool.agentId, toolUseId: id, ok: block.is_error !== true });
      const currentTool = this.runningToolName(tool.agentId);
      out.push(...(tool.agentId === this.managerId ? this.patchManager({ currentTool }) : this.patchSubagent(tool.agentId, { currentTool })));
    }
    return out;
  }

  private result(m: Json): ServerEvent[] {
    const out = this.closeChat();
    const total = num(m.total_cost_usd);
    const costUsd = total === null || this.costTotal === null ? null : Math.max(0, total - this.costTotal);
    if (total !== null) this.costTotal = total;
    out.push({
      type: 'turn.result',
      department: this.department.id,
      costUsd,
      turns: num(m.num_turns),
      durationMs: num(m.duration_ms),
    });
    // An interrupt ends the turn with error_during_execution and terminal_reason aborted_*: not an error.
    const interrupted = typeof m.terminal_reason === 'string' && m.terminal_reason.startsWith('aborted');
    if (!interrupted && (m.is_error === true || (typeof m.subtype === 'string' && m.subtype !== 'success'))) {
      const errors = Array.isArray(m.errors) ? m.errors.filter((e): e is string => typeof e === 'string') : [];
      out.push({
        type: 'error',
        department: this.department.id,
        message: str(m.result) ?? (errors.join('; ') || `The turn ended with ${String(m.subtype)}.`),
      });
    }
    this.turnActive = false;
    // The manager's own tools belong to the finished turn; background subagents keep theirs.
    for (const id of this.running.get(this.managerId) ?? []) this.tools.delete(id);
    this.running.delete(this.managerId);
    out.push(...this.patchManager({ currentTool: null }), ...this.syncSession());
    return out;
  }

  // Helpers ---------------------------------------------------------------------------------------

  private toolStarted(agentId: string, block: Json): ServerEvent[] {
    const id = str(block.id);
    if (!id || this.tools.has(id)) return [];
    const name = str(block.name) ?? 'tool';
    const input = isRecord(block.input) ? block.input : {};
    this.tools.set(id, { name, agentId });
    if (name === 'Agent' || name === 'Task') this.agentInputs.set(id, input);
    let set = this.running.get(agentId);
    if (!set) this.running.set(agentId, (set = new Set()));
    set.add(id);
    const event: ServerEvent = {
      type: 'tool.started',
      department: this.department.id,
      agentId,
      toolUseId: id,
      name,
      summary: summarizeTool(name, input, this.department.cwd),
    };
    const patch = agentId === this.managerId ? this.patchManager({ currentTool: name }) : this.patchSubagent(agentId, { currentTool: name, status: 'working' });
    return [event, ...patch];
  }

  private runningToolName(agentId: string): string | null {
    const ids = [...(this.running.get(agentId) ?? [])];
    const last = ids.length ? this.tools.get(ids[ids.length - 1]) : undefined;
    return last?.name ?? null;
  }

  private beginTurn(): ServerEvent[] {
    if (this.turnActive) return [];
    this.turnActive = true;
    return [...this.syncManager(), ...this.syncSession()];
  }

  private appendChat(text: string): ServerEvent[] {
    const out = this.beginTurn();
    if (!this.chatId) this.chatId = this.newId();
    const piece = this.separatorPending ? `\n\n${text}` : text;
    this.separatorPending = false;
    this.chatText += piece;
    this.segment += text;
    out.push({ type: 'chat.delta', department: this.department.id, messageId: this.chatId, text: piece });
    return out;
  }

  private endSegment(): ServerEvent[] {
    if (!this.segment.trim()) return [];
    const lastText = sayLine(this.segment, 120);
    this.segment = '';
    return this.patchManager({ lastText });
  }

  private closeChat(): ServerEvent[] {
    const out: ServerEvent[] = [...this.endSegment()];
    if (this.chatId) out.push({ type: 'chat.done', department: this.department.id, messageId: this.chatId });
    this.resetChat();
    return out;
  }

  private resetChat(): void {
    this.chatId = null;
    this.chatText = '';
    this.segment = '';
    this.separatorPending = false;
    this.currentMessageId = null;
    this.streamed.clear();
  }

  private managerStatus(): AgentStatus {
    if (this.waiting.has(this.managerId)) return 'waiting';
    if (!this.turnActive) return 'idle';
    const ownTools = this.running.get(this.managerId)?.size ?? 0;
    const busySubagent = [...this.subagents.values()].some((agent) => ACTIVE.includes(agent.status));
    return ownTools > 0 || busySubagent ? 'working' : 'thinking';
  }

  private patchManager(patch: Partial<AgentPresence>): ServerEvent[] {
    const next: AgentPresence = { ...this.manager, ...patch };
    next.status = this.managerStatus();
    if (samePresence(next, this.manager)) return [];
    this.manager = next;
    return [{ type: 'agent.upsert', agent: { ...next } }];
  }

  private syncManager(): ServerEvent[] {
    return this.patchManager({});
  }

  private patchSubagent(id: string, patch: Partial<AgentPresence>): ServerEvent[] {
    const agent = this.subagents.get(id);
    if (!agent) return [];
    const next: AgentPresence = { ...agent, ...patch };
    if (next.status !== 'done' && next.status !== 'failed') {
      if (this.waiting.has(id)) next.status = 'waiting';
      else if (next.status === 'waiting') next.status = 'working';
    }
    if (samePresence(next, agent)) return [];
    this.subagents.set(id, next);
    return [{ type: 'agent.upsert', agent: { ...next } }, ...this.syncManager()];
  }

  private sessionStatus(): SessionStatus {
    if (!this.alive) return this.state.error ? 'error' : 'off';
    if (!this.spawnedOk) return 'starting';
    if (this.waiting.size > 0) return 'waiting';
    return this.turnActive ? 'busy' : 'ready';
  }

  private syncSession(force = false): ServerEvent[] {
    const status = this.sessionStatus();
    if (!force && status === this.state.status) return [];
    this.state = { ...this.state, status };
    return [{ type: 'session.state', state: { ...this.state } }];
  }
}

// ------------------------------------------------------------------------------------ the CLI process

export interface CliDriverOptions extends CommandOptions {
  claudeBin?: string;
  /** How long a done or failed subagent stays at its desk. */
  removeAfterMs?: number;
  /** How long stop waits after closing stdin before SIGTERM. */
  stopGraceMs?: number;
  /** Every raw stdout line, for recording fixtures. */
  onRawLine?: (department: string, line: string) => void;
  /** stderr lines, for the server log. */
  onStderr?: (department: string, line: string) => void;
}

export function mapperDepartment(department: Department): MapperDepartment {
  return { id: department.id, kind: department.kind, name: department.name, cwd: department.cwd, model: department.model };
}

export class CliManagerSession extends EventEmitter implements ManagerSession {
  readonly department: string;
  private readonly mapper: SessionMapper;
  private child: ChildProcessWithoutNullStreams | null = null;
  private stopping = false;
  private resumed = false;
  private lastStderr = '';
  private disposed = false;
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    department: Department,
    private readonly lookup: () => Department | null,
    private readonly options: CliDriverOptions,
  ) {
    super();
    this.department = department.id;
    this.mapper = new SessionMapper(mapperDepartment(department), department.sessionId);
  }

  snapshot(): { state: SessionState; agents: AgentPresence[] } {
    return { state: this.mapper.sessionState(), agents: this.mapper.agents() };
  }

  refresh(): void {
    const department = this.lookup();
    if (department) this.publish(this.mapper.updateDepartment(mapperDepartment(department)));
  }

  setWaiting(agentId: string, waiting: boolean): void {
    this.publish(this.mapper.setWaiting(agentId, waiting));
  }

  ownerOf(toolUseId: string | null): string {
    return this.mapper.ownerOf(toolUseId);
  }

  start(): void {
    this.launch(false);
  }

  async setBypass(on: boolean): Promise<void> {
    const { status, bypass } = this.mapper.sessionState();
    if (on && (status === 'busy' || status === 'waiting')) throw new Error('Wait for the manager to finish, or interrupt it, then switch.');
    if (!this.child) {
      if (on) this.launch(true);
      return;
    }
    if (bypass === on) return;
    // Stopping ends the old process, which closes its approval cards (session off); the new one resumes.
    await this.stop();
    this.launch(on);
  }

  private launch(bypass: boolean): void {
    if (this.child || this.disposed) return;
    const department = this.lookup();
    if (!department) {
      this.publish([{ type: 'error', department: this.department, message: 'This department no longer exists.' }]);
      return;
    }
    this.publish(this.mapper.updateDepartment(mapperDepartment(department)));
    this.stopping = false;
    this.resumed = department.sessionId !== null;
    this.lastStderr = '';
    this.publish(this.mapper.starting(department.sessionId, bypass));

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.options.claudeBin ?? 'claude', buildArgs(department, this.options, { bypass }), {
        cwd: department.cwd,
        env: childEnv(process.env, this.options.layout.trellaWorkspace),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.publish(this.mapper.exited(`Could not start Claude Code: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    this.child = child;
    let finished = false;
    const finish = (error: string | null) => {
      if (finished) return;
      finished = true;
      if (this.child === child) this.child = null;
      // A --resume that never reached system/init failed to open the session: start fresh next time. Not
      // after a bypass start: the CLI refusing the mode says nothing about the conversation.
      const forgetSession = this.resumed && !bypass && !this.mapper.initialized && error !== null;
      this.publish(this.mapper.exited(error, { forgetSession }));
    };

    child.once('spawn', () => this.publish(this.mapper.spawned()));
    child.once('error', (error) => {
      // Only a failed spawn ends the session here; other errors are followed by 'close'.
      if (child.pid === undefined) finish(`Could not start Claude Code: ${error.message}`);
    });
    child.stdin.on('error', () => undefined); // EPIPE after the process died; 'close' reports it
    createInterface({ input: child.stdout }).on('line', (line) => {
      this.options.onRawLine?.(this.department, line);
      this.publish(this.mapper.line(line));
    });
    createInterface({ input: child.stderr }).on('line', (line) => {
      if (line.trim()) this.lastStderr = line.trim();
      this.options.onStderr?.(this.department, line);
    });
    child.once('close', (code, signal) => {
      if (this.stopping) finish(null);
      else finish(this.lastStderr || `Claude Code exited (${signal ?? `code ${code}`}).`);
    });
  }

  send(text: string, options: SendOptions = {}): void {
    if (!this.child) this.start();
    const child = this.child;
    if (!child || !child.stdin.writable) {
      this.publish([{ type: 'error', department: this.department, message: 'The manager session is not running, so the message was not sent.' }]);
      return;
    }
    const priority = options.priority ? { priority: options.priority } : {};
    child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text }, ...priority })}\n`);
    this.publish(this.mapper.sent());
  }

  /**
   * Ends the running turn and keeps the session. Sent as the stream-json interrupt control request (what
   * the Agent SDK's interrupt() sends): on 2.1.287 a SIGINT ends the turn and then the whole process.
   */
  interrupt(): void {
    const child = this.child;
    if (!child || !child.stdin.writable) return;
    child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: `interrupt_${randomUUID()}`, request: { subtype: 'interrupt' } })}\n`);
  }

  /** Interrupts a running turn, closes stdin and waits; SIGTERM after the grace period, SIGKILL after five more seconds. */
  stop(): Promise<void> {
    const child = this.child;
    if (!child) return Promise.resolve();
    if (!this.stopping && this.mapper.sessionState().status !== 'ready') this.interrupt();
    this.stopping = true;
    const grace = this.options.stopGraceMs ?? 3000;
    return new Promise((resolve) => {
      const term = setTimeout(() => child.kill('SIGTERM'), grace);
      const kill = setTimeout(() => child.kill('SIGKILL'), grace + 5000);
      child.once('close', () => {
        clearTimeout(term);
        clearTimeout(kill);
        resolve();
      });
      child.stdin.end();
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.stop();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.removeAllListeners();
  }

  private publish(events: ServerEvent[]): void {
    for (const event of events) {
      if (event.type === 'agent.upsert' && event.agent.kind === 'subagent') this.scheduleRemoval(event.agent);
      this.emit('event', event);
    }
  }

  private scheduleRemoval(agent: AgentPresence): void {
    const finished = agent.status === 'done' || agent.status === 'failed';
    const timer = this.timers.get(agent.id);
    if (!finished) {
      if (timer) clearTimeout(timer);
      this.timers.delete(agent.id);
      return;
    }
    if (timer || this.disposed) return;
    const handle = setTimeout(() => {
      this.timers.delete(agent.id);
      this.publish(this.mapper.forget(agent.id));
    }, this.options.removeAfterMs ?? 120_000);
    handle.unref();
    this.timers.set(agent.id, handle);
  }
}
