// The project seam: which projects the picker offers, the folder browser, and the Office/ folder of a
// project. server/host.ts calls these functions and
// nothing else.
//
//   recent projects     ~/.affice/projects.json (AFFICE_HOME moves ~/.affice), at most RECENT_LIMIT, newest first
//   Claude Code's       the keys of `projects` in ~/.claude.json, read only and never written, ranked by the
//                       newest transcript in ~/.claude/projects/<path with every non-letter, non-digit as '-'>/
//                       (CLAUDE_CONFIG_DIR moves both, AFFICE_CLAUDE_JSON moves the file; the tests set them)
//   the folder browser  folder names only: never a file name, never a file's contents
//   the Office folder   <project>/Office/ with affice.json (the lobby's general manager only), chat/, reports/
//                       and a .gitignore; whatever exists is kept, only what is missing is created

import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { broadFolder } from '../../shared/folders';
import { RouteError, type OfficeLayout } from '../../shared/server-api';
import { GENERAL_ID, type Department, type FolderEntry, type FolderListing, type OfficeConfig, type ProjectSummary } from '../../shared/types';
import type { HostHandle } from '../host';
import type { HttpRouter } from '../router';
import { PRIVATE_FILE, PRIVATE_FOLDER, UnsafePathError, ensureFolder, lstatOrNull, refuseUnlessPlainFile, writeFileAtomic, writeNewFile } from './safe-fs';

/** The folder of the office inside a project. */
export const OFFICE_FOLDER = 'Office';
/** At most this many recent projects are kept. */
export const RECENT_LIMIT = 12;
/** At most this many of Claude Code's projects are offered. */
export const CLAUDE_LIMIT = 50;

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), '../../fixtures/office.json');
/** A larger ~/.claude.json is not read. */
const MAX_CLAUDE_JSON = 64 * 1024 * 1024;

/** Affice's own folder in the home folder: ~/.affice, or AFFICE_HOME (the tests set it). Read at every call. */
export function afficeHome(): string {
  return resolve(process.env.AFFICE_HOME ?? join(homedir(), '.affice'));
}

function recentFile(): string {
  return join(afficeHome(), 'projects.json');
}

/** Where everything of a project's office lives. Pure: nothing is created. */
export function officeLayout(projectPath: string): OfficeLayout {
  const project = resolve(projectPath);
  const officeDir = join(project, OFFICE_FOLDER);
  return {
    project,
    name: basename(project) || project,
    officeDir,
    configFile: join(officeDir, 'affice.json'),
    chatDir: join(officeDir, 'chat'),
    reportsDir: join(officeDir, 'reports'),
    protocolFile: join(officeDir, 'PROTOCOL.md'),
    trellaWorkspace: officeDir,
  };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function hasOffice(project: string): boolean {
  return existsSync(officeLayout(project).configFile);
}

// The Office folder ---------------------------------------------------------------------------------

/** A sentence for the user instead of a bare errno message. */
function fsProblem(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'Affice is not allowed to write there.';
  if (code === 'EEXIST' || code === 'ENOTDIR') return 'Something that is not a folder is in the way.';
  if (code === 'ENOSPC') return 'The disk is full.';
  return error instanceof Error ? error.message : String(error);
}

/** The general manager of a new office: from the fixture, working in the project folder, with no board and no session. */
function newGeneral(layout: OfficeLayout, now: string): Department {
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as OfficeConfig;
  const seed = fixture.departments.find((d) => d.id === GENERAL_ID);
  if (!seed) throw new Error(`${FIXTURE} has no ${GENERAL_ID} department to start the office from.`);
  const general: Department = { ...seed, kind: 'lobby', slot: -1, cwd: layout.project, sessionId: null, trellaBoardId: null, createdAt: now };
  delete general.knowledgeDirs;
  return general;
}

/**
 * Makes sure the project has its Office/ folder and returns its layout. Creates only what is missing:
 * affice.json (the office named after the folder, with the lobby's general manager and no other
 * department), chat/, reports/, and a .gitignore that keeps chat/ out of git. What already exists is
 * never rewritten. Throws a sentence for the user when the path is not a folder or Office/ cannot be made.
 *
 * Nothing is written through a symbolic link (SEC-04): Office/, chat/ and reports/ must be real folders
 * inside the project, affice.json must not be a link, and every file is created with the `wx` flag. A
 * project that breaks this is refused with a sentence that says which path is the link.
 */
export function ensureOffice(projectPath: string): OfficeLayout {
  if (typeof projectPath !== 'string' || !isAbsolute(projectPath)) throw new Error('The project must be an absolute path.');
  const layout = officeLayout(projectPath);
  if (!isDirectory(layout.project)) throw new Error(`${layout.project} is not a folder.`);
  try {
    // The project may itself be reached through links (a symlinked home, /tmp on macOS); what is inside it may not.
    const projectReal = realpathSync(layout.project);
    const officeReal = ensureFolder(layout.officeDir, projectReal, 'The Office folder');
    // The chat history is the user's alone: 0700 here, and 0600 for every chat file.
    ensureFolder(layout.chatDir, officeReal, 'The Office/chat folder', PRIVATE_FOLDER);
    ensureFolder(layout.reportsDir, officeReal, 'The Office/reports folder');
    // wx: a file that is already there, a link included (even a dangling one), is left alone and never written through.
    writeNewFile(join(layout.officeDir, '.gitignore'), '# Chat history stays on this machine.\nchat/\n');
    // A link in place of affice.json is refused here, not skipped: the office could not be saved later.
    refuseUnlessPlainFile(layout.configFile, 'Office/affice.json');
    if (!lstatOrNull(layout.configFile)) {
      const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as OfficeConfig;
      const config: OfficeConfig = {
        version: 1,
        company: layout.name,
        trellaUrl: fixture.trellaUrl,
        departments: [newGeneral(layout, new Date().toISOString())],
      };
      writeFileAtomic(layout.configFile, `${JSON.stringify(config, null, 2)}\n`, 'Office/affice.json', PRIVATE_FILE);
    }
  } catch (error) {
    if (error instanceof UnsafePathError) throw error;
    throw new Error(`Affice could not create the Office folder in ${layout.project}. ${fsProblem(error)}`);
  }
  return layout;
}

/** The office name in affice.json, or the folder name. */
function officeName(project: string): string {
  try {
    const config = JSON.parse(readFileSync(officeLayout(project).configFile, 'utf8')) as Partial<OfficeConfig>;
    if (typeof config.company === 'string' && config.company.trim()) return config.company.trim();
  } catch {
    // no office yet, or not readable: the folder name
  }
  return officeLayout(project).name;
}

/** The summary of a project folder as the picker shows it. */
export function projectSummary(projectPath: string, source: ProjectSummary['source'] = 'folder', lastUsedAt: string | null = null): ProjectSummary {
  const path = resolve(projectPath);
  return { path, name: officeName(path), hasOffice: hasOffice(path), lastUsedAt, source };
}

// Recent projects -----------------------------------------------------------------------------------

/** The recent projects, newest first, at most RECENT_LIMIT, only those whose folder still exists. */
export function recentProjects(): ProjectSummary[] {
  let rows: unknown;
  try {
    rows = JSON.parse(readFileSync(recentFile(), 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  const out: ProjectSummary[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const entry = row as { path?: unknown; lastUsedAt?: unknown };
    if (typeof entry?.path !== 'string' || !isAbsolute(entry.path) || !isDirectory(entry.path)) continue;
    const path = resolve(entry.path);
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(projectSummary(path, 'recent', typeof entry.lastUsedAt === 'string' ? entry.lastUsedAt : null));
  }
  return out.sort((a, b) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? '')).slice(0, RECENT_LIMIT);
}

/** Puts the project first in ~/.affice/projects.json, keeping at most RECENT_LIMIT. */
export function recordRecent(project: ProjectSummary): void {
  const now = project.lastUsedAt ?? new Date().toISOString();
  const path = resolve(project.path);
  const others = recentProjects().filter((p) => p.path !== path);
  const rows = [{ path, lastUsedAt: now }, ...others.map((p) => ({ path: p.path, lastUsedAt: p.lastUsedAt }))].slice(0, RECENT_LIMIT);
  // The list of the user's projects is theirs alone: the folder 0700, the file 0600.
  mkdirSync(afficeHome(), { recursive: true, mode: PRIVATE_FOLDER });
  writeFileAtomic(recentFile(), `${JSON.stringify(rows, null, 2)}\n`, 'The recent projects file', PRIVATE_FILE);
}

// Claude Code's projects ----------------------------------------------------------------------------

/** AFFICE_CLAUDE_JSON, else <CLAUDE_CONFIG_DIR>/.claude.json, else ~/.claude.json. Read only. */
export function claudeJsonFile(): string {
  if (process.env.AFFICE_CLAUDE_JSON) return resolve(process.env.AFFICE_CLAUDE_JSON);
  if (process.env.CLAUDE_CONFIG_DIR) return join(resolve(process.env.CLAUDE_CONFIG_DIR), '.claude.json');
  return join(homedir(), '.claude.json');
}

/** <CLAUDE_CONFIG_DIR>/projects, else .claude/projects next to AFFICE_CLAUDE_JSON, else ~/.claude/projects. */
function claudeTranscriptsDir(): string {
  if (process.env.CLAUDE_CONFIG_DIR) return join(resolve(process.env.CLAUDE_CONFIG_DIR), 'projects');
  if (process.env.AFFICE_CLAUDE_JSON) return join(dirname(resolve(process.env.AFFICE_CLAUDE_JSON)), '.claude', 'projects');
  return join(homedir(), '.claude', 'projects');
}

/** The folder name Claude Code keeps a project's transcripts in: every character that is not a letter or a digit becomes '-'. */
function transcriptFolders(path: string): string[] {
  const ascii = path.replace(/[^a-zA-Z0-9]/g, '-');
  const unicode = path.replace(/[^\p{L}\p{N}]/gu, '-');
  return ascii === unicode ? [ascii] : [ascii, unicode];
}

/** The newest `*.jsonl` modification time in a project's transcript folder, or null when there is none. */
async function lastSessionAt(transcripts: string, path: string): Promise<string | null> {
  for (const folder of transcriptFolders(path)) {
    let names: string[];
    try {
      names = await readdir(join(transcripts, folder));
    } catch {
      continue;
    }
    let newest = 0;
    await Promise.all(
      names
        .filter((name) => name.endsWith('.jsonl'))
        .map(async (name) => {
          try {
            const { mtimeMs } = await stat(join(transcripts, folder, name));
            if (mtimeMs > newest) newest = mtimeMs;
          } catch {
            // gone while reading
          }
        }),
    );
    if (newest > 0) return new Date(newest).toISOString();
  }
  return null;
}

/** The keys of `projects` in Claude Code's config file. Nothing else in the file is read or kept. */
async function claudeProjectPaths(): Promise<string[]> {
  const file = claudeJsonFile();
  try {
    if ((await stat(file)).size > MAX_CLAUDE_JSON) return [];
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { projects?: unknown };
    const projects = parsed?.projects;
    if (typeof projects !== 'object' || projects === null || Array.isArray(projects)) return [];
    return Object.keys(projects);
  } catch {
    return []; // no Claude Code config, or not readable, or not JSON: no Claude Code projects
  }
}

/**
 * A folder Claude Code (or its desktop app) made for itself, not a project of the user: a worktree under
 * .claude/worktrees, and anything in the desktop app's own data folder, where it keeps the scratch
 * workspaces of its sessions (Library/Application Support/Claude on a Mac, %APPDATA%\Claude on Windows,
 * ~/.config/Claude on Linux).
 */
export function isClaudeWorkspace(path: string): boolean {
  const slashed = `${path.replace(/\\/g, '/')}/`;
  return (
    slashed.includes('/.claude/worktrees/') ||
    slashed.includes('/Application Support/Claude/') ||
    slashed.includes('/AppData/Roaming/Claude/') ||
    slashed.includes('/.config/Claude/') ||
    slashed.includes('/scratch-workspaces/') ||
    slashed.includes('/local-agent-mode-sessions/')
  );
}

/** The home folder or the root of the disk, by the way it is written or by where it leads (links resolved). */
function isHomeOrRoot(path: string): boolean {
  const real = (folder: string): string => {
    try {
      return realpathSync(folder);
    } catch {
      return folder;
    }
  };
  const home = homedir();
  return [path, real(path)].some((candidate) => broadFolder(candidate, home) !== null || broadFolder(candidate, real(home)) !== null);
}

/**
 * The user's Claude Code projects: existing folders only, without the home folder itself (Claude Code lists it
 * when it was started there; opening it would put an Office folder in the home folder), the root of the disk,
 * worktrees and the desktop app's scratch workspaces (isClaudeWorkspace), the most recently used first (by the
 * newest transcript), those with no transcript after them.
 */
export async function claudeProjects(): Promise<ProjectSummary[]> {
  const transcripts = claudeTranscriptsDir();
  const paths = (await claudeProjectPaths()).filter((path) => isAbsolute(path) && !isClaudeWorkspace(path) && isDirectory(path) && !isHomeOrRoot(path));
  const ranked = await Promise.all(paths.map(async (path, index) => ({ path: resolve(path), index, lastUsedAt: await lastSessionAt(transcripts, path) })));
  ranked.sort((a, b) => {
    if (a.lastUsedAt && b.lastUsedAt) return b.lastUsedAt.localeCompare(a.lastUsedAt) || a.index - b.index;
    if (a.lastUsedAt || b.lastUsedAt) return a.lastUsedAt ? -1 : 1;
    return a.index - b.index;
  });
  return ranked.slice(0, CLAUDE_LIMIT).map((row) => projectSummary(row.path, 'claude', row.lastUsedAt));
}

/** What the picker offers: the recent projects, then Claude Code's projects that are not already in that list. */
export async function listProjects(): Promise<ProjectSummary[]> {
  const recent = recentProjects();
  const known = new Set(recent.map((p) => p.path));
  const claude = (await claudeProjects()).filter((p) => !known.has(p.path));
  return [...recent, ...claude];
}

// The folder browser --------------------------------------------------------------------------------

export interface ListFolderOptions {
  /** Also list folders whose name starts with a dot (after the others). */
  hidden?: boolean;
}

/**
 * The subfolders of a folder for the folder browser: folders only (a symbolic link to a folder counts),
 * sorted by name, hidden ones only when asked for and then after the others. Never a file's name or contents.
 * Throws a RouteError with a sentence for a path that is not absolute, not a folder, or not readable.
 */
export async function listFolder(path: string, options: ListFolderOptions = {}): Promise<FolderListing> {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw new RouteError(400, 'The path must be absolute.');
  const folder = resolve(path);
  let entries;
  try {
    entries = await readdir(folder, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new RouteError(404, `${folder} does not exist.`);
    if (code === 'ENOTDIR') throw new RouteError(400, `${folder} is not a folder.`);
    if (code === 'EACCES' || code === 'EPERM') throw new RouteError(403, `Affice cannot read ${folder} (permission denied). Pick another folder.`);
    throw new RouteError(400, `${folder} could not be read.`);
  }
  const folders: FolderEntry[] = [];
  await Promise.all(
    entries.map(async (entry) => {
      if (entry.name.startsWith('.') && !options.hidden) return;
      const child = join(folder, entry.name);
      let isFolder = entry.isDirectory();
      if (!isFolder && entry.isSymbolicLink()) isFolder = isDirectory(child);
      if (!isFolder) return;
      const office = await access(officeLayout(child).configFile).then(
        () => true,
        () => false,
      );
      folders.push({ name: entry.name, path: child, hasOffice: office });
    }),
  );
  const byName = (a: FolderEntry, b: FolderEntry) => a.name.localeCompare(b.name);
  const visible = folders.filter((f) => !f.name.startsWith('.')).sort(byName);
  const hidden = folders.filter((f) => f.name.startsWith('.')).sort(byName);
  const parent = dirname(folder);
  return { path: folder, parent: parent === folder ? null : parent, folders: [...visible, ...hidden] };
}

/**
 * GET /api/projects: the recent projects, then Claude Code's. GET /api/fs?path=<absolute>[&hidden=1]: the
 * folder browser (default the home folder). Both answer local pages only: server/index.ts checks the Host
 * and the Origin of every request before any route runs.
 */
export function registerProjectRoutes(router: HttpRouter, _host: HostHandle): void {
  router.get('/api/projects', () => listProjects());
  router.get('/api/fs', ({ query }) => listFolder(query.get('path') || homedir(), { hidden: query.get('hidden') === '1' }));
}
