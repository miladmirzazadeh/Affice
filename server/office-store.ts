// The office's own state on disk: the config (the departments, seeded from fixtures/office.json on first
// run) and the chat history, one ChatMessage per line in <chatDir>/<department>.jsonl. For a project the
// host opens them at <project>/Office/affice.json and <project>/Office/chat; without those options they
// are <dataDir>/office.json and <dataDir>/chat.
//
// The general manager has no Trella board of its own: it and the Decisions view use the boards of the
// project's Trella workspace. Every manager may name knowledge folders (`knowledgeDirs`); the store only
// validates and keeps them, the driver applies the general manager's default when they are unset.
//
// Two rules for a file a person, a git clone or a manager can edit (the security review, SEC-04 and SEC-10):
//   - Nothing is written through a symbolic link: the config is replaced atomically through a temporary
//     file with a random name, chat lines are appended without following links (server/project/safe-fs.ts).
//   - The config is validated when it is loaded, not only when a form changes it. A field of the wrong type
//     or an unknown one is dropped, a department with an invalid id is skipped, an invalid color, model,
//     permission, working folder, session id or repo entry is repaired or dropped, and every such step is a
//     sentence in `store.problems` (and in the `log` option) for the host to show. A file that is not JSON,
//     or not an office at all, is kept as affice.json.corrupt-<time> and a fresh office is made. Nothing
//     in the file is ever run through a shell; the paths in it only reach spawn as arguments or as cwd.

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  DEPARTMENT_COLORS,
  GENERAL_ID,
  MODELS,
  isModelId,
  isSessionId,
  type ChatMessage,
  type Department,
  type DepartmentInput,
  type DepartmentPatch,
  type OfficeConfig,
  type PermissionPolicy,
  type RepoRef,
} from '../shared/types';
import { broadFolder, broadFolderMessage, DEFAULT_REPORT_DIR } from '../shared/folders';
import { PRIVATE_FILE, PRIVATE_FOLDER, UnsafePathError, appendFileSafe, ensureFolder, lstatOrNull, refuseUnlessPlainFile, writeFileAtomic } from './project/safe-fs';

export const CHAT_HISTORY = 200;
const ID = /^[a-z0-9-]{1,32}$/;
const POLICIES: PermissionPolicy[] = ['ask', 'accept-edits', 'read-only'];

export class ValidationError extends Error {}

/** A department id from its name: lower case ASCII letters, digits and single hyphens, at most 32. */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
}

/** The slug, or `department` for a name with no Latin letters (a name in another script, for example), made unique. */
export function uniqueId(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = slugify(name) || 'department';
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, 32 - suffix.length).replace(/-+$/g, '')}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** The lowest free room position, so a removed department's room is reused. */
export function nextSlot(departments: Pick<Department, 'slot'>[]): number {
  const used = new Set(departments.map((d) => d.slot));
  let slot = 0;
  while (used.has(slot)) slot += 1;
  return slot;
}

function text(value: unknown, field: string, max: number, errors: string[]): string {
  if (typeof value !== 'string' || !value.trim()) {
    errors.push(`${field} is required.`);
    return '';
  }
  if (value.trim().length > max) errors.push(`${field} is longer than ${max} characters.`);
  return value.trim();
}

const REPO_NAME_MAX = 60;
const PATH_MAX = 4096;
const BASE_MAX = 200;

/** Why a repo entry cannot be used, or null. A base that starts with `-` would be read by git as an option. */
function repoProblem(repo: Partial<RepoRef> | null | undefined): string | null {
  if (!repo || typeof repo !== 'object') return 'is not an object';
  if (typeof repo.name !== 'string' || !repo.name.trim() || repo.name.trim().length > REPO_NAME_MAX) return 'has no usable name';
  if (typeof repo.path !== 'string' || !repo.path.trim() || repo.path.length > PATH_MAX || repo.path.includes('\0')) return 'has no usable path';
  if (typeof repo.base !== 'string' || !repo.base.trim() || repo.base.trim().length > BASE_MAX || /[\u0000-\u001f\u007f]/.test(repo.base) || repo.base.trim().startsWith('-')) {
    return 'has no usable base branch (it must not start with a hyphen)';
  }
  return null;
}

/**
 * A sentence when `path` (relative ones from `base`) is the root of the disk or the user's home folder, or a
 * link that leads to one of them, else null. A report folder of `/` would let the report viewer serve any
 * .md or .html file on the machine, and a knowledge folder of the home folder would put all of it in reach of a manager.
 */
export function broadFolderProblem(label: string, path: string, base: string): string | null {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(base, path);
  const home = homedir();
  let reason = broadFolder(absolute, home);
  if (!reason) {
    try {
      reason = broadFolder(realpathSync.native(absolute), realpathSync.native(home));
    } catch {
      // the folder is not there (yet): it is judged by how it is written
    }
  }
  return reason ? broadFolderMessage(label, path, reason) : null;
}

/** Where relative paths start: report folders at the Office folder, repositories and knowledge folders at the project. */
interface FolderBases {
  office: string;
  project: string;
}

function repos(value: unknown, errors: string[], base: string): RepoRef[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) {
    errors.push('Repos must be a list of at most 50.');
    return [];
  }
  const names = new Set<string>();
  const out: RepoRef[] = [];
  for (const item of value) {
    const repo = item as Partial<RepoRef> | null;
    if (repoProblem(repo) !== null) {
      errors.push('Every repo needs a name, a path and a base branch (the base must not start with a hyphen).');
      continue;
    }
    if (!repo) continue;
    const broad = broadFolderProblem('A repository path', repo.path!.trim(), base);
    if (broad) {
      errors.push(broad);
      continue;
    }
    if (names.has(repo.name!.trim())) errors.push(`The repo name ${repo.name!.trim()} is used twice.`);
    names.add(repo.name!.trim());
    out.push({ name: repo.name!.trim(), path: repo.path!.trim(), base: repo.base!.trim() });
  }
  return out;
}

function reportDirs(value: unknown, errors: string[], base: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50 || value.some((d) => typeof d !== 'string' || !d.trim())) {
    errors.push('Report directories must be a list of paths.');
    return [];
  }
  const dirs = value.map((d: string) => d.trim());
  for (const dir of dirs) {
    const broad = broadFolderProblem('A report folder', dir, base);
    if (broad) errors.push(broad);
  }
  return dirs;
}

/** Folders a manager reads for context: at most 50 paths, absolute or relative to the project. */
export const KNOWLEDGE_DIRS_MAX = 50;
const KNOWLEDGE_DIR_MAX_LENGTH = 1000;

/** The knowledge folders in a department written by hand or by an older version: the valid ones, or undefined when none. */
function cleanKnowledgeDirs(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const dirs = value
    .filter((d): d is string => typeof d === 'string' && d.trim() !== '' && !d.includes('\0'))
    .map((d) => d.trim())
    .slice(0, KNOWLEDGE_DIRS_MAX);
  const unique = [...new Set(dirs)];
  return unique.length ? unique : undefined;
}

/** Validates a knowledgeDirs list from the form. An empty list means unset (the default applies). */
function knowledgeDirs(value: unknown, errors: string[], base: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > KNOWLEDGE_DIRS_MAX || value.some((d) => typeof d !== 'string' || d.includes('\0'))) {
    errors.push(`Knowledge folders must be a list of at most ${KNOWLEDGE_DIRS_MAX} paths.`);
    return undefined;
  }
  const dirs = (value as string[]).map((d) => d.trim()).filter(Boolean);
  if (dirs.some((d) => d.length > KNOWLEDGE_DIR_MAX_LENGTH)) {
    errors.push(`A knowledge folder path is longer than ${KNOWLEDGE_DIR_MAX_LENGTH} characters.`);
    return undefined;
  }
  for (const dir of dirs) {
    const broad = broadFolderProblem('A knowledge folder', dir, base);
    if (broad) errors.push(broad);
  }
  const unique = [...new Set(dirs)];
  return unique.length ? unique : undefined;
}

/** A relative working directory in the fixture (the usual `.`) means the office root. */
function seedCwd(cwd: string, root: string | undefined): string {
  return isAbsolute(cwd) ? cwd : resolve(root ?? process.cwd(), cwd);
}

function directory(value: unknown, errors: string[]): string {
  if (typeof value !== 'string' || !isAbsolute(value.trim())) {
    errors.push('The working directory must be an absolute path.');
    return '';
  }
  const path = value.trim();
  try {
    if (!statSync(path).isDirectory()) errors.push(`${path} is not a directory.`);
  } catch {
    errors.push(`${path} does not exist.`);
  }
  return path;
}

// Validation on load (SEC-10) -----------------------------------------------------------------------

const TOP_FIELDS = new Set(['version', 'company', 'trellaUrl', 'departments']);
const DEPARTMENT_FIELDS = new Set([
  'id', 'kind', 'knowledgeDirs', 'name', 'color', 'responsibility', 'cwd', 'model', 'permission',
  'repos', 'reportDirs', 'trellaBoardId', 'sessionId', 'slot', 'createdAt',
]);
const BOARD_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_DEPARTMENTS = 100;
const MAX_PROBLEMS = 40;
/** A larger affice.json is not an office anyone wrote by hand. */
const MAX_CONFIG_BYTES = 10 * 1024 * 1024;
const DEFAULT_RESPONSIBILITY = 'No responsibility has been written for this department yet. Ask the user what it should do.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A name from the file, safe to put in a sentence: printable, short. */
function shown(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  return text.replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 40);
}

/** "the color is missing" for an absent value, "the color teal is not one of ..." for a wrong one. */
function wrong(label: string, value: unknown, rule: string): string {
  return value === undefined ? `the ${label} is missing` : `the ${label} ${shown(value)} is not ${rule}`;
}

function nameList(names: string[]): string {
  const first = names.slice(0, 5).map(shown).join(', ');
  return names.length > 5 ? `${first} and ${names.length - 5} more` : first;
}

/** Trella's address in the file: http on this machine only. Anything else would send the Kanban view to another site. */
function isLocalTrellaUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 200) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

interface SanitizeContext {
  /** The fixture the defaults come from. */
  fixture: OfficeConfig;
  /** The office name when the file has none that is usable. */
  company: string;
  /** Where a relative working folder starts. */
  root: string | undefined;
  /** The working folder of a department whose own is unusable. */
  cwdDefault: string;
  now: string;
}

interface Sanitized {
  config: OfficeConfig;
  /** One sentence for each thing that was dropped, repaired or skipped, and each working folder that is missing. */
  problems: string[];
  /** True when something of the file's content was lost (not just read differently): the original is kept and the file rewritten. */
  lossy: boolean;
}

/** A department from the file, or null (with a sentence in `problems`) when it cannot be kept. */
function cleanDepartment(raw: unknown, position: number, ctx: SanitizeContext, problems: string[], flag: () => void): Department | null {
  if (!isRecord(raw)) {
    problems.push(`Department ${position + 1} is not an object and was skipped.`);
    flag();
    return null;
  }
  if (typeof raw.id !== 'string' || !ID.test(raw.id)) {
    problems.push(`Department ${position + 1} has no valid id (1 to 32 characters: a to z, 0 to 9 and hyphens) and was skipped.`);
    flag();
    return null;
  }
  const id = raw.id;
  const problemsBefore = problems.length;
  // Every repair of this department goes into one sentence, so a file full of broken departments stays readable.
  const fixes: string[] = [];
  const repair = (what: string, to: string) => {
    fixes.push(`${what}, so ${to}`);
    flag();
  };

  const extra = Object.keys(raw).filter((key) => !DEPARTMENT_FIELDS.has(key));
  if (extra.length) {
    fixes.push(`fields Affice does not know were dropped (${nameList(extra)})`);
    flag();
  }

  let kind: Department['kind'];
  if (raw.kind === 'room' || raw.kind === 'lobby') kind = raw.kind;
  else if (raw.kind !== undefined) repair('the kind is not room or lobby', 'it is left out (a room)');

  let name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name || name.length > 60) {
    repair('the name is missing or longer than 60 characters', `it is called ${id}`);
    name = id;
  }

  let color = raw.color as Department['color'];
  if (!DEPARTMENT_COLORS.includes(color as never)) {
    repair(wrong('color', raw.color, `one of ${DEPARTMENT_COLORS.join(', ')}`), 'it is stone');
    color = 'stone';
  }

  let responsibility: string;
  if (typeof raw.responsibility !== 'string' || !raw.responsibility.trim()) {
    repair('the responsibility is missing', 'a placeholder was put in its place');
    responsibility = DEFAULT_RESPONSIBILITY;
  } else if (raw.responsibility.length > 20_000) {
    repair('the responsibility is longer than 20000 characters', 'it was cut');
    responsibility = raw.responsibility.slice(0, 20_000);
  } else {
    responsibility = raw.responsibility;
  }

  let cwd: string;
  if (typeof raw.cwd !== 'string' || !raw.cwd.trim() || raw.cwd.length > PATH_MAX || raw.cwd.includes('\0')) {
    repair('the working folder is missing or not a path', 'it works in the project folder');
    cwd = ctx.cwdDefault;
  } else {
    cwd = seedCwd(raw.cwd.trim(), ctx.root);
    if (!directoryExists(cwd)) problems.push(`${id}: the working folder ${cwd} does not exist. Fix it in the department's settings.`);
  }

  let model = raw.model as string;
  if (!isModelId(model)) {
    repair(wrong('model', raw.model, 'an alias (opus, sonnet, haiku) or a claude-... id'), 'it uses sonnet');
    model = 'sonnet';
  }

  let permission = raw.permission as PermissionPolicy;
  if (!POLICIES.includes(permission)) {
    repair(wrong('permission', raw.permission, `one of ${POLICIES.join(', ')}`), 'it asks before every action');
    permission = 'ask';
  }

  // A repo path, report folder or knowledge folder that is the root of the disk or the home folder is dropped, not kept.
  const tooBroad: string[] = [];
  const isBroad = (path: string, base: string): boolean => {
    if (broadFolderProblem('', path, base) === null) return false;
    tooBroad.push(path);
    return true;
  };
  const officeBase = ctx.root ?? ctx.cwdDefault;

  const kept: RepoRef[] = [];
  if (raw.repos !== undefined) {
    if (!Array.isArray(raw.repos)) repair('the repos are not a list', 'there are none');
    else {
      const seen = new Set<string>();
      let dropped = 0;
      for (const item of raw.repos.slice(0, 50)) {
        const repo = item as Partial<RepoRef>;
        if (repoProblem(repo) !== null || seen.has(repo.name!.trim())) {
          dropped += 1;
          continue;
        }
        if (isBroad(repo.path!.trim(), ctx.cwdDefault)) continue;
        seen.add(repo.name!.trim());
        kept.push({ name: repo.name!.trim(), path: repo.path!.trim(), base: repo.base!.trim() });
      }
      dropped += Math.max(0, raw.repos.length - 50);
      if (dropped) repair(`${dropped} repo ${dropped === 1 ? 'entry' : 'entries'} had no usable name, path or base branch, or repeated a name`, 'they were dropped');
    }
  }

  const reportDirs: string[] = [];
  if (raw.reportDirs !== undefined) {
    if (!Array.isArray(raw.reportDirs)) repair('the report folders are not a list', 'there are none');
    else {
      let notPaths = 0;
      for (const item of raw.reportDirs.slice(0, 50)) {
        if (typeof item !== 'string' || !item.trim() || item.length > PATH_MAX || item.includes('\0')) notPaths += 1;
        else if (!isBroad(item.trim(), officeBase)) reportDirs.push(item.trim());
      }
      notPaths += Math.max(0, raw.reportDirs.length - 50);
      if (notPaths > 0) repair(`${notPaths} report folder ${notPaths === 1 ? 'entry was' : 'entries were'} not a path`, 'dropped');
    }
  }

  let knowledge = cleanKnowledgeDirs(raw.knowledgeDirs);
  if (raw.knowledgeDirs !== undefined && raw.knowledgeDirs !== null) {
    const broken = !Array.isArray(raw.knowledgeDirs) || raw.knowledgeDirs.some((d) => typeof d !== 'string' || !d.trim() || d.includes('\0'));
    if (broken) repair('the knowledge folders contained something that is not a path', 'only the valid paths were kept');
  }
  if (knowledge) {
    const fine = knowledge.filter((dir) => !isBroad(dir, ctx.cwdDefault));
    knowledge = fine.length ? fine : undefined;
  }
  if (tooBroad.length) {
    repair(`${nameList(tooBroad)} ${tooBroad.length === 1 ? 'is' : 'are'} the root of the disk or your home folder, which is too broad`, tooBroad.length === 1 ? 'it was dropped' : 'they were dropped');
  }

  let trellaBoardId: string | null = null;
  if (raw.trellaBoardId !== undefined && raw.trellaBoardId !== null) {
    if (typeof raw.trellaBoardId === 'string' && BOARD_ID.test(raw.trellaBoardId)) trellaBoardId = raw.trellaBoardId;
    else repair('the Trella board id is not an id', 'the department has no board');
  }

  let sessionId: string | null = null;
  if (raw.sessionId !== undefined && raw.sessionId !== null) {
    if (isSessionId(raw.sessionId)) sessionId = raw.sessionId;
    else repair('the session id is not a session id', 'the manager starts a new conversation');
  }

  // A slot that is not a whole number is assigned later, once every department is known.
  const slot = kind === 'lobby' || id === GENERAL_ID ? -1 : Number.isInteger(raw.slot) && (raw.slot as number) >= 0 && (raw.slot as number) < 10_000 ? (raw.slot as number) : Number.NaN;

  let createdAt = raw.createdAt as string;
  if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) {
    repair('the creation date is missing or not a date', 'it is today');
    createdAt = ctx.now;
  }

  if (fixes.length) problems.splice(problemsBefore, 0, `${id}: ${fixes.join('; ')}.`);
  return {
    id,
    ...(kind ? { kind } : {}),
    ...(knowledge ? { knowledgeDirs: knowledge } : {}),
    name,
    color,
    responsibility,
    cwd,
    model,
    permission,
    repos: kept,
    reportDirs,
    trellaBoardId,
    sessionId,
    slot,
    createdAt,
  };
}

function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The office in a parsed affice.json, made safe to use. Returns null for a value that is not an office at
 * all (not an object, or `departments` is not a list): the caller keeps the file and starts a new one.
 */
export function sanitizeOfficeConfig(value: unknown, ctx: SanitizeContext): Sanitized | null {
  if (!isRecord(value)) return null;
  if (value.departments !== undefined && !Array.isArray(value.departments)) return null;
  const problems: string[] = [];
  let lossy = false;
  const flag = () => {
    lossy = true;
  };

  const extra = Object.keys(value).filter((key) => !TOP_FIELDS.has(key));
  if (extra.length) {
    problems.push(`Fields Affice does not know were dropped from the office (${nameList(extra)}).`);
    flag();
  }
  if (value.version !== undefined && value.version !== 1) {
    problems.push(`The office file says version ${shown(value.version)}, which this Affice does not know. It was read as version 1.`);
    flag();
  }
  let company = typeof value.company === 'string' ? value.company.trim() : '';
  if (!company || company.length > 200) {
    if (value.company !== undefined) {
      problems.push('The office name is missing or too long, so the folder name is used.');
      flag();
    }
    company = ctx.company;
  }
  let trellaUrl = value.trellaUrl;
  if (!isLocalTrellaUrl(trellaUrl)) {
    if (trellaUrl !== undefined) {
      problems.push(`The Trella address ${shown(trellaUrl)} is not an address on this machine, so the default is used.`);
      flag();
    }
    trellaUrl = ctx.fixture.trellaUrl;
  }

  const raw = (value.departments ?? []) as unknown[];
  if (raw.length > MAX_DEPARTMENTS) {
    problems.push(`The office lists ${raw.length} departments; only the first ${MAX_DEPARTMENTS} were kept.`);
    flag();
  }
  const departments: Department[] = [];
  const ids = new Set<string>();
  raw.slice(0, MAX_DEPARTMENTS).forEach((item, position) => {
    const department = cleanDepartment(item, position, ctx, problems, flag);
    if (!department) return;
    if (ids.has(department.id)) {
      problems.push(`The department ${department.id} appears twice; the second one was skipped.`);
      flag();
      return;
    }
    ids.add(department.id);
    departments.push(department);
  });
  for (const department of departments) {
    if (Number.isNaN(department.slot)) {
      department.slot = nextSlot(departments.filter((d) => !Number.isNaN(d.slot)));
      problems.push(`${department.id}: the room position was missing, so it got room ${department.slot}.`);
      flag();
    }
  }
  if (problems.length > MAX_PROBLEMS) problems.splice(MAX_PROBLEMS, problems.length - MAX_PROBLEMS, `${problems.length - MAX_PROBLEMS} more problems of the same kind were left out.`);
  return { config: { version: 1, company, trellaUrl: trellaUrl as string, departments }, problems, lossy };
}

/** The problems of a load as one sentence for the browser: the first few, then how many more. */
export function summarizeProblems(problems: string[], limit = 4): string {
  if (problems.length === 0) return '';
  const shownLines = problems.slice(0, limit).join(' ');
  const rest = problems.length - limit;
  return rest > 0 ? `${shownLines} And ${rest} more (see the log).` : shownLines;
}

export interface OfficeStoreOptions {
  /** Where the config and the chat live unless configFile and chatDir say otherwise. */
  dataDir: string;
  fixture: string;
  /** The office root: the folder that holds .agentboard. A relative cwd in the fixture starts here. */
  root?: string;
  /** The config file; default <dataDir>/office.json. */
  configFile?: string;
  /** The chat history folder; default <dataDir>/chat. */
  chatDir?: string;
  /** The office name for a file that has none (or is made new): the project folder's name. Default the fixture's. */
  company?: string;
  /** The working folder of a department whose own is unusable, and of a general manager made again: the project folder. Default `root`. */
  cwdDefault?: string;
  /** Called with each problem found while loading (see `problems`). */
  log?: (line: string) => void;
}

/** The office in the config file: the sanitized one, or a new one (the general manager only) when the file is not an office. */
function readOffice(file: string, ctx: SanitizeContext): { config: OfficeConfig; problems: string[]; keep: boolean; reason: string | null } {
  let reason: string | null = null;
  if (statSync(file).size > MAX_CONFIG_BYTES) {
    reason = `it is larger than ${MAX_CONFIG_BYTES / 1024 / 1024} MB`;
  } else {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      reason = `it is not valid JSON: ${(error as Error).message}`;
    }
    if (!reason) {
      const clean = sanitizeOfficeConfig(value, ctx);
      if (clean) return { config: clean.config, problems: clean.problems, keep: clean.lossy, reason: null };
      reason = 'it is not an office (an object with a list of departments)';
    }
  }
  const config: OfficeConfig = { version: 1, company: ctx.company, trellaUrl: ctx.fixture.trellaUrl, departments: [] };
  return { config, problems: [], keep: true, reason: `The office file could not be used (${reason}), so a new office was made with the general manager only.` };
}

/** Moves the config file aside as <file>.corrupt-<time> (never over another file) and returns the new name. */
function keepOriginal(file: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let target = `${file}.corrupt-${stamp}`;
  for (let n = 2; lstatOrNull(target); n += 1) target = `${file}.corrupt-${stamp}-${n}`;
  renameSync(file, target);
  return target;
}

/**
 * One chat line from disk. History files written before the chat role `founder` was renamed `user` still say
 * `founder`: it is read as `user`, so an old office keeps its conversation and the page never sees the old name.
 */
export function readChatLine(line: string): ChatMessage {
  const message = JSON.parse(line) as ChatMessage;
  if (message && typeof message === 'object' && (message.role as string) === 'founder') message.role = 'user';
  return message;
}

export class OfficeStore {
  /** What was dropped, repaired or skipped while loading the config, as sentences for the user. Empty for a clean file. */
  readonly problems: string[] = [];
  private logLine: ((line: string) => void) | undefined;

  private constructor(
    private readonly configFile: string,
    private readonly chatDir: string,
    public config: OfficeConfig,
    private readonly bases: FolderBases,
  ) {}

  /**
   * Reads the config, creating it from the fixture on first run, and makes sure the lobby's general
   * manager exists (from the fixture). The general manager has no board of its own.
   *
   * The file is validated (sanitizeOfficeConfig): what cannot be kept is dropped or repaired and named in
   * `problems`; then the original is kept as affice.json.corrupt-<time> and the repaired config is saved. A
   * file that is not an office at all is kept the same way and a new office (the general manager only) is made.
   * A config file that is a symbolic link is refused: Affice would write the office back through it.
   */
  static open(options: OfficeStoreOptions): OfficeStore {
    const file = options.configFile ?? join(options.dataDir, 'office.json');
    const chatDir = options.chatDir ?? join(options.dataDir, 'chat');
    const folder = dirname(file);
    if (lstatOrNull(folder)?.isSymbolicLink()) {
      throw new UnsafePathError(`The office folder (${folder}) is a symbolic link. Affice never writes through symbolic links. Replace it with a real folder, then open the project again.`);
    }
    mkdirSync(folder, { recursive: true });
    refuseUnlessPlainFile(file, 'The office file');

    const fixture = JSON.parse(readFileSync(options.fixture, 'utf8')) as OfficeConfig;
    const context: SanitizeContext = {
      fixture,
      company: options.company?.trim() || fixture.company,
      root: options.root,
      cwdDefault: options.cwdDefault ?? options.root ?? process.cwd(),
      now: new Date().toISOString(),
    };
    const seeded = !lstatOrNull(file);
    let config: OfficeConfig;
    let problems: string[] = [];
    let keep = false;
    if (seeded) {
      config = JSON.parse(readFileSync(options.fixture, 'utf8')) as OfficeConfig;
      config.departments = (config.departments ?? []).filter((d) => ID.test(d.id));
      for (const d of config.departments) {
        d.cwd = seedCwd(d.cwd, options.root);
        const dirs = cleanKnowledgeDirs(d.knowledgeDirs);
        if (dirs) d.knowledgeDirs = dirs;
        else delete d.knowledgeDirs;
      }
    } else {
      const loaded = readOffice(file, context);
      config = loaded.config;
      problems = loaded.problems;
      keep = loaded.keep;
      if (loaded.reason) problems.unshift(loaded.reason);
    }

    const store = new OfficeStore(file, chatDir, config, { office: options.root ?? options.cwdDefault ?? process.cwd(), project: options.cwdDefault ?? options.root ?? process.cwd() });
    const changed = store.ensureGeneral(options.fixture, options.cwdDefault ?? options.root);
    // Keep the original before the file is replaced, so a repair never loses what a person wrote.
    if (keep) {
      const kept = keepOriginal(file);
      problems.push(`The original file was kept as ${basename(kept)}.`);
    }
    store.logLine = options.log;
    for (const line of problems) store.note(line);
    if (seeded || changed || keep) store.save();
    return store;
  }

  /** Records a problem once, for the host to show, and logs it. */
  private note(line: string): void {
    if (this.problems.includes(line)) return;
    this.problems.push(line);
    this.logLine?.(`The office files of this project: ${line}`);
  }

  /** Adds the general manager when it is missing and keeps it a lobby. True when the config changed. */
  private ensureGeneral(fixture: string, root: string | undefined): boolean {
    let general = this.byId(GENERAL_ID);
    let changed = false;
    if (!general) {
      const seed = (JSON.parse(readFileSync(fixture, 'utf8')) as OfficeConfig).departments?.find((d) => d.id === GENERAL_ID);
      if (!seed) throw new Error(`${fixture} has no ${GENERAL_ID} department to seed the general manager from.`);
      general = { ...seed, cwd: seedCwd(seed.cwd, root), sessionId: null };
      this.config.departments.push(general);
      changed = true;
    }
    if (general.kind !== 'lobby' || general.slot !== -1) {
      general.kind = 'lobby';
      general.slot = -1;
      changed = true;
    }
    return changed;
  }

  departments(): Department[] {
    return [...this.config.departments].sort((a, b) => a.slot - b.slot);
  }

  byId(id: string): Department | null {
    return this.config.departments.find((d) => d.id === id) ?? null;
  }

  save(): void {
    // Private to the user: it holds the session ids and the instructions of every manager.
    writeFileAtomic(this.configFile, `${JSON.stringify(this.config, null, 2)}\n`, 'The office file', PRIVATE_FILE);
  }

  /** Every problem with the input, as sentences for the form. */
  validateInput(input: DepartmentInput): string[] {
    return this.check(input, null).errors;
  }

  create(input: DepartmentInput, trellaBoardId: string | null, now = new Date().toISOString()): Department {
    const { errors, fields } = this.check(input, null);
    if (errors.length) throw new ValidationError(errors.join(' '));
    const department: Department = {
      id: uniqueId(fields.name!, this.config.departments.map((d) => d.id)),
      name: fields.name!,
      color: fields.color!,
      responsibility: fields.responsibility!,
      cwd: fields.cwd!,
      model: fields.model!,
      permission: fields.permission!,
      repos: fields.repos ?? [],
      // A new department with no report folder gets the default one; an explicit list is kept as it is.
      reportDirs: fields.reportDirs?.length ? fields.reportDirs : [DEFAULT_REPORT_DIR],
      ...(fields.knowledgeDirs ? { knowledgeDirs: fields.knowledgeDirs } : {}),
      trellaBoardId,
      sessionId: null,
      slot: nextSlot(this.config.departments),
      createdAt: now,
    };
    this.config.departments.push(department);
    this.save();
    return department;
  }

  update(id: string, patch: DepartmentPatch): Department {
    const index = this.config.departments.findIndex((d) => d.id === id);
    if (index < 0) throw new ValidationError('There is no such department.');
    const { errors, fields } = this.check(patch, id);
    if (errors.length) throw new ValidationError(errors.join(' '));
    const updated: Department = { ...this.config.departments[index], ...fields };
    // An empty list clears the folders, so the default applies again.
    if (patch.knowledgeDirs !== undefined && !fields.knowledgeDirs) delete updated.knowledgeDirs;
    this.config.departments[index] = updated;
    this.save();
    return updated;
  }

  setSessionId(id: string, sessionId: string | null): void {
    const department = this.byId(id);
    if (!department || department.sessionId === sessionId) return;
    department.sessionId = sessionId;
    this.save();
  }

  /** Removes the department. Its chat history is kept, renamed, so a new department with the same id starts clean. */
  remove(id: string): boolean {
    if (this.byId(id)?.kind === 'lobby') throw new ValidationError('The general manager cannot be removed.');
    const before = this.config.departments.length;
    this.config.departments = this.config.departments.filter((d) => d.id !== id);
    if (this.config.departments.length === before) return false;
    this.save();
    const chat = this.chatFile(id);
    // A chat folder that is a link is not touched: the history stays where it is.
    if (!lstatOrNull(this.chatDir)?.isSymbolicLink() && existsSync(chat)) renameSync(chat, chat.replace(/\.jsonl$/, `.removed-${Date.now()}.jsonl`));
    return true;
  }

  /** Appends a chat line. The chat folder must be a real folder next to the config and the file a regular one: nothing is written through a link. */
  appendChat(message: ChatMessage): void {
    const file = this.chatFile(message.department);
    ensureFolder(this.chatDir, realpathSync(dirname(this.chatDir)), 'The chat folder', PRIVATE_FOLDER);
    appendFileSafe(file, `${JSON.stringify({ ...message, streaming: false })}\n`, 'The chat file', PRIVATE_FILE);
  }

  loadChat(department: string, limit = CHAT_HISTORY): ChatMessage[] {
    const file = this.chatFile(department);
    // A chat folder or file that is a link is not read: what it leads to is not this office's history.
    if (lstatOrNull(this.chatDir)?.isSymbolicLink() || lstatOrNull(file)?.isSymbolicLink()) {
      this.note(`The chat history of ${department} was not read: ${lstatOrNull(this.chatDir)?.isSymbolicLink() ? this.chatDir : file} is a symbolic link.`);
      return [];
    }
    if (!existsSync(file)) return [];
    const messages: ChatMessage[] = [];
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        messages.push(readChatLine(line));
      } catch {
        // a torn last line after a crash: skip it
      }
    }
    return messages.slice(-limit);
  }

  private chatFile(department: string): string {
    if (!ID.test(department)) throw new ValidationError(`Not a department id: ${department}`);
    return join(this.chatDir, `${department}.jsonl`);
  }

  /** Validates the fields present (all of them for a new department, `self` is null then). */
  private check(input: DepartmentPatch, self: string | null): { errors: string[]; fields: DepartmentPatch } {
    const errors: string[] = [];
    const fields: DepartmentPatch = {};
    const creating = self === null;
    if (!input || typeof input !== 'object') return { errors: ['The department is missing.'], fields };
    // The lobby has one general manager, made by the server; a department is always a room.
    if (creating && (input as { kind?: unknown }).kind !== undefined && (input as { kind?: unknown }).kind !== 'room') {
      errors.push('There is only one lobby: a new department is always a room.');
    }
    if (creating || input.name !== undefined) {
      fields.name = text(input.name, 'The name', 60, errors);
      const clash = this.config.departments.find((d) => d.id !== self && d.name.toLowerCase() === fields.name!.toLowerCase());
      if (fields.name && clash) errors.push(`A department called ${clash.name} already exists.`);
    }
    if (creating || input.color !== undefined) {
      if (!DEPARTMENT_COLORS.includes(input.color as never)) errors.push(`The color must be one of ${DEPARTMENT_COLORS.join(', ')}.`);
      else fields.color = input.color;
    }
    if (creating || input.responsibility !== undefined) fields.responsibility = text(input.responsibility, 'The responsibility', 20_000, errors);
    if (creating || input.cwd !== undefined) fields.cwd = directory(input.cwd, errors);
    if (creating || input.model !== undefined) {
      if (!isModelId(input.model)) errors.push(`The model must be one of ${Object.keys(MODELS).join(', ')}, or a full model id such as claude-sonnet-4-5.`);
      else fields.model = input.model;
    }
    if (creating || input.permission !== undefined) {
      if (!POLICIES.includes(input.permission as PermissionPolicy)) errors.push(`The permission policy must be one of ${POLICIES.join(', ')}.`);
      else fields.permission = input.permission;
    }
    if (input.repos !== undefined) fields.repos = repos(input.repos, errors, this.bases.project);
    if (input.reportDirs !== undefined) fields.reportDirs = reportDirs(input.reportDirs, errors, this.bases.office);
    if (input.knowledgeDirs !== undefined) fields.knowledgeDirs = knowledgeDirs(input.knowledgeDirs, errors, this.bases.project);
    return { errors, fields };
  }
}
