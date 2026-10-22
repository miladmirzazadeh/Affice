// The Claude Code seam: finding the `claude` binary, its version and sign-in state, and Claude Code's
// own sign-in started from Affice. Owned by the Claude connection; server/host.ts calls the
// exported functions and nothing else.
//
// What Affice does and never does:
//   - It runs the user's own, unmodified `claude`: `--version`, `auth status` and `auth login`.
//   - The sign-in happens in Claude Code and the browser. Affice scrapes the sign-in page link from the
//     CLI's output so it can show it, and never sees a credential, a code or a token.
//   - It never calls `auth logout` or `setup-token`, never reads the keychain or ~/.claude files, and
//     never puts account details (email, organization, plan) in ClaudeStatus: only `loggedIn` and
//     `authMethod` are read from `auth status`.
//   - Every command runs with the environment the managers get (childEnv in driver.ts: no ANTHROPIC_* and
//     no CLAUDE* variables, so a stray API key in the user's shell is never used), so the status says what
//     a session will see.
//   - Affice works with a Claude subscription only. Ready means signed in with the Claude account
//     (`claude.ai`) or a Claude Code token (`oauth_token`); every other state (`none`, `api_key`,
//     `api_key_helper`, `third_party`) is signed out and asks for the subscription sign-in.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { ClaudeStatus } from '../../shared/types';
import { RefreshGate } from '../coalesce';
import { minimalEnv } from '../env';
import type { HostHandle } from '../host';
import type { HttpRouter } from '../router';
import { childEnv, compareVersions, detectCliVersion, FORWARD_SUBAGENT_TEXT_SINCE } from './driver';

/** The oldest Claude Code with every flag Affice passes (--forward-subagent-text). */
export const MIN_CLAUDE_VERSION = FORWARD_SUBAGENT_TEXT_SINCE;

export interface ClaudeBinary {
  /** What Affice runs: an absolute path, or a command name found on PATH. */
  path: string;
  /** For example "2.1.287". */
  version: string;
}

/** Where to look after PATH. The tests pass their own list (it replaces the usual folders and the npm bin); the seam functions use the defaults. */
export interface ClaudeSearch {
  locations?: string[];
}

/** Timings of the sign-in and the status check. The tests shorten them. */
export const loginTiming = {
  /** How often `auth status` is read while a sign-in runs. */
  pollMs: 2_000,
  /** A sign-in that is not finished by then is stopped. */
  timeoutMs: 5 * 60_000,
  /** startLogin waits this long for the sign-in link before it answers. */
  urlWaitMs: 3_000,
  /** After SIGTERM, how long the CLI has before SIGKILL. */
  killGraceMs: 2_000,
  /** The CLI gets this long after a successful sign-in to exit by itself. */
  exitWaitMs: 3_000,
  /** `claude auth status` is stopped after this long. */
  authTimeoutMs: 5_000,
};

// ------------------------------------------------------------------------------------------ finding

/** The places a Claude Code install puts its binary, after PATH (docs: native, Homebrew, the older local install). */
export function systemLocations(platform: NodeJS.Platform = process.platform, home: string = homedir()): string[] {
  if (platform === 'win32') return [join(home, '.local', 'bin', 'claude.exe')];
  return [join(home, '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude', join(home, '.claude', 'local', 'claude')];
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The executable files called `name` in the PATH folders, in PATH order. */
function onPath(name: string, pathVar: string | undefined, platform: NodeJS.Platform = process.platform): string[] {
  const names = platform === 'win32' ? [`${name}.exe`] : [name];
  const found: string[] = [];
  for (const dir of (pathVar ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const file of names) {
      const candidate = join(dir, file);
      if (isExecutable(candidate)) found.push(candidate);
    }
  }
  return found;
}

/** Where an npm global install puts `claude`, from what is known without running anything. */
function npmBinCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string[] {
  const file = platform === 'win32' ? 'claude.exe' : 'claude';
  const prefix = env.npm_config_prefix || env.NPM_CONFIG_PREFIX;
  const out: string[] = [];
  if (prefix) out.push(platform === 'win32' ? join(prefix, file) : join(prefix, 'bin', file));
  // node and the global packages usually share one bin folder (system installs, nvm, Volta).
  out.push(join(dirname(process.execPath), file));
  return out;
}

/** `npm prefix -g`, the last resort for the npm global bin. Null when npm is missing or slow. */
function npmPrefixBin(platform: NodeJS.Platform = process.platform): Promise<string | null> {
  if (platform === 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    // npm is not Claude Code: it gets the minimal environment, plus the one setting that moves the global folder.
    const env = minimalEnv({ npm_config_prefix: process.env.npm_config_prefix, NPM_CONFIG_PREFIX: process.env.NPM_CONFIG_PREFIX });
    execFile('npm', ['prefix', '-g'], { timeout: 5_000, env }, (error, stdout) => {
      const prefix = String(stdout).trim();
      resolve(error || !prefix ? null : join(prefix, 'bin', 'claude'));
    });
  });
}

interface Located {
  binary: ClaudeBinary | null;
  /** A sentence when something specific is wrong (CLAUDE_BIN does not answer); null for a plain "not found". */
  problem: string | null;
  /** CLAUDE_BIN is set and does not answer: the problem is that variable. */
  forcedBad?: boolean;
}

async function locate(search: ClaudeSearch = {}): Promise<Located> {
  const forced = process.env.CLAUDE_BIN?.trim();
  if (forced) {
    // An explicit choice is never second-guessed: no fallback to another binary.
    const version = await detectCliVersion(forced);
    return version
      ? { binary: { path: forced, version }, problem: null }
      : { binary: null, problem: `CLAUDE_BIN is set to ${forced}, but that did not answer claude --version. Fix the path or unset CLAUDE_BIN.`, forcedBad: true };
  }
  const tried = new Set<string>();
  const probe = async (candidate: string): Promise<ClaudeBinary | null> => {
    if (tried.has(candidate)) return null;
    tried.add(candidate);
    if (!isExecutable(candidate)) return null;
    const version = await detectCliVersion(candidate);
    return version ? { path: candidate, version } : null;
  };
  // `locations` (the tests) replaces every place after PATH: the usual folders and the npm global bin.
  const candidates = [...onPath('claude', process.env.PATH), ...(search.locations ?? [...systemLocations(), ...npmBinCandidates(process.env)])];
  for (const candidate of candidates) {
    const binary = await probe(candidate);
    if (binary) return { binary, problem: null };
  }
  // Only when nothing else answered: ask npm where its global bin is (a spawn, so last).
  if (!search.locations) {
    const npm = await npmPrefixBin();
    if (npm) {
      const binary = await probe(npm);
      if (binary) return { binary, problem: null };
    }
  }
  return { binary: null, problem: null };
}

/** The `claude` binary and its version, or null when none answers. */
export async function findClaude(search?: ClaudeSearch): Promise<ClaudeBinary | null> {
  return (await locate(search)).binary;
}

// ------------------------------------------------------------------------------------------ sign-in state

/** The sign-in methods that mean a Claude subscription. Nothing else lets the app through. */
export const SUBSCRIPTION_METHODS: readonly string[] = ['claude.ai', 'oauth_token'];

type Auth =
  /** Signed in with a Claude subscription. */
  | { state: 'in'; method: string }
  /** Not usable. `other` is undefined when signed out, and the method (null when unreadable) when Claude Code is signed in another way. */
  | { state: 'out'; other?: string | null }
  | { state: 'unknown'; reason: string };

/** What `claude -p` prints when signed out ("Not logged in · Please run /login", "Login expired · ..."). */
export function looksSignedOut(text: string): boolean {
  return /\b(not logged in|not signed in|login expired|please run \/login|claude auth login)\b/i.test(text);
}

/** The environment of every claude command Affice runs: the managers' (no stray credentials, no parent session). */
function claudeEnv(): NodeJS.ProcessEnv {
  return childEnv(process.env, process.cwd());
}

/** Maps the output of `claude auth status` (JSON; exit 1 when signed out) to a sign-in state. Only `loggedIn` and `authMethod` are read. */
export function parseAuthStatus(stdout: string, stderr = ''): Auth {
  const text = stdout.trim();
  if (text) {
    try {
      const json: unknown = JSON.parse(text);
      if (json && typeof json === 'object' && !Array.isArray(json)) {
        const { loggedIn, authMethod } = json as { loggedIn?: unknown; authMethod?: unknown };
        if (typeof loggedIn === 'boolean') {
          const method = typeof authMethod === 'string' && /^[A-Za-z0-9_.:-]{1,40}$/.test(authMethod) ? authMethod : null;
          if (!loggedIn || method === 'none') return { state: 'out' };
          return method !== null && SUBSCRIPTION_METHODS.includes(method) ? { state: 'in', method } : { state: 'out', other: method };
        }
      }
    } catch {
      // Not JSON: fall through to the text forms.
    }
  }
  if (looksSignedOut(`${stdout}\n${stderr}`)) return { state: 'out' };
  return { state: 'unknown', reason: 'Claude Code did not report whether it is signed in.' };
}

function readAuth(path: string): Promise<Auth> {
  return new Promise((resolve) => {
    execFile(
      path,
      ['auth', 'status'],
      { timeout: loginTiming.authTimeoutMs, killSignal: 'SIGKILL', env: claudeEnv(), maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && (error as { killed?: boolean }).killed) {
          resolve({ state: 'unknown', reason: `Claude Code did not answer claude auth status within ${Math.round(loginTiming.authTimeoutMs / 1000)} seconds.` });
        } else if (error && typeof (error as { code?: unknown }).code === 'string') {
          resolve({ state: 'unknown', reason: `Claude Code could not be run: ${(error as { code: string }).code}.` });
        } else {
          resolve(parseAuthStatus(String(stdout), String(stderr)));
        }
      },
    );
  });
}

/** The sentence for a Claude Code that is signed in, but not with a Claude subscription. Never account details. */
function otherSignInNote(other: string | null): string {
  return `Claude Code is signed in another way${other ? ` (${other})` : ''}, but Affice needs a Claude subscription. Sign in with your Claude account.`;
}

function baseStatus(located: Located): ClaudeStatus {
  const binary = located.binary;
  return {
    installed: binary !== null,
    path: binary?.path ?? null,
    version: binary?.version ?? null,
    minVersion: MIN_CLAUDE_VERSION,
    tooOld: binary !== null && compareVersions(binary.version, MIN_CLAUDE_VERSION) < 0,
    signedIn: false,
    authMethod: null,
    signingIn: false,
    loginUrl: null,
    error: located.problem,
    ...(located.forcedBad ? { claudeBinProblem: true } : {}),
  };
}

function withAuth(base: ClaudeStatus, auth: Auth): ClaudeStatus {
  switch (auth.state) {
    case 'in':
      return { ...base, signedIn: true, authMethod: auth.method, error: null };
    case 'out':
      return { ...base, signedIn: false, authMethod: null, error: auth.other === undefined ? null : otherSignInNote(auth.other) };
    case 'unknown':
      return {
        ...base,
        signedIn: false,
        authMethod: null,
        error: base.tooOld ? `${auth.reason} This Claude Code is older than ${base.minVersion}: update it, then check again.` : `${auth.reason} Run claude auth status in a terminal to see why, then check again.`,
      };
  }
}

/** The status the setup screen and the sessions use. */
export async function claudeStatus(search?: ClaudeSearch): Promise<ClaudeStatus> {
  const located = await locate(search);
  const base = baseStatus(located);
  if (!located.binary) return overlay(base);
  return overlay(withAuth(base, await readAuth(located.binary.path)));
}

// ------------------------------------------------------------------------------------------ sign-in

interface LoginRun {
  /** The newest status published (or about to be answered), so startLogin never answers with an older one. */
  latest: ClaudeStatus;
  loginUrl: string | null;
  cancel(): Promise<ClaudeStatus>;
}

/** The one sign-in that runs, if any. */
let run: LoginRun | null = null;

function activeRun(): LoginRun | null {
  return run;
}

/** A running sign-in is part of the status: a refresh must not wipe the sign-in page from the screen. */
function overlay(status: ClaudeStatus): ClaudeStatus {
  if (!run || status.signedIn) return status;
  return { ...status, signingIn: true, loginUrl: run.loginUrl };
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const URL_AT = /https:\/\/[^\s"'<>`\\]+/;

/** The first https link in the CLI's output (the line format is not documented), or null. `final` accepts a link that may still be arriving. */
export function scrapeLoginUrl(output: string, final = true): string | null {
  const text = output.replace(ANSI, '');
  const match = URL_AT.exec(text);
  if (!match) return null;
  // A link that ends the text so far may be cut in the middle: wait for more output.
  if (!final && match.index + match[0].length >= text.length) return null;
  const link = match[0].replace(/[.,;:!?)\]}]+$/, '');
  try {
    const url = new URL(link);
    return url.protocol === 'https:' && link.length <= 4096 ? link : null;
  } catch {
    return null;
  }
}

/** The last readable line of the CLI's output without links, for an error sentence. */
function lastLine(output: string): string {
  const lines = output
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const line = lines[lines.length - 1] ?? '';
  return line.length > 160 ? `${line.slice(0, 159)}...` : line;
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function stopChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (exited(child)) {
      resolve();
      return;
    }
    const force = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }, loginTiming.killGraceMs);
    child.once('exit', () => {
      clearTimeout(force);
      resolve();
    });
    try {
      child.kill('SIGTERM');
    } catch {
      clearTimeout(force);
      resolve();
    }
  });
}

function waitExit(child: ChildProcess, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (exited(child)) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

type Outcome = { kind: 'signedIn' } | { kind: 'cancelled' } | { kind: 'error'; message: string };

/**
 * Starts Claude Code's own sign-in (`claude auth login`, the Claude account method). `onStatus` receives every
 * change while it runs (the sign-in link, then signed in, or an error); the promise resolves with the status
 * right after the start: when the link is known, the CLI ended, or after a few seconds. One sign-in at a time.
 */
export async function startLogin(onStatus: (status: ClaudeStatus) => void): Promise<ClaudeStatus> {
  if (activeRun()) return (activeRun() as LoginRun).latest;
  const status = await claudeStatus();
  // Two quick clicks both get here: the second sees the first one's run.
  const running = activeRun();
  if (running) return running.latest;
  if (!status.installed) return { ...status, error: status.error ?? 'Claude Code was not found. Install it first, then sign in.' };
  if (status.signedIn) return status;
  return begin(status, onStatus);
}

function begin(base: ClaudeStatus, onStatus: (status: ClaudeStatus) => void): Promise<ClaudeStatus> {
  return new Promise((answer) => {
    let child: ChildProcess;
    try {
      // Piped stdio: Affice reads the output and never writes to stdin; Claude Code opens the browser and listens for the callback.
      child = spawn(base.path as string, ['auth', 'login'], { cwd: homedir(), env: claudeEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      answer({ ...base, error: `The sign-in could not start: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }

    let output = '';
    let settled = false;
    let answered = false;
    let urlTimer: NodeJS.Timeout | null = null;
    let pollTimer: NodeJS.Timeout | null = null;
    let overall: NodeJS.Timeout | null = null;
    let urlWait: NodeJS.Timeout | null = null;
    let finished: Promise<ClaudeStatus> | null = null;

    const current: LoginRun = {
      latest: { ...base, signingIn: true, loginUrl: null },
      loginUrl: null,
      cancel: () => finish({ kind: 'cancelled' }),
    };
    run = current;

    const publish = (status: ClaudeStatus) => {
      current.latest = status;
      try {
        onStatus(status);
      } catch {
        // The host's problem, not the sign-in's.
      }
    };
    const reply = () => {
      if (answered) return;
      answered = true;
      answer(current.latest);
    };
    const killOnExit = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    };
    process.once('exit', killOnExit);

    const finish = (outcome: Outcome): Promise<ClaudeStatus> => {
      if (finished) return finished;
      settled = true;
      for (const timer of [urlTimer, pollTimer, overall, urlWait]) if (timer) clearTimeout(timer);
      finished = (async () => {
        // A finished sign-in gets a moment to exit by itself (it may still be writing its settings).
        if (outcome.kind === 'signedIn') await waitExit(child, loginTiming.exitWaitMs);
        child.stdin?.destroy();
        await stopChild(child);
        process.removeListener('exit', killOnExit);
        if (run === current) run = null;
        const fresh = await claudeStatus();
        const final = outcome.kind === 'error' ? { ...fresh, error: outcome.message } : fresh;
        publish(final);
        reply();
        return final;
      })();
      return finished;
    };

    const setUrl = (url: string) => {
      if (current.loginUrl || settled) return;
      current.loginUrl = url;
      publish({ ...base, signingIn: true, loginUrl: url });
      reply();
    };
    const onOutput = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-16_384);
      if (current.loginUrl || settled) return;
      const url = scrapeLoginUrl(output, false);
      if (url) {
        setUrl(url);
      } else if (!urlTimer && URL_AT.test(output.replace(ANSI, ''))) {
        // A link that may be cut: accept what has arrived if nothing more comes.
        urlTimer = setTimeout(() => {
          urlTimer = null;
          const late = scrapeLoginUrl(output, true);
          if (late) setUrl(late);
        }, 300);
      }
    };
    child.stdout?.on('data', onOutput);
    child.stderr?.on('data', onOutput);
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.on('error', () => undefined);

    child.on('error', (error) => {
      void finish({ kind: 'error', message: `The sign-in could not start: ${error.message}` });
    });
    child.on('exit', (code) => {
      if (settled) return;
      // Let the last output arrive, then see whether the sign-in worked.
      setTimeout(async () => {
        if (settled) return;
        const auth = await readAuth(base.path as string);
        if (settled) return;
        if (auth.state === 'in') {
          void finish({ kind: 'signedIn' });
          return;
        }
        const detail = lastLine(output);
        void finish({
          kind: 'error',
          message:
            code === 0
              ? 'Claude Code finished the sign-in, but it is still not signed in. Check again, or sign in from a terminal with claude auth login.'
              : `The sign-in stopped before it finished${detail ? `: ${detail}` : '.'} Try again, or sign in from a terminal with claude auth login.`,
        });
      }, 100);
    });

    const tick = async () => {
      pollTimer = null;
      if (settled) return;
      const auth = await readAuth(base.path as string);
      if (settled) return;
      if (auth.state === 'in') {
        void finish({ kind: 'signedIn' });
        return;
      }
      pollTimer = setTimeout(tick, loginTiming.pollMs);
    };
    pollTimer = setTimeout(tick, loginTiming.pollMs);

    overall = setTimeout(() => {
      void finish({ kind: 'error', message: 'The sign-in was not finished in time, so it was stopped. Try again.' });
    }, loginTiming.timeoutMs);
    overall.unref();
    urlWait = setTimeout(reply, loginTiming.urlWaitMs);
  });
}

/** Stops a sign-in started from Affice. Resolves with the status after it. */
export async function cancelLogin(): Promise<ClaudeStatus> {
  const running = activeRun();
  return running ? running.cancel() : claudeStatus();
}

// ------------------------------------------------------------------------------------------ routes

/**
 * GET /api/claude: the Claude status the host holds (what app.state carries). With `?refresh=1` it checks
 * Claude Code again first, like the Check again button. No account details in either case.
 */
export function registerClaudeRoutes(router: HttpRouter, host: HostHandle): void {
  // SEC-09: a refresh runs `claude`, so it is shared while it runs and not repeated within a few seconds.
  const refreshes = new RefreshGate(CLAUDE_REFRESH_GAP_MS);
  router.get('/api/claude', (request) =>
    request.query.has('refresh')
      ? refreshes.run('claude', () => host.refreshClaude(), () => host.appState().claude)
      : host.appState().claude,
  );
}

/** A refresh of the Claude status is honoured once in this time; the other calls get the held status. */
const CLAUDE_REFRESH_GAP_MS = 3_000;
