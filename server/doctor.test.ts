// The checks of `affice doctor`: Node, Trella's built files, the port, the home folder, and the report with
// a fake claude. Spare port 5346; AFFICE_HOME is a scratch folder, never the real ~/.affice.

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { after, test } from 'node:test';
import type { DoctorCheck } from '../shared/server-api';
import { NEEDS_TOKEN } from './running';
import { doctorReport, formatDoctor, homeCheck, nodeCheck, passes, portCheck, trellaCheck, trellaWebRoot } from './doctor';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'affice-doctor-')));
process.env.AFFICE_HOME = join(root, 'home', '.affice');
after(() => rmSync(root, { recursive: true, force: true }));

/** A Trella folder in the bundled shape: bin/trella.js, dist/index.js and web/index.html. */
function fakeTrella(parts: { dist?: boolean; web?: boolean }): string {
  const dir = mkdtempSync(join(root, 'trella-'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'trella.js'), '');
  if (parts.dist) {
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'dist', 'index.js'), '');
  }
  if (parts.web) {
    mkdirSync(join(dir, 'web'));
    writeFileSync(join(dir, 'web', 'index.html'), '<html></html>');
  }
  return join(dir, 'bin', 'trella.js');
}

function fakeClaude(version = '2.1.300'): string {
  const file = join(root, 'claude');
  writeFileSync(
    file,
    ['#!/bin/sh', `if [ "$1" = "--version" ]; then echo "${version} (Claude Code)"; exit 0; fi`, 'if [ "$1" = "auth" ]; then echo \'{"loggedIn":true,"authMethod":"claude.ai"}\'; exit 0; fi', 'exit 0', ''].join('\n'),
  );
  chmodSync(file, 0o755);
  return file;
}

test('node: 22.5 and newer pass, older fail with a fix that says what to install', () => {
  for (const version of ['22.5.0', '22.12.1', '24.3.0']) assert.equal(nodeCheck(version).ok, true, version);
  for (const version of ['22.4.9', '20.18.0', '18.19.0']) {
    const check = nodeCheck(version);
    assert.equal(check.ok, false, version);
    assert.equal(check.id, 'node');
    assert.match(check.fix!, /Install Node\.js 22\.5 or newer/);
    assert.match(check.detail, new RegExp(version.replace(/\./g, '\\.')));
  }
  assert.equal(nodeCheck('24.3.0').fix, null);
});

test('trella: missing, unbuilt, without its web UI, and complete', () => {
  const missing = trellaCheck(join(root, 'nowhere', 'bin', 'trella.js'));
  assert.equal(missing.ok, false);
  assert.equal(missing.id, 'trella.built');
  assert.ok(missing.fix);

  assert.equal(trellaCheck(fakeTrella({ dist: false, web: true })).ok, false);
  const noWeb = trellaCheck(fakeTrella({ dist: true, web: false }));
  assert.equal(noWeb.ok, false);
  assert.match(noWeb.detail, /web UI is not built/);
  assert.ok(noWeb.fix);

  // The fix is true for whoever sees it: npx first, and the build only in a clone of the repository.
  const broken = fakeTrella({ dist: false, web: false });
  const fromNpx = trellaCheck(broken, false).fix!;
  assert.match(fromNpx, /^Run npx --yes affice@latest to fetch a fresh copy\.$/);
  assert.ok(!/npm run|npm install/.test(fromNpx));
  assert.match(trellaCheck(broken, true).fix!, /clone of the repository: run npm run build in /);

  const good = fakeTrella({ dist: true, web: true });
  assert.equal(trellaCheck(good).ok, true);
  assert.equal(trellaCheck(good).fix, null);
  assert.ok(trellaWebRoot(good));
});

test('port: free passes, taken fails and names the way out', async () => {
  assert.equal((await portCheck(5346)).ok, true);
  // Something that accepts connections and never answers, like any program that is not a web server.
  const blocker = createServer((socket) => void socket.on('error', () => undefined).resume());
  await new Promise<void>((resolve) => blocker.listen(5346, '127.0.0.1', resolve));
  try {
    const taken = await portCheck(5346);
    assert.equal(taken.ok, false);
    assert.equal(taken.id, 'port.free');
    assert.match(taken.fix!, /--port/);
    assert.match(taken.detail, /5346/);
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
});

/** A server on `port` that answers every request with `status` and `body`, like the first Affice does without a token. */
async function listenWith(port: number, status: number, body: unknown): Promise<() => Promise<void>> {
  const server = createHttpServer((_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return () => new Promise<void>((resolve) => server.close(() => resolve()));
}

test('port: Affice itself on the port passes and says so, any other program does not', async () => {
  const stopAffice = await listenWith(5346, 401, { error: NEEDS_TOKEN });
  try {
    const running = await portCheck(5346);
    assert.equal(running.ok, true);
    assert.equal(running.id, 'port.free');
    assert.equal(running.fix, null);
    assert.match(running.detail, /^Affice is already running here: http:\/\/localhost:5346$/);
  } finally {
    await stopAffice();
  }
  // A web server that is not Affice, and an answer that only looks like it.
  for (const [status, body] of [[200, { ok: true }], [401, { error: 'Login required.' }]] as const) {
    const stop = await listenWith(5346, status, body);
    try {
      const other = await portCheck(5346);
      assert.equal(other.ok, false, `${status} ${JSON.stringify(body)}`);
      assert.match(other.detail, /Something already listens on 127\.0\.0\.1:5346/);
      assert.match(other.fix!, /--port/);
    } finally {
      await stop();
    }
  }
});

test('home: a writable folder passes, one under a file fails with a fix', () => {
  const home = join(root, 'writable', '.affice');
  assert.equal(homeCheck(home).ok, true);
  const file = join(root, 'a-file');
  writeFileSync(file, 'not a folder');
  const blocked = homeCheck(join(file, '.affice'));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.id, 'home.writable');
  assert.match(blocked.fix!, /AFFICE_HOME/);
});

test('the report: every check has an id, failures carry a fix, ok follows the checks', async () => {
  const previous = { claude: process.env.CLAUDE_BIN, trella: process.env.AFFICE_TRELLA_CLI };
  try {
    process.env.CLAUDE_BIN = fakeClaude();
    process.env.AFFICE_TRELLA_CLI = fakeTrella({ dist: true, web: true });
    const good = await doctorReport({ port: 5346 });
    const ids = good.checks.map((check) => check.id);
    for (const id of ['node', 'claude.installed', 'trella.built', 'port.free', 'home.writable']) assert.ok(ids.includes(id), `${id} in ${ids.join(', ')}`);
    assert.equal(new Set(ids).size, ids.length, 'ids are unique');
    assert.deepEqual(good.checks.filter((check) => !check.ok), [], 'everything passes with a fake claude, a built Trella, a free port and a writable home');
    assert.equal(good.ok, true);
    assert.match(formatDoctor(good), /Everything Affice needs is in place/);

    process.env.CLAUDE_BIN = join(root, 'no-claude-here');
    process.env.AFFICE_TRELLA_CLI = join(root, 'nowhere', 'bin', 'trella.js');
    const bad = await doctorReport({ port: 5346 });
    assert.equal(bad.ok, false);
    const failed = bad.checks.filter((check) => !check.ok);
    assert.ok(failed.some((check) => check.id.startsWith('claude.')), 'a missing claude fails a claude check');
    assert.ok(failed.some((check) => check.id === 'trella.built'));
    for (const check of failed) assert.ok(check.fix && check.fix.length > 10, `${check.id} carries a fix an agent can act on`);
    for (const check of bad.checks.filter((c) => c.ok)) assert.equal(check.fix, null);
    const text = formatDoctor(bad);
    assert.match(text, /FAIL/);
    assert.match(text, /fix: /);
    assert.doesNotMatch(text, /\u2014|\u2013/, 'no em or en dash in the output');
  } finally {
    if (previous.claude === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previous.claude;
    if (previous.trella === undefined) delete process.env.AFFICE_TRELLA_CLI;
    else process.env.AFFICE_TRELLA_CLI = previous.trella;
  }
});

test('a warning does not fail the report: a too old Claude Code is printed as a warning, exit stays 0, and --json carries the level', async () => {
  const previous = { claude: process.env.CLAUDE_BIN, trella: process.env.AFFICE_TRELLA_CLI };
  try {
    process.env.CLAUDE_BIN = fakeClaude('2.1.100');
    process.env.AFFICE_TRELLA_CLI = fakeTrella({ dist: true, web: true });
    const report = await doctorReport({ port: 5346 });
    const version = report.checks.find((check) => check.id === 'claude.version')!;
    assert.equal(version.ok, false);
    assert.equal(version.level, 'warn');
    assert.ok(version.fix && version.fix.length > 10, 'the warning still says how to fix it');
    assert.equal(report.ok, true, 'a warning does not make the report fail');
    const text = formatDoctor(report);
    assert.match(text, /^warn {2}Claude Code is recent enough/m);
    assert.doesNotMatch(text, /FAIL/);
    assert.match(text, /fix: Update Claude Code/);
    assert.match(text, /Everything Affice needs is in place\. One warning is listed above/);

    // The exit code and the JSON of `affice doctor --json`.
    const lines: string[] = [];
    const log = console.log;
    console.log = (line?: unknown) => void lines.push(String(line));
    let code: number;
    try {
      code = await (await import('./cli')).runDoctor({ json: true, port: 5346 });
    } finally {
      console.log = log;
    }
    assert.equal(code, 0);
    const json = JSON.parse(lines.join('\n')) as { ok: boolean; checks: DoctorCheck[] };
    assert.equal(json.ok, true);
    assert.equal(json.checks.find((check) => check.id === 'claude.version')?.level, 'warn');
    assert.equal(json.checks.find((check) => check.id === 'node')?.level, undefined, 'a check without a level carries none');

    // A real failure next to a warning still fails.
    process.env.AFFICE_TRELLA_CLI = join(root, 'nowhere', 'bin', 'trella.js');
    const failing = await doctorReport({ port: 5346 });
    assert.equal(failing.ok, false);
    assert.match(formatDoctor(failing), /FAIL {2}Trella's built files/);
    assert.match(formatDoctor(failing), /^warn {2}Claude Code is recent enough/m);
  } finally {
    if (previous.claude === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previous.claude;
    if (previous.trella === undefined) delete process.env.AFFICE_TRELLA_CLI;
    else process.env.AFFICE_TRELLA_CLI = previous.trella;
  }
});

test('passes: ok, or failing only as a warning', () => {
  const check = (patch: Partial<DoctorCheck>): DoctorCheck => ({ id: 'x', ok: true, title: 't', detail: 'd', fix: null, ...patch });
  assert.equal(passes(check({})), true);
  assert.equal(passes(check({ ok: false, level: 'warn', fix: 'f' })), true);
  assert.equal(passes(check({ ok: false, fix: 'f' })), false);
});
