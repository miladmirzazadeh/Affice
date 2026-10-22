// bin/affice.js end to end, against the built dist/ (npm run build): the commands, `doctor --json`, `init`,
// and the real server process with a real Trella on spare ports (5347 doctor, 5348 Trella, 5349 office),
// stopped with SIGINT. The launcher tests of --version and --help need no build. Skipped while dist/ is
// missing. A fake claude stands in for Claude Code; no Claude session is ever started.

import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import type { ServerEvent } from '../shared/types';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'affice.js');
const version = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;

const root = realpathSync(mkdtempSync(join(tmpdir(), 'affice-launcher-')));
after(() => rmSync(root, { recursive: true, force: true }));

const built = existsSync(join(ROOT, 'dist', 'server.js')) && existsSync(join(ROOT, 'dist', 'cli.js'));
const skip = built ? false : 'dist/ is not built (npm run build)';

const claude = join(root, 'claude');
writeFileSync(
  claude,
  ['#!/bin/sh', 'if [ "$1" = "--version" ]; then echo "2.1.300 (Claude Code)"; exit 0; fi', 'if [ "$1" = "auth" ]; then echo \'{"loggedIn":true,"authMethod":"claude.ai"}\'; exit 0; fi', 'exit 0', ''].join('\n'),
);
chmodSync(claude, 0o755);

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, AFFICE_HOME: join(root, 'home', '.affice'), CLAUDE_BIN: claude, AFFICE_TRELLA_PORT: '5348', ...extra };
}

function affice(args: string[], extra: Record<string, string> = {}) {
  const run = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: env(extra), timeout: 60_000 });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
}

test('--version prints the package version; --help lists the commands and options', () => {
  assert.equal(affice(['--version']).stdout.trim(), version);
  assert.equal(affice(['-v']).stdout.trim(), version);
  const help = affice(['--help']);
  assert.equal(help.code, 0);
  for (const word of ['affice doctor', 'affice init <path>', '--port', '--no-open', '--project', '--json']) assert.ok(help.stdout.includes(word), word);
  assert.doesNotMatch(help.stdout, /\u2014|\u2013/);
});

test('bad input exits 2 with one sentence and a pointer to --help', () => {
  for (const args of [['frobnicate'], ['--port'], ['--port', 'abc'], ['--port', '70000'], ['--bogus'], ['doctor', '--bogus'], ['init'], ['init', 'a', 'b']]) {
    const run = affice(args);
    assert.equal(run.code, 2, args.join(' '));
    assert.match(run.stderr, /affice: .*\n.*--help/s, args.join(' '));
  }
});

test('doctor --json prints { ok, checks } and exits 0 when everything is in place', { skip }, () => {
  const run = affice(['doctor', '--json', '--port', '5347']);
  const report = JSON.parse(run.stdout) as { ok: boolean; checks: Array<{ id: string; ok: boolean; title: string; detail: string; fix: string | null }> };
  assert.equal(report.ok, true, run.stdout);
  assert.equal(run.code, 0);
  assert.deepEqual(report.checks.filter((check) => !check.ok), []);
  const ids = report.checks.map((check) => check.id);
  for (const id of ['node', 'claude.installed', 'trella.built', 'port.free', 'home.writable']) assert.ok(ids.includes(id), id);
  for (const check of report.checks) assert.deepEqual(Object.keys(check).sort(), ['detail', 'fix', 'id', 'ok', 'title']);

  const text = affice(['doctor', '--port', '5347']);
  assert.equal(text.code, 0);
  assert.match(text.stdout, /Everything Affice needs is in place/);
});

test('doctor --json exits 1 when a check fails, and every failure has a fix', { skip }, () => {
  const run = affice(['doctor', '--json', '--port', '5347'], { CLAUDE_BIN: join(root, 'no-claude'), PATH: '/nonexistent' });
  const report = JSON.parse(run.stdout) as { ok: boolean; checks: Array<{ id: string; ok: boolean; fix: string | null }> };
  assert.equal(report.ok, false);
  assert.equal(run.code, 1);
  const failed = report.checks.filter((check) => !check.ok);
  assert.ok(failed.length >= 1);
  for (const check of failed) assert.ok(check.fix, `${check.id} has a fix`);
});

test('doctor reports a taken port', { skip }, async () => {
  // Something that accepts connections and never answers (the doctor asks it whether it is Affice, then gives up).
  const blocker = createServer((socket) => void socket.on('error', () => undefined).resume());
  await new Promise<void>((resolve) => blocker.listen(5347, '127.0.0.1', resolve));
  try {
    const run = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      const child = spawn(process.execPath, [BIN, 'doctor', '--json', '--port', '5347'], { env: env() });
      let stdout = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.on('close', (code) => resolve({ code, stdout }));
    });
    const report = JSON.parse(run.stdout) as { ok: boolean; checks: Array<{ id: string; ok: boolean; fix: string | null }> };
    assert.equal(run.code, 1);
    const port = report.checks.find((check) => check.id === 'port.free')!;
    assert.equal(port.ok, false);
    assert.match(port.fix!, /--port/);
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
});

test('init creates the Office folder, says what it did, and leaves an existing one alone', { skip }, () => {
  const project = join(root, 'projects', 'Meadow');
  mkdirSync(project, { recursive: true });
  const first = affice(['init', project]);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /Affice office for Meadow/);
  assert.match(first.stdout, /Office folder\s+created/);
  assert.match(first.stdout, /affice\.json\s+created/);
  assert.ok(existsSync(join(project, 'Office', 'affice.json')));
  assert.match(first.stdout, new RegExp(`affice --project ${project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

  const config = readFileSync(join(project, 'Office', 'affice.json'), 'utf8');
  const second = affice(['init', project]);
  assert.equal(second.code, 0);
  assert.match(second.stdout, /Office folder\s+already there/);
  assert.match(second.stdout, /affice\.json\s+already there/);
  assert.equal(readFileSync(join(project, 'Office', 'affice.json'), 'utf8'), config);

  const missing = affice(['init', join(root, 'no', 'such', 'folder')]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /is not a folder/);
});

/** Waits for a line of the child's output. */
function waitFor(child: ChildProcess, pattern: RegExp, ms = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let seen = '';
    const timer = setTimeout(() => reject(new Error(`no ${pattern} in the output within ${ms} ms: ${seen}`)), ms);
    const onData = (chunk: Buffer) => {
      seen += String(chunk);
      if (pattern.test(seen)) {
        clearTimeout(timer);
        resolve(seen);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('close', () => {
      clearTimeout(timer);
      reject(new Error(`the process ended before ${pattern}: ${seen}`));
    });
  });
}

function closed(child: ChildProcess, ms = 20_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the process did not stop')), ms);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(true));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(false)));
  });
}

test('one process serves the page, the API and the socket; opening a project starts Trella; SIGINT stops both', { skip }, async () => {
  const project = join(root, 'projects', 'Orchard');
  mkdirSync(project, { recursive: true });
  const server = spawn(process.execPath, [BIN, '--port', '5349', '--no-open'], { env: env() });
  let stopped = false;
  after(() => {
    if (!stopped) server.kill('SIGKILL');
  });
  await waitFor(server, /Open http:\/\/localhost:5349/);

  const page = await fetch('http://localhost:5349/');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<title>Affice<\/title>/);
  // Every route needs the page token, which only the served page carries.
  const token = /<meta name="affice-token" content="([0-9a-f]{64})">/.exec(html)?.[1];
  assert.ok(token, 'index.html carries the page token');
  const withToken = { headers: { 'x-affice-token': token } };
  assert.equal((await fetch('http://localhost:5349/api/app')).status, 401, 'no token, no state');
  const state = (await (await fetch('http://localhost:5349/api/app', withToken)).json()) as { claude: { installed: boolean; signedIn: boolean }; project: unknown };
  assert.equal(state.claude.installed, true);
  assert.equal(state.project, null);
  assert.equal((await fetch('http://localhost:5349/api/office', withToken)).status, 409);

  // A second affice on the same port finds the first and says so.
  const second = spawnSync(process.execPath, [BIN, '--port', '5349', '--no-open'], { encoding: 'utf8', env: env(), timeout: 30_000 });
  assert.equal(second.status, 0);
  assert.match(second.stdout, /already running at http:\/\/localhost:5349/);

  // Open a project over the socket, as the browser does.
  const ws = new WebSocket('ws://localhost:5349/ws', ['affice', `affice.${token}`]);
  const trellaUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no office.state with a Trella address')), 30_000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'project.open', path: project })));
    ws.on('message', (data) => {
      const event = JSON.parse(String(data)) as ServerEvent;
      if (event.type === 'office.state' && event.snapshot.config.departments.length > 0 && /^http:\/\/localhost:\d+$/.test(event.snapshot.config.trellaUrl)) {
        clearTimeout(timer);
        resolve(event.snapshot.config.trellaUrl);
      }
    });
    ws.on('error', reject);
  });
  assert.notEqual(trellaUrl, 'http://localhost:4174');
  const service = join(project, 'Office', '.agentboard', 'service.json');
  assert.ok(existsSync(service), 'the service Affice started publishes its address in the Office folder');
  const health = (await (await fetch(`${trellaUrl}/api/health`)).json()) as { ok: boolean };
  assert.equal(health.ok, true);
  assert.match(await (await fetch(`${trellaUrl}/`)).text(), /<html/i, 'the board page is served');
  const trellaPort = Number(new URL(trellaUrl).port);
  ws.close();

  server.kill('SIGINT');
  const end = await closed(server);
  stopped = true;
  assert.equal(end.code, 0, `exit ${end.code} ${end.signal}`);
  assert.equal(await listening(5349), false, 'the office port is free');
  assert.equal(await listening(trellaPort), false, 'Trella stopped with it');
  assert.equal(existsSync(service), false, 'service.json is gone');
});
