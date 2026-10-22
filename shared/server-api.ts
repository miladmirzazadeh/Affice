// The seams between the parts of the server: the data views (server/data/) and the office layout
// every project seam shares. Frozen by the coordinator.

export interface RouteRequest {
  params: Record<string, string>;
  query: URLSearchParams;
}

/** How a route is opened (server/app.ts holds the gate). The default is a page route: the page's token, in the x-affice-token header. */
export interface RouteOptions {
  /** An agent route: opened by a manager's agent token (and never by the page token). */
  agent?: boolean;
  /** A page route that a link may also open with a short-lived ticket for this scope (a report file), since a link cannot send a header. */
  ticketScope?: (request: RouteRequest) => string;
}

export interface Router {
  /** `pattern` uses `:name` segments, for example `/api/data/:department/branches`. The handler's return value is sent as JSON. Throw a RouteError to set the status. */
  get(pattern: string, handler: (request: RouteRequest) => Promise<unknown> | unknown, options?: RouteOptions): void;
}

/**
 * A file instead of JSON: `{contentType, body, headers?}` and no other keys. A route handler returns it
 * (the report route of server/data/) and the router sends `body` with `content-type: contentType` and
 * the optional `headers` when isRawResponse says the value is one.
 */
export interface RawResponse {
  contentType: string;
  body: string;
  headers?: Record<string, string>;
}

export function isRawResponse(value: unknown): value is RawResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.contentType === 'string' &&
    typeof v.body === 'string' &&
    (v.headers === undefined || (typeof v.headers === 'object' && v.headers !== null)) &&
    Object.keys(v).every((key) => key === 'contentType' || key === 'body' || key === 'headers')
  );
}

export class RouteError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The paths of the open project's office, for the data routes. server/index.ts passes an object whose
 * getters read the current project, so they throw a RouteError (409) while no project is open.
 */
export interface OfficePaths {
  /** The office root: the folder that holds .agentboard (<project>/Office). Relative report paths start here. */
  root: string;
  /** The project folder, the parent of the Office folder. Relative repository paths start here, so `.` is the project. */
  project: string;
  /** The Trella CLI entry: node <trellaCli> ... */
  trellaCli: string;
  trellaUrl: string;
}

/**
 * Where everything of a project's office lives. Made by ensureOffice (server/project) when a
 * project opens, and handed to every seam: the protocol, the Trella service and the
 * driver. Every path is absolute.
 */
export interface OfficeLayout {
  /** The project folder the user chose. Departments work here by default. */
  project: string;
  /** The office's name: by default the project folder's base name. */
  name: string;
  /** <project>/Office */
  officeDir: string;
  /** <project>/Office/affice.json: the office name (company), the departments, models and policies. */
  configFile: string;
  /** <project>/Office/chat: chat history, one <department>.jsonl each (gitignored). */
  chatDir: string;
  /** <project>/Office/reports: what agents write. */
  reportsDir: string;
  /** <project>/Office/PROTOCOL.md: how agents work here. */
  protocolFile: string;
  /** The folder that holds .agentboard/ (<project>/Office): TRELLA_PROJECT, and the cwd of Trella's CLI and service. */
  trellaWorkspace: string;
}

export interface DepartmentLookup {
  byId(id: string): import('./types').Department | null;
}

/** Implemented in server/data/index.ts (owned by the data task); called once by server/index.ts (owned by the runtime task). */
export type RegisterDataRoutes = (router: Router, paths: OfficePaths, departments: DepartmentLookup) => void;

/** One line of `affice doctor`: what was checked, whether it passed, and the fix when it did not. */
export interface DoctorCheck {
  id: string; // stable, for agents: node, claude.installed, claude.version, claude.signedIn, trella.built, ...
  ok: boolean;
  /**
   * `warn`: when this check fails (ok is false) it is only a warning. It is printed as one, and it does not
   * make the report's `ok` false or the exit code 1 (a Claude Code that is too old still works). Absent: a
   * failing check is a failure.
   */
  level?: 'warn';
  title: string;
  detail: string;
  /** A command or one sentence the user, or their agent, can act on. Null when ok. */
  fix: string | null;
}
