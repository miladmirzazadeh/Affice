// The Trella service seam: the Trella web service of a project's office, started when the project opens
// and stopped when it closes. server/host.ts calls startTrella and stopTrella
// and nothing else (trellaCli is also read for the data routes and the board CLI).
//
// startTrella runs the vendored (or bundled) Trella for the office folder `<project>/Office`:
//   1. `trella init --name <project> --port <free port>` once, when Office/.agentboard is missing,
//   2. `trella start --port <n> --no-open` with the Office folder as the working directory,
//   3. waits up to 10 s for a live pid in .agentboard/service.json and GET /api/health answering ok,
// and answers with the address on `localhost` (the page and the board must be the same site, or the board
// renders blank in the iframe) or a plain sentence. A live service that is already there (after a crash of
// an earlier Affice, or one the user started) is reused and never stopped by Affice. One service per workspace.
//
// Trella's own files are input from outside (SEC-11, SEC-14 of the security review): .agentboard/config.json
// can be edited by a manager, a git clone or a person. So:
//   - Trella is always started with `--host 127.0.0.1`, whatever the config says, and Affice checks where it
//     really listens (service.json, and a connection attempt on the machine's other addresses). A service
//     that is reachable from the network is stopped (or, when Affice did not start it, not used) and the
//     user gets a sentence.
//   - config.json is checked before the start: a data, inbox or outbox folder outside the Office folder, and
//     an .agentboard that is a symbolic link, are refused with a sentence.
//   - Trella and its CLI run with the minimal environment of server/env.ts: none of the user's credentials.

import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import type { OfficeLayout } from '../shared/server-api';
import { minimalEnv } from './env';
import { lstatOrNull } from './project/safe-fs';
import { DEFAULT_TRELLA_PORT, packageRoot } from './runtime';
import { trellaProblem } from './trella-cli';

/** The only address Trella may listen on. Passed as --host, whatever .agentboard/config.json says. */
export const TRELLA_HOST = '127.0.0.1';
/** What service.json may say for `host` and still mean "this machine only". */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** The Trella CLI Affice runs: AFFICE_TRELLA_CLI, else the vendored one (a clone), else the one bundled in the package (dist/trella). */
export function trellaCli(): string {
  if (process.env.AFFICE_TRELLA_CLI) return process.env.AFFICE_TRELLA_CLI;
  const root = packageRoot();
  const vendored = join(root, 'vendor/trella/packages/cli/bin/trella.js');
  if (existsSync(vendored)) return vendored;
  return join(root, 'dist/trella/bin/trella.js');
}

/** Where the office's Kanban view finds Trella's web UI, or why Trella cannot run (departments then get no board). */
export type TrellaStart = { url: string; problem?: undefined } | { url?: undefined; problem: string };

/** How long a starting service has to publish service.json and answer /api/health. */
export const START_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 4_000;
const POLL_MS = 100;

interface Owned {
  child: ChildProcess;
  exited: Promise<void>;
  port: number;
}

/** The services this process started, by workspace folder. */
const owned = new Map<string, Owned>();
/** The workspaces being started right now, so two calls for one office share one start. */
const starting = new Map<string, Promise<TrellaStart>>();

interface Runtime {
  url: string;
  port: number;
  pid: number;
  /** The address the service says it listens on (service.json), when it says. */
  host?: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function runtimeFile(workspace: string): string {
  return join(workspace, '.agentboard', 'service.json');
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The address a service published in .agentboard/service.json, whether or not its process is still there. */
function readRuntime(workspace: string): Runtime | null {
  try {
    const value = JSON.parse(readFileSync(runtimeFile(workspace), 'utf8')) as Partial<Runtime>;
    if (typeof value.pid !== 'number' || typeof value.port !== 'number') return null;
    return { url: String(value.url ?? ''), port: value.port, pid: value.pid, ...(typeof value.host === 'string' ? { host: value.host } : {}) };
  } catch {
    return null;
  }
}

/** The address the browser uses. localhost, not 127.0.0.1: it must be the same site as the Affice page. */
function boardUrl(port: number): string {
  return `http://localhost:${port}`;
}

async function healthy(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1_500) });
    if (!response.ok) return false;
    const body = (await response.json()) as { ok?: unknown };
    return body.ok === true;
  } catch {
    return false;
  }
}

function canListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

/** The first port from `from` on that nothing listens on (Trella steps up by itself if it is taken meanwhile). */
export async function freePort(from: number, attempts = 50): Promise<number> {
  for (let port = from; port < from + attempts && port <= 65535; port += 1) {
    if (await canListen(port)) return port;
  }
  return from;
}

function startingPort(): number {
  const raw = Number(process.env.AFFICE_TRELLA_PORT);
  return Number.isInteger(raw) && raw >= 1 && raw <= 65535 ? raw : DEFAULT_TRELLA_PORT;
}

/** The last line of a process's output, for the sentence that explains a failure. */
function lastLine(text: string): string {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  return (lines[lines.length - 1] ?? '').replace(/\u001b\[[0-9;]*m/g, '');
}

function run(cwd: string, cli: string, args: string[]): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { cwd, env: minimalEnv({ NO_COLOR: '1' }), timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, message: lastLine(String(stderr)) || lastLine(String(stdout)) || (error ? error.message : '') });
    });
  });
}

/** The addresses of this machine other computers could use: every non-loopback IPv4 address and global IPv6 address. */
function outsideAddresses(): string[] {
  const found: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      if (entry.family === 'IPv6' && entry.address.toLowerCase().startsWith('fe80')) continue; // link local: needs a zone to connect
      found.push(entry.address);
    }
  }
  return found;
}

/**
 * True when a Trella answers on `host`:`port`: GET /api/health with `ok: true`. A bare connection is not
 * enough: a VPN or proxy adapter (a TUN interface) can accept a connection on any port of its address
 * with nothing listening. The Host header says localhost, as the service wants, because a client on the
 * network chooses its own Host header too (that is why the Host check is no protection).
 */
function answersHealth(host: string, port: number): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const request = httpRequest({ host, port, path: '/api/health', method: 'GET', headers: { host: `localhost:${port}` }, timeout: 1_000 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > 2_000) request.destroy();
      });
      response.on('end', () => {
        try {
          resolveProbe(response.statusCode === 200 && (JSON.parse(body) as { ok?: unknown }).ok === true);
        } catch {
          resolveProbe(false);
        }
      });
      response.on('error', () => resolveProbe(false));
    });
    request.on('timeout', () => {
      request.destroy();
      resolveProbe(false);
    });
    request.on('error', () => resolveProbe(false));
    request.end();
  });
}

/**
 * A sentence when the service can be reached from other computers, or null when it listens on this machine
 * only. Two checks: what service.json says (a host that is not loopback), and what the machine answers (a
 * health request to the service's port on each of this machine's own network addresses; a service bound
 * to 127.0.0.1 does not answer there). SEC-11.
 */
export async function exposureProblem(runtime: { port: number; host?: string }): Promise<string | null> {
  if (runtime.host !== undefined && !LOOPBACK_HOSTS.has(runtime.host)) {
    return `Trella says it listens on ${runtime.host}, which other computers on the network can reach.`;
  }
  for (const address of outsideAddresses()) {
    if (await answersHealth(address, runtime.port)) {
      return `Trella answers on ${address}:${runtime.port}, so other computers on the network can reach it.`;
    }
  }
  return null;
}

/** Whether `value` (relative to the workspace, or absolute) stays inside the workspace folder, links resolved as far as the path exists. */
function staysInside(workspace: string, value: string): boolean {
  const root = resolve(workspace);
  const target = resolve(root, value);
  if (target !== root && !target.startsWith(root + sep)) return false;
  let probe = target;
  while (!existsSync(probe) && probe !== dirname(probe)) probe = dirname(probe);
  try {
    const realRoot = realpathSync(root);
    const real = realpathSync(probe);
    return real === realRoot || real.startsWith(realRoot + sep);
  } catch {
    return false;
  }
}

/**
 * Why Trella must not start in this workspace, or null. `.agentboard` must not be a symbolic link, and the
 * folders config.json names for Trella's data, inbox and outbox must stay inside the Office folder:
 * Trella writes there. Whatever config.json says for the host and the port is overridden on the command line.
 */
export function trellaConfigProblem(workspace: string): string | null {
  const agentboard = join(workspace, '.agentboard');
  if (lstatOrNull(agentboard)?.isSymbolicLink()) {
    return `${agentboard} is a symbolic link. Affice never writes through symbolic links, so it did not start Trella. Replace it with a real folder, then open the project again.`;
  }
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(join(agentboard, 'config.json'), 'utf8'));
  } catch {
    return null; // missing or not JSON: Trella says what is wrong with a file it cannot read
  }
  if (typeof config !== 'object' || config === null) return null;
  const record = config as { data?: unknown; fileAdapter?: { inbox?: unknown; outbox?: unknown } | null };
  const fields: Array<[string, unknown]> = [
    ['data folder', record.data],
    ['inbox folder', record.fileAdapter?.inbox],
    ['outbox folder', record.fileAdapter?.outbox],
  ];
  for (const [name, value] of fields) {
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.includes('\0') || !staysInside(workspace, value)) {
      return `The Trella settings in ${join(agentboard, 'config.json')} put its ${name} outside the Office folder (${String(value).slice(0, 80).replace(/[\u0000-\u001f]/g, '?')}). Affice did not start Trella. Remove that setting, then open the project again.`;
    }
  }
  return null;
}

/**
 * Creates Office/.agentboard (`trella init`) when it is missing, with the Office folder as the working
 * directory. Returns null when the workspace is there, or a sentence for the user.
 */
export async function ensureTrellaWorkspace(layout: OfficeLayout, port?: number): Promise<string | null> {
  const workspace = layout.trellaWorkspace;
  if (existsSync(join(workspace, '.agentboard', 'config.json'))) return null;
  const problem = trellaProblem(trellaCli());
  if (problem) return problem;
  mkdirSync(workspace, { recursive: true });
  const chosen = port ?? (await freePort(startingPort()));
  const result = await run(workspace, trellaCli(), ['init', '--name', layout.name, '--port', String(chosen)]);
  if (!result.ok) return `Trella could not create its workspace in ${workspace}: ${result.message || 'trella init failed'}.`;
  return null;
}

/** Starts (or reuses) the Trella service of this office. Called after ensureOffice, before the sessions start. */
export function startTrella(layout: OfficeLayout): Promise<TrellaStart> {
  const key = layout.trellaWorkspace;
  const pending = starting.get(key);
  if (pending) return pending;
  const task = start(layout).finally(() => starting.delete(key));
  starting.set(key, task);
  return task;
}

async function start(layout: OfficeLayout): Promise<TrellaStart> {
  const workspace = layout.trellaWorkspace;
  const cli = trellaCli();
  const problem = trellaProblem(cli);
  if (problem) return { problem };

  // Ours and still running: the same address.
  const mine = owned.get(workspace);
  if (mine && mine.child.exitCode === null && mine.child.signalCode === null && (await healthy(mine.port))) {
    return { url: boardUrl(mine.port) };
  }
  owned.delete(workspace);

  const port = await freePort(startingPort());
  // An .agentboard that is a link is refused before anything (not even `trella init`) writes into it.
  const linked = trellaConfigProblem(workspace);
  if (linked) return { problem: linked };
  const initProblem = await ensureTrellaWorkspace(layout, port);
  if (initProblem) return { problem: initProblem };
  const configProblem = trellaConfigProblem(workspace);
  if (configProblem) return { problem: configProblem };

  // A live service (after a crash of an earlier Affice, or one the user started): reuse it, unless the network can reach it.
  const live = readRuntime(workspace);
  if (live && alive(live.pid)) {
    const reused = await waitForHealth(live.port, live.pid);
    if (!reused) return { problem: `A Trella service (pid ${live.pid}) is running for ${workspace} but does not answer. Stop it, then open the project again.` };
    const exposed = await exposureProblem(live);
    if (exposed) return { problem: `${exposed} Affice will not use it. Stop that service (pid ${live.pid}), then open the project again.` };
    return { url: boardUrl(live.port) };
  }

  let output = '';
  const child = spawn(process.execPath, [cli, 'start', '--port', String(port), '--host', TRELLA_HOST, '--no-open'], {
    cwd: workspace,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: minimalEnv({ NO_COLOR: '1' }),
  });
  const remember = (chunk: Buffer) => {
    output = (output + String(chunk)).slice(-4_000);
  };
  child.stdout?.on('data', remember);
  child.stderr?.on('data', remember);
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
  child.once('error', (error) => {
    output += `\n${error.message}`;
  });

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const runtime = readRuntime(workspace);
    if (runtime && runtime.pid === child.pid && alive(runtime.pid) && (await healthy(runtime.port))) {
      // Where does it really listen? Never anywhere but this machine, whatever config.json said.
      const exposed = await exposureProblem(runtime);
      if (exposed) {
        await terminate(child, exited);
        return { problem: `${exposed} Affice stopped it. Trella must only listen on this machine (${TRELLA_HOST}).` };
      }
      owned.set(workspace, { child, exited, port: runtime.port });
      return { url: boardUrl(runtime.port) };
    }
    if (child.exitCode !== null || child.signalCode !== null) break;
    await sleep(POLL_MS);
  }

  // It did not come up. A service that another Affice started in the meantime wins; otherwise explain.
  const exitedEarly = child.exitCode !== null || child.signalCode !== null;
  await terminate(child, exited);
  const other = readRuntime(workspace);
  if (other && other.pid !== child.pid && alive(other.pid) && (await healthy(other.port))) {
    const exposed = await exposureProblem(other);
    if (exposed) return { problem: `${exposed} Affice will not use it. Stop that service (pid ${other.pid}), then open the project again.` };
    return { url: boardUrl(other.port) };
  }
  const why = lastLine(output);
  return {
    problem: exitedEarly
      ? `Trella stopped right after it started${why ? `: ${why}` : '.'}`
      : `Trella did not answer within ${START_TIMEOUT_MS / 1000} seconds${why ? `: ${why}` : '.'}`,
  };
}

async function waitForHealth(port: number, pid: number): Promise<boolean> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!alive(pid)) return false;
    if (await healthy(port)) return true;
    await sleep(POLL_MS);
  }
  return false;
}

/** SIGTERM, then SIGKILL when it does not leave in time. */
async function terminate(child: ChildProcess, exited: Promise<void>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const timer = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), STOP_TIMEOUT_MS).unref());
  if ((await Promise.race([exited.then(() => 'exited' as const), timer])) === 'timeout') {
    child.kill('SIGKILL');
    await Promise.race([exited, sleep(1_000)]);
  }
}

/** Stops the service startTrella started for this office (never one it reused from elsewhere). Safe after a failed or skipped start. */
export async function stopTrella(layout: OfficeLayout): Promise<void> {
  const workspace = layout.trellaWorkspace;
  const pending = starting.get(workspace);
  if (pending) await pending.catch(() => undefined);
  const mine = owned.get(workspace);
  owned.delete(workspace);
  if (mine) await terminate(mine.child, mine.exited);
  // After a kill the service leaves its address behind; a dead pid's file is only noise.
  const runtime = readRuntime(workspace);
  if (runtime && !alive(runtime.pid)) rmSync(runtimeFile(workspace), { force: true });
}
