// Read-only git for the Branches view. It never fetches and never writes: every call carries
// GIT_OPTIONAL_LOCKS=0 and --no-optional-locks, so an agent committing in a worktree never
// collides with a status read made here.
//
// A repository's own config is data from outside (SEC-16): git runs programs named in it
// (core.fsmonitor on every status, a clean filter named in .git/config and attached to a file by
// .gitattributes or .git/info/attributes), and a manager with edit rights, a downloaded archive or a
// shared folder can change it. So every call runs with:
//   - the config that starts programs overridden on the command line (GIT_HARDENING), which wins over
//     any file; the filters a repo names are found with a read-only `git config` query and blanked too,
//   - GIT_CONFIG_NOSYSTEM=1, GIT_TERMINAL_PROMPT=0, GIT_OPTIONAL_LOCKS=0, no pager,
//   - the minimal environment of server/env.ts (no credentials, no GIT_* variables of the user's shell).

import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { broadFolder } from '../../shared/folders';
import { minimalEnv } from '../env';
import {
  parseCardKey,
  type BranchInfo,
  type BranchState,
  type BranchesView,
  type RepoBranches,
  type RepoRef,
} from '../../shared/types';

export const STALE_DAYS = 7;

/** Trunk names. They are the line (the base) or sit on it, never a station of work. */
export const LONG_LIVED = ['main', 'master', 'deploy'];

const SNAPSHOT_TTL_MS = 10_000;
const GIT_TIMEOUT_MS = 20_000;
const MAX_PARALLEL = 6;
const CACHE_LIMIT = 5000;
const DAY_MS = 86_400_000;

export interface BranchOptions {
  /** Bypass the 10 s snapshot cache. The per-tip results stay cached: a sha pair cannot go stale. */
  refresh?: boolean;
  /** For tests. */
  now?: Date;
}

/** A repo problem a person can act on (missing folder, not git, base branch absent). */
class RepoProblem extends Error {}

class GitError extends Error {
  constructor(
    args: string[],
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(`git ${args[0] ?? ''} failed: ${stderr.trim().split('\n')[0] ?? ''}`.trim());
  }
}

// ---------------------------------------------------------------------------------------------
// Running git: at most MAX_PARALLEL processes at once, read-only environment.

let active = 0;
const waiting: Array<() => void> = [];

async function limited<T>(job: () => Promise<T>): Promise<T> {
  if (active >= MAX_PARALLEL) await new Promise<void>((release) => waiting.push(release));
  else active += 1;
  try {
    return await job();
  } finally {
    const next = waiting.shift();
    if (next) next(); // the slot passes straight to the next waiter
    else active -= 1;
  }
}

/** The environment of every git call: the allow list of server/env.ts plus read-only settings. No user variable is passed on. */
export function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return minimalEnv(
    {
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_PAGER: 'cat',
      LC_ALL: 'C',
    },
    base,
  );
}

/** Config that starts a program, set on the command line so no config file (the repository's included) can change it. */
export const GIT_HARDENING = [
  '--no-optional-locks',
  '--no-pager',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.sshCommand=false',
  '-c', 'protocol.ext.allow=never',
];

/**
 * `-c` pairs that switch off every filter command the repository's config names (filter.<name>.clean,
 * .smudge, .process): `git status` runs a clean filter to compare a file with the index, and an empty
 * command means "no filter". Found with a read-only config query, which runs nothing.
 */
async function filterOverrides(cwd: string): Promise<string[]> {
  let output: string;
  try {
    output = await git(cwd, ['config', '-z', '--name-only', '--get-regexp', '^filter\\..+\\.(clean|smudge|process)$']);
  } catch {
    return []; // exit 1: the repository names no filter
  }
  return output
    .split('\0')
    .filter(Boolean)
    .flatMap((key) => ['-c', `${key}=`]);
}

function git(cwd: string, args: string[], config: string[] = []): Promise<string> {
  return limited(
    () =>
      new Promise<string>((done, fail) => {
        execFile(
          'git',
          [...GIT_HARDENING, ...config, '-C', cwd, ...args],
          { env: gitEnv(), timeout: GIT_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
          (error, stdout, stderr) => {
            if (!error) return done(stdout);
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') return fail(new RepoProblem('git is not installed or not on the PATH.'));
            const killed = (error as { killed?: boolean }).killed === true;
            fail(new GitError(args, killed ? `timed out after ${GIT_TIMEOUT_MS / 1000} s` : String(stderr), typeof code === 'number' ? code : null));
          },
        );
      }),
  );
}

// ---------------------------------------------------------------------------------------------
// Caches. Per tip sha: ahead and behind, and the cherry verdict (they never change for a pair of
// shas). Per repo: the whole snapshot for 10 s, shared by concurrent requests.

const countsCache = new Map<string, { ahead: number; behind: number }>();
const cherryCache = new Map<string, boolean>();
const snapshots = new Map<string, { at: number; promise: Promise<RepoBranches> }>();

function remember<V>(cache: Map<string, V>, key: string, value: V): V {
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, value);
  return value;
}

export function clearGitCaches(): void {
  countsCache.clear();
  cherryCache.clear();
  snapshots.clear();
}

// ---------------------------------------------------------------------------------------------
// Public entry point.

export async function readBranches(repos: RepoRef[], project: string, options: BranchOptions = {}): Promise<BranchesView> {
  const taken = await Promise.all(repos.map((repo) => snapshot(repo, project, options)));
  const oldest = Math.min(Date.now(), ...taken.map((entry) => entry.at));
  return {
    generatedAt: new Date(oldest).toISOString(),
    staleDays: STALE_DAYS,
    repos: taken.map((entry) => entry.value),
  };
}

/** A repository path as an absolute path: relative ones start at `project`, the folder around Office, so `.` is the project. */
function repoPath(repo: RepoRef, project: string): string {
  return isAbsolute(repo.path) ? repo.path : resolve(project, repo.path);
}

async function snapshot(repo: RepoRef, project: string, options: BranchOptions): Promise<{ at: number; value: RepoBranches }> {
  const path = repoPath(repo, project);
  const key = [repo.name, path, repo.base].join('\0');
  const cached = snapshots.get(key);
  if (!options.refresh && cached && Date.now() - cached.at < SNAPSHOT_TTL_MS) {
    return { at: cached.at, value: await cached.promise };
  }
  const entry = { at: Date.now(), promise: readRepo(repo, path, options.now ?? new Date()) };
  snapshots.set(key, entry);
  return { at: entry.at, value: await entry.promise };
}

/** Never rejects: a repo that cannot be read comes back with ok false and a message. */
async function readRepo(repo: RepoRef, path: string, now: Date): Promise<RepoBranches> {
  const result: RepoBranches = { name: repo.name, path, base: repo.base, ok: false, error: null, branches: [] };
  try {
    const found = await collect(repo, path, now);
    result.branches = found.branches;
    // A folder inside a repository is read as that repository: the path shown is the one that was read.
    result.path = found.path;
    result.ok = true;
  } catch (error) {
    result.error =
      error instanceof RepoProblem ? error.message : `git failed in ${path}: ${error instanceof Error ? error.message : String(error)}`;
  }
  return result;
}

// ---------------------------------------------------------------------------------------------

interface RefRow {
  name: string;
  sha: string;
  at: Date;
  author: string;
  subject: string;
}

const REF_FORMAT = '%(refname)%00%(objectname)%00%(committerdate:iso-strict)%00%(authorname)%00%(subject)';

function parseRefs(output: string): RefRow[] {
  const rows: RefRow[] = [];
  for (const line of output.split('\n')) {
    const [ref, sha, date, author, ...subject] = line.split('\0');
    if (!ref?.startsWith('refs/heads/') || !sha) continue;
    const at = new Date(date ?? '');
    rows.push({
      name: ref.slice('refs/heads/'.length),
      sha,
      at: Number.isNaN(at.getTime()) ? new Date(0) : at,
      author: author ?? '',
      subject: subject.join('\0').replace(/\r/g, ''),
    });
  }
  return rows;
}

async function resolveSha(cwd: string, rev: string): Promise<string | null> {
  // A name from the office file that starts with a hyphen would be read by git as an option.
  if (rev.startsWith('-')) return null;
  try {
    return (await git(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])).trim() || null;
  } catch (error) {
    // --quiet: exit 1 without a message means "no such revision"
    if (error instanceof GitError && error.exitCode === 1 && !error.stderr.trim()) return null;
    throw error;
  }
}

async function aheadBehind(cwd: string, baseSha: string, tipSha: string): Promise<{ ahead: number; behind: number }> {
  const key = [cwd, baseSha, tipSha].join('\0');
  const hit = countsCache.get(key);
  if (hit) return hit;
  const [behind, ahead] = (await git(cwd, ['rev-list', '--left-right', '--count', `${baseSha}...${tipSha}`])).trim().split(/\s+/).map(Number);
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) throw new GitError(['rev-list'], 'unreadable count', null);
  return remember(countsCache, key, { ahead, behind });
}

/** Names of the local branches whose tip is already inside `sha`. */
async function mergedInto(cwd: string, sha: string): Promise<Set<string>> {
  const output = await git(cwd, ['branch', '--merged', sha, '--format=%(refname)']);
  const names = output
    .split('\n')
    .filter((line) => line.startsWith('refs/heads/'))
    .map((line) => line.slice('refs/heads/'.length));
  return new Set(names);
}

/** True when every commit of the tip has a patch-equivalent on the target (git cherry: all lines start with "-"). */
async function patchEquivalent(cwd: string, targetSha: string, tipSha: string): Promise<boolean> {
  const key = [cwd, targetSha, tipSha].join('\0');
  const hit = cherryCache.get(key);
  if (hit !== undefined) return hit;
  const lines = (await git(cwd, ['cherry', targetSha, tipSha])).split('\n').filter(Boolean);
  return remember(cherryCache, key, lines.length > 0 && lines.every((line) => line.startsWith('-')));
}

interface Tree {
  path: string;
  dirty: number | null;
}

async function dirtyCount(path: string): Promise<number | null> {
  try {
    await stat(path);
    // --ignore-submodules=dirty: git does not start a `git status` of its own inside each submodule (its config is another file to trust).
    const output = await git(path, ['status', '--porcelain', '--ignore-submodules=dirty'], await filterOverrides(path));
    return output.split('\n').filter(Boolean).length;
  } catch {
    return null;
  }
}

/** Branch name to the worktree it is checked out in, with that worktree's dirty count. Prunable entries (folder gone) and detached ones are left out. */
async function readWorktrees(cwd: string): Promise<Map<string, Tree>> {
  const output = await git(cwd, ['worktree', 'list', '--porcelain']);
  const trees = new Map<string, Tree>();
  const counting: Array<Promise<void>> = [];
  for (const block of output.split(/\n\s*\n/)) {
    let path = '';
    let branch: string | null = null;
    let prunable = false;
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
      else if (line.startsWith('branch refs/heads/')) branch = line.slice('branch refs/heads/'.length);
      else if (line === 'prunable' || line.startsWith('prunable ')) prunable = true;
    }
    if (!path || !branch || prunable || trees.has(branch)) continue;
    const tree: Tree = { path, dirty: null };
    trees.set(branch, tree);
    counting.push(
      dirtyCount(path).then((count) => {
        tree.dirty = count;
      }),
    );
  }
  await Promise.all(counting);
  return trees;
}

async function collect(repo: RepoRef, path: string, now: Date): Promise<{ path: string; branches: BranchInfo[] }> {
  let folder: string;
  try {
    folder = await realpath(path);
  } catch {
    throw new RepoProblem(`The folder ${path} does not exist.`);
  }

  let top: string;
  try {
    top = (await git(folder, ['rev-parse', '--show-toplevel'])).trim();
  } catch (error) {
    if (error instanceof GitError && /not a git repository/i.test(error.stderr)) throw new RepoProblem(`${path} is not a git repository.`);
    throw error;
  }
  // A folder inside a repository (the project itself, for the Office folder) is read as that repository,
  // found upward. The root of the disk or the home folder is never taken for one: a repository there is
  // a dotfiles repository, and reading all of it is not what the department asked for.
  const real = await realpath(top).catch(() => top);
  if (real !== folder) {
    const reason = broadFolder(real, await realpath(homedir()).catch(() => homedir()));
    if (reason) {
      throw new RepoProblem(`${path} is inside the git repository ${top}, which is ${reason}: too broad to read as the repository of a department. Name the repository's own folder.`);
    }
  }

  const baseSha = (await resolveSha(real, `refs/heads/${repo.base}`)) ?? (await resolveSha(real, repo.base));
  if (!baseSha) throw new RepoProblem(`The base branch "${repo.base}" does not exist in ${path}.`);

  const rows = parseRefs(await git(real, ['for-each-ref', `--format=${REF_FORMAT}`, 'refs/heads']));
  const trunk = new Set(rows.filter((row) => row.name === repo.base || LONG_LIVED.includes(row.name)).map((row) => row.name));

  // A branch counts as merged when it is inside the base or inside another trunk of the repo
  // (a task merged to main is safe to delete even though deploy has not got it yet).
  const targetShas = [baseSha];
  for (const row of rows) if (trunk.has(row.name) && !targetShas.includes(row.sha)) targetShas.push(row.sha);

  const [mergedSets, trees] = await Promise.all([Promise.all(targetShas.map((sha) => mergedInto(real, sha))), readWorktrees(real)]);
  const mergedNames = new Set(mergedSets.flatMap((set) => [...set]));

  const infos = await Promise.all(
    rows.map(async (row): Promise<BranchInfo> => {
      const isTrunk = trunk.has(row.name);
      const counts = row.sha === baseSha ? { ahead: 0, behind: 0 } : await aheadBehind(real, baseSha, row.sha);

      let merged: boolean;
      if (row.name === repo.base) merged = true;
      else if (isTrunk) merged = counts.ahead === 0;
      else if (mergedNames.has(row.name)) merged = true;
      else {
        merged = false;
        for (const target of targetShas) {
          if (await patchEquivalent(real, target, row.sha)) {
            merged = true;
            break;
          }
        }
      }

      const tree = trees.get(row.name) ?? null;
      const dirty = tree?.dirty ?? null;
      const ageDays = (now.getTime() - row.at.getTime()) / DAY_MS;
      // A branch with no commit of its own that sits exactly on the base and has a worktree is a task
      // that was just cut (the work protocol creates branch and worktree before the first commit).
      // It is in flight, not a leftover; once the base moves on it counts as merged again.
      const justCut = counts.ahead === 0 && counts.behind === 0 && tree !== null;
      let state: BranchState;
      if (isTrunk) state = 'base';
      else if (justCut) state = 'in-flight';
      else if (merged) state = 'leftover';
      else if (ageDays >= STALE_DAYS && !(dirty !== null && dirty > 0)) state = 'stale';
      else state = 'in-flight';

      return {
        name: row.name,
        ahead: counts.ahead,
        behind: counts.behind,
        merged,
        lastCommitAt: row.at.toISOString(),
        author: row.author,
        subject: row.subject,
        cardKey: parseCardKey(row.name),
        worktree: tree?.path ?? null,
        dirty,
        state,
      };
    }),
  );

  const rank = (info: BranchInfo) => (info.name === repo.base ? 0 : info.state === 'base' ? 1 : 2);
  const branches = infos.sort((a, b) => rank(a) - rank(b) || b.lastCommitAt.localeCompare(a.lastCommitAt) || a.name.localeCompare(b.name));
  return { path: real === folder ? path : real, branches };
}
