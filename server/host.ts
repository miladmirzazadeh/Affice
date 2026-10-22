// The app host: the app state (Claude Code, the open project, the recent projects) and the office of the
// open project. Affice runs with no project (the client shows its setup screens), opens a project's
// office, switches (close, then open) and closes it. Owned by the coordinator.
//
// The host calls the four seams and nothing else for what they own:
//   server/claude/setup.ts     Claude Code: status, sign-in
//   server/project/index.ts    the projects, the Office/ folder and its layout
//   server/protocol/index.ts   PROTOCOL.md (the prompts and MCP servers go through the driver)
//   server/trella-service.ts   the project's Trella service
// server/index.ts keeps http, the socket, the security checks and the routing, and delegates here.

import { EventEmitter } from 'node:events';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptySnapshot } from '../client/state/store';
import { RouteError, type DepartmentLookup, type OfficeLayout, type OfficePaths } from '../shared/server-api';
import { isAppCommand, type AppCommand, type AppState, type ClaudeStatus, type ClientCommand, type Department, type OfficeSnapshot, type ProjectSummary, type ServerEvent } from '../shared/types';
import { cancelLogin, claudeStatus, startLogin } from './claude/setup';
import { CliManagerSession, compareVersions, FORWARD_SUBAGENT_TEXT_SINCE, type CliDriverOptions, type ManagerSession } from './claude/driver';
import { Office } from './office';
import { OfficeStore, summarizeProblems } from './office-store';
import { ensureOffice, recentProjects, recordRecent } from './project/index';
import { writeProtocol } from './protocol/index';
import { trellaBoards, type CreateBoard } from './trella-cli';
import { startTrella, stopTrella, trellaCli, type TrellaStart } from './trella-service';

const AFFICE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(AFFICE_DIR, 'fixtures/office.json');

/** The answer of every office route and command while no project is open. */
export const NO_PROJECT = 'No project is open. Choose a project first.';

/** The seams the host calls, by name. The defaults are the modules above; the tests pass fakes. */
export interface Seams {
  claudeStatus: typeof claudeStatus;
  startLogin: typeof startLogin;
  cancelLogin: typeof cancelLogin;
  ensureOffice: typeof ensureOffice;
  recentProjects: typeof recentProjects;
  recordRecent: typeof recordRecent;
  writeProtocol: typeof writeProtocol;
  startTrella: typeof startTrella;
  stopTrella: typeof stopTrella;
}

const DEFAULT_SEAMS: Seams = { claudeStatus, startLogin, cancelLogin, ensureOffice, recentProjects, recordRecent, writeProtocol, startTrella, stopTrella };

/** What the seams' route modules (registerClaudeRoutes, registerProjectRoutes) may use of the host. */
export interface HostHandle {
  appState(): AppState;
  /** The open project's layout, or null. */
  layout(): OfficeLayout | null;
  /** Checks Claude Code again and broadcasts app.state. */
  refreshClaude(): Promise<ClaudeStatus>;
  /** Replaces the Claude status (for example while a sign-in runs) and broadcasts app.state. */
  setClaude(status: ClaudeStatus): void;
  openProject(path: string): Promise<ProjectSummary>;
  closeProject(): Promise<void>;
}

export type CreateSession = (department: Department, lookup: () => Department | null, options: CliDriverOptions) => ManagerSession;

export interface HostOptions {
  /** The office server's own address, for the managers' MCP server (http://127.0.0.1:<port>). */
  officeUrl: string;
  log?: (line: string) => void;
  /** Builds a manager session; default the Claude Code CLI driver. */
  createSession?: CreateSession;
  /** Creates a department's Trella board; default the Trella CLI run in the layout's Trella workspace. */
  createBoard?: (layout: OfficeLayout) => CreateBoard;
  /** Stderr lines of the manager processes. */
  onStderr?: (department: string, line: string) => void;
  seams?: Partial<Seams>;
}

interface OpenProject {
  layout: OfficeLayout;
  store: OfficeStore;
  office: Office;
  summary: ProjectSummary;
}

const unknownClaude = (): ClaudeStatus => ({
  installed: false,
  path: null,
  version: null,
  minVersion: FORWARD_SUBAGENT_TEXT_SINCE,
  tooOld: false,
  signedIn: false,
  authMethod: null,
  signingIn: false,
  loginUrl: null,
  error: null,
});

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AppHost extends EventEmitter implements HostHandle {
  private readonly seams: Seams;
  private readonly log: (line: string) => void;
  private claude: ClaudeStatus = unknownClaude();
  private current: OpenProject | null = null;
  /** Opening and closing run one at a time, in the order they were asked for. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly forward = (event: ServerEvent) => this.emit('event', event);

  /** The data routes' paths: read at every request from the open project (a RouteError 409 while none is open). */
  readonly paths: OfficePaths;
  /** The data routes' departments: the open project's (a RouteError 409 while none is open). */
  readonly departments: DepartmentLookup;

  constructor(private readonly options: HostOptions) {
    super();
    this.seams = { ...DEFAULT_SEAMS, ...options.seams };
    this.log = options.log ?? ((line) => console.log(`[affice] ${line}`));
    const host = this;
    this.paths = {
      get root() {
        return host.requireProject().layout.trellaWorkspace;
      },
      get project() {
        return host.requireProject().layout.project;
      },
      get trellaCli() {
        return trellaCli();
      },
      get trellaUrl() {
        return host.requireProject().store.config.trellaUrl;
      },
    };
    this.departments = { byId: (id) => this.requireProject().store.byId(id) };
  }

  /** Checks Claude Code, then opens `project` (default AFFICE_PROJECT) when one is given. A project that fails to open is logged. */
  async start(options: { project?: string | null } = {}): Promise<void> {
    const status = await this.refreshClaude();
    this.log(`Claude Code ${status.version ?? 'not found'}${this.forwardSubagentText() ? ', forwarding subagent text' : ''}`);
    const project = options.project === undefined ? process.env.AFFICE_PROJECT : options.project;
    if (!project) return;
    try {
      await this.openProject(resolve(project));
    } catch (error) {
      this.log(`The project ${project} did not open: ${message(error)}`);
    }
  }

  // State -------------------------------------------------------------------------------------------

  appState(): AppState {
    let recent: ProjectSummary[] = [];
    try {
      recent = this.seams.recentProjects();
    } catch (error) {
      this.log(`The recent projects could not be read: ${message(error)}`);
    }
    return { claude: { ...this.claude }, project: this.current ? { ...this.current.summary } : null, recent };
  }

  /** The open project's office, or the empty office (no departments) while none is open. */
  officeSnapshot(): OfficeSnapshot {
    if (this.current) return this.current.office.snapshot();
    return { ...emptySnapshot, config: { ...emptySnapshot.config, departments: [] }, sessions: [], agents: [], messages: [], permissions: [] };
  }

  layout(): OfficeLayout | null {
    return this.current?.layout ?? null;
  }

  /** The open project's office, or a RouteError (409) for the HTTP routes. */
  requireOffice(): Office {
    return this.requireProject().office;
  }

  private requireProject(): OpenProject {
    if (!this.current) throw new RouteError(409, NO_PROJECT);
    return this.current;
  }

  // Claude Code (its seam) -------------------------------------------------------------------------

  async refreshClaude(): Promise<ClaudeStatus> {
    try {
      this.claude = await this.seams.claudeStatus();
    } catch (error) {
      this.claude = { ...unknownClaude(), error: `Claude Code could not be checked: ${message(error)}` };
    }
    this.emitApp();
    return { ...this.claude };
  }

  setClaude(status: ClaudeStatus): void {
    this.claude = { ...status };
    this.emitApp();
  }

  private forwardSubagentText(): boolean {
    return this.claude.version !== null && compareVersions(this.claude.version, FORWARD_SUBAGENT_TEXT_SINCE) >= 0;
  }

  // Projects --------------------------------------------------------------------------------------------

  /**
   * Opens the project at `path`, closing the open one first (a switch). In order: ensureOffice,
   * writeProtocol, startTrella, recordRecent; then the OfficeStore at
   * <project>/Office, the Office and its sessions. Opening the project that is already open changes nothing.
   */
  openProject(path: string): Promise<ProjectSummary> {
    return this.serial(async () => {
      if (this.current && this.current.layout.project === resolve(path)) return { ...this.current.summary };
      const closed = await this.closeCurrent();
      let layout: OfficeLayout | null = null;
      let trella: TrellaStart;
      try {
        layout = this.seams.ensureOffice(path);
        this.seams.writeProtocol(layout);
        trella = await this.seams.startTrella(layout);
        try {
          this.seams.recordRecent({ path: layout.project, name: layout.name, hasOffice: true, lastUsedAt: new Date().toISOString(), source: 'recent' });
        } catch (error) {
          this.log(`The recent projects could not be saved: ${message(error)}`);
        }
        this.current = this.build(layout, trella.url ?? null);
      } catch (error) {
        if (layout) await this.seams.stopTrella(layout).catch(() => undefined);
        // A switch that failed halfway leaves no project open: say so.
        if (closed) {
          this.emitApp();
          this.emitOffice();
        }
        throw error;
      }
      this.log(`opened ${layout.project} (office in ${layout.officeDir})`);
      this.emitApp();
      this.emitOffice();
      // After the new office, so the office shows it. What the office file got wrong (SEC-10) is told once, as a sentence.
      const fileProblems = this.current.store.problems;
      if (fileProblems.length) {
        this.emit('event', { type: 'error', department: null, message: `This project's office files needed repairs. ${summarizeProblems(fileProblems)}` } satisfies ServerEvent);
      }
      if (trella.problem) {
        this.log(`${trella.problem} Departments are created without a Trella board until then.`);
        this.emit('event', { type: 'error', department: null, message: trella.problem } satisfies ServerEvent);
      }
      return { ...this.current.summary };
    });
  }

  /** Stops the open project's sessions and its Trella service, and returns to no project. */
  closeProject(): Promise<void> {
    return this.serial(async () => {
      if (!this.current) return;
      await this.closeCurrent();
      this.emitApp();
      this.emitOffice();
    });
  }

  /** Server shutdown: closes the open project. */
  shutdown(): Promise<void> {
    return this.closeProject();
  }

  private build(layout: OfficeLayout, trellaUrl: string | null): OpenProject {
    const store = OfficeStore.open({
      dataDir: layout.officeDir,
      configFile: layout.configFile,
      chatDir: layout.chatDir,
      fixture: FIXTURE,
      root: layout.trellaWorkspace,
      company: layout.name,
      cwdDefault: layout.project,
      log: this.log,
    });
    // The service's address wins over the one in affice.json (it may have moved to a free port).
    if (trellaUrl) store.config.trellaUrl = trellaUrl;
    const lookup = (id: string): Department | null => store.byId(id);
    const driver: CliDriverOptions = {
      layout,
      officeUrl: this.options.officeUrl,
      nodeBin: process.execPath,
      tsxCli: join(AFFICE_DIR, 'node_modules/tsx/dist/cli.mjs'),
      approvalsScript: join(AFFICE_DIR, 'server/claude/approvals-mcp.ts'),
      forwardSubagentText: this.forwardSubagentText(),
      company: () => store.config.company,
      claudeBin: this.claude.path ?? 'claude',
      onStderr: this.options.onStderr,
    };
    const createSession: CreateSession = this.options.createSession ?? ((department, find, options) => new CliManagerSession(department, find, options));
    const office = new Office({
      store,
      createBoard: this.options.createBoard ? this.options.createBoard(layout) : trellaBoards(layout.trellaWorkspace, trellaCli()),
      log: this.log,
      createSession: (id) => createSession(store.byId(id)!, () => lookup(id), driver),
    });
    office.on('event', this.forward);
    const summary: ProjectSummary = {
      path: layout.project,
      name: store.config.company?.trim() || layout.name,
      hasOffice: true,
      lastUsedAt: new Date().toISOString(),
      source: 'recent',
    };
    return { layout, store, office, summary };
  }

  /**
   * Closes the open project without broadcasting: the sessions first (their off events still go out),
   * then Trella. True when a project was open.
   */
  private async closeCurrent(): Promise<boolean> {
    const current = this.current;
    if (!current) return false;
    // From here every office command and route answers NO_PROJECT.
    this.current = null;
    try {
      await current.office.dispose();
    } catch (error) {
      this.log(`The sessions of ${current.layout.project} did not stop cleanly: ${message(error)}`);
    }
    current.office.off('event', this.forward);
    try {
      await this.seams.stopTrella(current.layout);
    } catch (error) {
      this.log(`Trella of ${current.layout.project} did not stop cleanly: ${message(error)}`);
    }
    this.log(`closed ${current.layout.project}`);
    return true;
  }

  // Commands --------------------------------------------------------------------------------------------

  /** One command from a socket. Office commands go to the open office; with none open they answer an error. */
  async handle(command: ClientCommand): Promise<void> {
    try {
      if (isAppCommand(command)) {
        await this.handleApp(command);
        return;
      }
      if (!this.current) throw new Error(NO_PROJECT);
      await this.current.office.handle(command);
    } catch (error) {
      this.emit('event', { type: 'error', department: null, message: message(error) } satisfies ServerEvent);
    }
  }

  private async handleApp(command: AppCommand): Promise<void> {
    switch (command.type) {
      case 'claude.refresh':
        await this.refreshClaude();
        return;
      case 'claude.login':
        this.setClaude(await this.seams.startLogin((status) => this.setClaude(status)));
        return;
      case 'claude.cancelLogin':
        this.setClaude(await this.seams.cancelLogin());
        return;
      case 'project.open':
        await this.openProject(command.path);
        return;
      case 'project.close':
        await this.closeProject();
        return;
    }
  }

  // Broadcasts ------------------------------------------------------------------------------------------

  private emitApp(): void {
    this.emit('event', { type: 'app.state', state: this.appState() } satisfies ServerEvent);
  }

  private emitOffice(): void {
    this.emit('event', { type: 'office.state', snapshot: this.officeSnapshot() } satisfies ServerEvent);
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
