// The one contract every part of Affice shares: the server, the scene, the UI and the mock.
// Frozen by the coordinator. Changes go through the coordinator, never through a build task.

export const DEPARTMENT_COLORS = ['stone', 'amber', 'moss', 'sky', 'indigo', 'plum', 'rose'] as const;
export type DepartmentColor = (typeof DEPARTMENT_COLORS)[number];

/**
 * The models offered in the department form. An alias follows the newest model of its family in the
 * user's own Claude Code; a full model id (claude-...) also works and is kept as typed.
 */
export const MODELS = {
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
} as const;
export type ModelId = string;

const MODEL_ID = /^(opus|sonnet|haiku|claude-[a-z0-9][a-z0-9.-]{1,60})$/;

export function isModelId(value: unknown): value is ModelId {
  return typeof value === 'string' && MODEL_ID.test(value);
}

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * A Claude Code session id as Affice passes it to `--resume`. It never starts with a hyphen, because
 * `--resume` takes its value as an optional one and a value that looks like an option would be read as one.
 */
export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value);
}

/** "Opus" for an alias, "Haiku 4.5" for claude-haiku-4-5-20251001, the id itself otherwise. */
export function modelLabel(id: string | null | undefined): string {
  if (!id) return '';
  const alias = (MODELS as Record<string, string>)[id];
  if (alias) return alias;
  const m = /^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?(?:\[[^\]]*\])?$/.exec(id);
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}`;
  return id.replace(/^claude-/, '');
}

/** What the manager session may do without asking the user in the browser. */
export type PermissionPolicy =
  | 'ask' // every tool that needs permission becomes an approval card in the browser
  | 'accept-edits' // file edits pass, everything else asks
  | 'read-only'; // only reading tools, Trella and subagents; nothing else runs

export interface RepoRef {
  name: string; // short, unique in the department
  path: string; // absolute, or relative to the office root
  base: string; // the branch everything is measured against
}

/** `room`: a department with its room. `lobby`: the general manager at the reception desk (one only, id GENERAL_ID). */
export type DepartmentKind = 'room' | 'lobby';

/** The id of the lobby's general manager. The server makes sure it exists. */
export const GENERAL_ID = 'general';

export interface Department {
  id: string; // slug [a-z0-9-]{1,32}, unique
  /** Absent means `room`. */
  kind?: DepartmentKind;
  /**
   * Folders this manager reads for context, absolute or relative to the project. For the general manager
   * the default (when absent) is the Office folder and the project's README. Set in the department form.
   */
  knowledgeDirs?: string[];
  name: string;
  color: DepartmentColor;
  /** The user's text. Becomes the manager's appended system prompt. */
  responsibility: string;
  /** Absolute path the manager session runs in. */
  cwd: string;
  model: ModelId;
  permission: PermissionPolicy;
  repos: RepoRef[];
  /** Directories with Markdown reports, absolute or relative to the office root. */
  reportDirs: string[];
  trellaBoardId: string | null;
  /** Last Claude Code session id, for resume after a restart. */
  sessionId: string | null;
  /** Room position in the building grid, assigned by the server. */
  slot: number;
  createdAt: string; // ISO 8601
}

export interface OfficeConfig {
  version: 1;
  company: string;
  /** Trella's web UI, for the Kanban view. */
  trellaUrl: string;
  departments: Department[];
}

export type SessionStatus = 'off' | 'starting' | 'ready' | 'busy' | 'waiting' | 'error';

export interface SessionState {
  department: string;
  status: SessionStatus;
  /** True while this session runs with every permission check skipped (session.bypass). Off whenever a session starts. */
  bypass: boolean;
  sessionId: string | null;
  model: string | null;
  startedAt: string | null;
  error: string | null;
}

export type AgentStatus =
  | 'idle' // manager: session ready, nothing running
  | 'thinking' // manager: a turn is running, no tool yet
  | 'working' // a tool is running, or a subagent is busy
  | 'waiting' // waiting for the user's approval
  | 'arriving' // subagent just started (the scene walks it to a desk)
  | 'done'
  | 'failed';

export interface AgentPresence {
  /** Manager: `manager:<department>`. Subagent: the task_id from task_started. */
  id: string;
  department: string;
  kind: 'manager' | 'subagent';
  /** Manager: "<Department> manager". Subagent: the description from task_started. */
  title: string;
  /** A card key such as ENG-12 when the title or prompt carries one. */
  cardKey: string | null;
  model: string | null;
  status: AgentStatus;
  currentTool: string | null;
  /** The newest text the agent said, for the speech bubble. Short. */
  lastText: string | null;
  startedAt: string;
  endedAt: string | null;
  /** The Agent tool_use id that spawned a subagent. */
  parentToolUseId: string | null;
}

export interface ChatMessage {
  id: string;
  department: string;
  /**
   * `user`: the person at the keyboard. `colleague`: written to this manager by another agent of the office (today only
   * the general manager), named in fromName. History files written before the rename say `founder`; the server reads them as `user`.
   */
  role: 'user' | 'manager' | 'system' | 'colleague';
  fromName?: string;
  text: string;
  at: string;
  /** True while deltas are still arriving. */
  streaming: boolean;
}

/**
 * One labelled block of an approval card: the command, the old and the new text of an edit, a URL, a
 * message. Shown whole in a monospace block, as plain text (control and bidi characters are already
 * written out as visible escapes by the server).
 */
export interface PermissionPart {
  label: string;
  text: string;
  /** Characters cut from the end because the text passed the cap (PERMISSION_PART_CAP); 0 when `text` is whole. */
  cut: number;
}

/** The longest text of one part of an approval card, in characters. Anything longer is cut and says so. */
export const PERMISSION_PART_CAP = 8192;

export interface PermissionRequest {
  id: string;
  department: string;
  agentId: string | null;
  tool: string;
  input: unknown;
  /** One line a person can read: "Edit src/config/settings.py". */
  summary: string;
  /** The working directory of the agent that asked (absent in older requests). */
  cwd?: string | null;
  /** The file the call touches, as the agent wrote it (edits, writes, reads; absent otherwise). */
  path?: string | null;
  /** The whole request as text, for the card: the command, the edit, the URL (absent in older requests). */
  parts?: PermissionPart[];
  at: string;
}

export interface OfficeSnapshot {
  config: OfficeConfig;
  sessions: SessionState[];
  agents: AgentPresence[];
  /** The last 200 messages per department. */
  messages: ChatMessage[];
  /** Open requests only. */
  permissions: PermissionRequest[];
}

export interface DepartmentInput {
  name: string;
  color: DepartmentColor;
  responsibility: string;
  cwd: string;
  model: ModelId;
  permission: PermissionPolicy;
  repos?: RepoRef[];
  reportDirs?: string[];
  /** Folders the manager reads for context (see Department.knowledgeDirs). Absent or empty: the default applies. */
  knowledgeDirs?: string[];
}

/** An empty `knowledgeDirs` list clears the folders, so the default applies again. */
export type DepartmentPatch = Partial<
  Pick<Department, 'name' | 'color' | 'responsibility' | 'cwd' | 'model' | 'permission' | 'repos' | 'reportDirs' | 'knowledgeDirs'>
>;

// ------------------------------------------------------------------------- the app around the office
//
// Affice runs with or without a project. The app state says whether Claude Code is ready and which
// project is open; the client shows its setup screens until both are, then the office of that project.
// A project is any folder; everything of its office lives in <project>/Office/.

/** What Affice knows about the user's Claude Code. Never account details: no email, no organization, no token. */
export interface ClaudeStatus {
  /** A `claude` binary was found and answered `--version`. */
  installed: boolean;
  /** The binary Affice runs, or null when none was found. */
  path: string | null;
  /** For example "2.1.287", or null when unknown. */
  version: string | null;
  /** The oldest version with every flag Affice uses. */
  minVersion: string;
  /** The installed version is older than minVersion (a warning: Affice drops the newer flags). */
  tooOld: boolean;
  /** Signed in with a Claude subscription (Affice works with nothing else). */
  signedIn: boolean;
  /** How Claude Code is signed in: `claude.ai` or `oauth_token` (a Claude subscription), or null. Any other sign-in counts as not signed in. */
  authMethod: string | null;
  /** A sign-in started from Affice is running. */
  signingIn: boolean;
  /** The sign-in page to open, while a sign-in runs and the CLI printed one. */
  loginUrl: string | null;
  /** The last problem, as a sentence for the user. */
  error: string | null;
  /** CLAUDE_BIN is set and the program it names did not answer `claude --version`: the fix is that variable, not an install. */
  claudeBinProblem?: boolean;
}

/** Ready for the office: installed and signed in. A version that is too old is a warning, not a stop. */
export function claudeReady(status: ClaudeStatus): boolean {
  return status.installed && status.signedIn;
}

/** Where the picker found a project: the recent list, Claude Code's own projects, or a folder the user browsed to. */
export type ProjectSource = 'recent' | 'claude' | 'folder';

export interface ProjectSummary {
  /** Absolute path of the project folder. */
  path: string;
  /** What the office is called; by default the folder's base name. */
  name: string;
  /** The folder already has an Office/ folder with an affice.json. */
  hasOffice: boolean;
  lastUsedAt: string | null; // ISO 8601
  source: ProjectSource;
}

export interface AppState {
  claude: ClaudeStatus;
  /** The open project, or null while the setup screens show. */
  project: ProjectSummary | null;
  /** Recently opened projects, newest first. */
  recent: ProjectSummary[];
}

/** One folder of the picker's folder browser. */
export interface FolderEntry {
  name: string;
  path: string; // absolute
  hasOffice: boolean;
}

export interface FolderListing {
  path: string; // absolute
  /** The parent folder, or null at the file system root. */
  parent: string | null;
  folders: FolderEntry[];
}

// HTTP of the app, next to /api/office (all local only, like the rest of the server):
//   GET /api/app            AppState                                          server/host.ts via server/index.ts
//   GET /api/projects       ProjectSummary[]: the recent ones, then Claude Code's projects   (server/project)
//   GET /api/fs?path=<abs>  FolderListing: the subfolders of a folder (default the home folder)   (server/project)
// Routes of an office (/api/office*, /api/approvals*, /api/data/*) answer 409 with an error while no project is open.

// Server to client, over the WebSocket at /ws. Every frame is one JSON ServerEvent.
// On every connection the server sends app.state first, then office.state (with no departments while
// no project is open). It sends app.state again whenever the app state changes, and office.state
// whenever a project opens or closes.
export type ServerEvent =
  | { type: 'app.state'; state: AppState }
  | { type: 'office.state'; snapshot: OfficeSnapshot }
  | { type: 'department.created'; department: Department }
  | { type: 'department.updated'; department: Department }
  | { type: 'department.removed'; id: string }
  | { type: 'session.state'; state: SessionState }
  | { type: 'chat.message'; message: ChatMessage }
  | { type: 'chat.delta'; department: string; messageId: string; text: string }
  | { type: 'chat.done'; department: string; messageId: string }
  | { type: 'agent.upsert'; agent: AgentPresence }
  | { type: 'agent.removed'; id: string }
  | { type: 'tool.started'; department: string; agentId: string; toolUseId: string; name: string; summary: string }
  | { type: 'tool.finished'; department: string; agentId: string; toolUseId: string; ok: boolean }
  | { type: 'permission.requested'; request: PermissionRequest }
  | { type: 'permission.resolved'; id: string; allow: boolean }
  | { type: 'turn.result'; department: string; costUsd: number | null; turns: number | null; durationMs: number | null }
  | { type: 'error'; department: string | null; message: string };

// Client to server, over the same socket. Every frame is one JSON ClientCommand.
export type ClientCommand = OfficeCommand | AppCommand;

/** Commands for the app: Claude Code and the project. Answered with app.state (and office.state for a project). */
export type AppCommand =
  /** Checks Claude Code again (installed, version, signed in). */
  | { type: 'claude.refresh' }
  /** Starts Claude Code's own sign-in; app.state follows its progress. */
  | { type: 'claude.login' }
  | { type: 'claude.cancelLogin' }
  /** Opens the project at this absolute path (creating its Office/ folder when missing), closing the open one first. */
  | { type: 'project.open'; path: string }
  /** Stops the project's sessions and returns to the setup screens. */
  | { type: 'project.close' };

export const APP_COMMANDS: ReadonlyArray<AppCommand['type']> = ['claude.refresh', 'claude.login', 'claude.cancelLogin', 'project.open', 'project.close'];

export function isAppCommand(command: ClientCommand): command is AppCommand {
  return (APP_COMMANDS as ReadonlyArray<string>).includes(command.type);
}

/** Commands for the open project's office. Answered with an error while no project is open. */
export type OfficeCommand =
  | { type: 'chat.send'; department: string; text: string }
  | { type: 'session.start'; department: string }
  | { type: 'session.stop'; department: string }
  | { type: 'session.interrupt'; department: string }
  /** Restarts the session (with --resume) with every permission check skipped, or back to the department's policy. */
  | { type: 'session.bypass'; department: string; on: boolean }
  | { type: 'department.create'; input: DepartmentInput }
  | { type: 'department.update'; id: string; patch: DepartmentPatch }
  | { type: 'department.remove'; id: string }
  | { type: 'permission.answer'; id: string; allow: boolean };

// Data views, served at GET /api/data/:department/<view>. Read-only. Nothing is stored.

export type BranchState = 'base' | 'in-flight' | 'leftover' | 'stale';

export interface BranchInfo {
  name: string;
  ahead: number; // commits ahead of the base
  behind: number;
  merged: boolean; // merged into the base, or patch-equivalent
  lastCommitAt: string;
  author: string;
  subject: string;
  cardKey: string | null; // parsed from the branch name
  worktree: string | null; // absolute path when checked out somewhere
  dirty: number | null; // changed files in that worktree, when known
  state: BranchState;
}

export interface RepoBranches {
  name: string;
  path: string;
  base: string;
  ok: boolean;
  error: string | null;
  branches: BranchInfo[];
}

export interface BranchesView {
  generatedAt: string;
  staleDays: number;
  repos: RepoBranches[];
}

export interface ReportInfo {
  file: string; // base name
  path: string; // absolute
  date: string | null; // YYYY-MM-DD from the file name
  cardKey: string | null;
  title: string; // first heading, or the file name
  modifiedAt: string;
}

export interface ReportsView {
  generatedAt: string;
  reports: ReportInfo[]; // newest first
}

export interface DecisionCard {
  key: string; // ENG-8
  title: string;
  boardId: string;
  /** The name of that board, for the group title of the Decisions view. */
  boardName: string;
  status: string; // column id
  labels: string[];
  updatedAt: string;
  url: string; // the card in Trella's UI
}

export interface DecisionsView {
  generatedAt: string;
  /** Open cards labelled `decision` on every board of the project's Trella workspace, the department's own board first, then the others in the order they were created. */
  cards: DecisionCard[];
}

export type DataViewKind = 'kanban' | 'branches' | 'reports' | 'decisions';

export const CARD_KEY = /\b([A-Z]{2,5}-\d+)\b/;

export function parseCardKey(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = CARD_KEY.exec(text);
  return m ? m[1] : null;
}
