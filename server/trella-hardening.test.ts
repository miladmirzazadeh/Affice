// SEC-11 and SEC-14 against a fake Trella CLI: where the service is told to listen and where it really
// does, what a hostile .agentboard/config.json can change, and what environment Trella and its CLI get.
// The fake records its arguments and environment next to itself, and can be set to ignore --host (as a
// Trella that obeys config.json would). Spare ports 5410 to 5419 only.

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, test } from 'node:test';
import type { OfficeLayout } from '../shared/server-api';
import { trellaBoards } from './trella-cli';
import { exposureProblem, startTrella, stopTrella, trellaConfigProblem } from './trella-service';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'affice-trella-hardening-')));
process.env.AFFICE_TRELLA_PORT = '5410';
const savedCli = process.env.AFFICE_TRELLA_CLI;
const canaries = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'NPM_TOKEN', 'AFFICE_TEST_SECRET', 'MCP_FOO', 'TRELLA_PROJECT', 'TRELLA_AGENT_ID'];
const savedCanaries = Object.fromEntries(canaries.map((name) => [name, process.env[name]]));
for (const name of canaries) process.env[name] = `canary-${name}`;

const strangers: ChildProcess[] = [];
const hasOutsideAddress = Object.values(networkInterfaces()).some((entries) => (entries ?? []).some((e) => !e.internal && e.family === 'IPv4'));

after(() => {
  for (const child of strangers) if (child.exitCode === null) child.kill('SIGTERM');
  if (savedCli === undefined) delete process.env.AFFICE_TRELLA_CLI;
  else process.env.AFFICE_TRELLA_CLI = savedCli;
  for (const [name, value] of Object.entries(savedCanaries)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const FAKE = `
const fs = require('fs');
const http = require('http');
const path = require('path');
const args = process.argv.slice(2);
const here = __dirname;
const mode = fs.readFileSync(path.join(here, 'mode.txt'), 'utf8').trim();
fs.writeFileSync(path.join(here, 'record-' + args[0] + '.json'), JSON.stringify({ argv: args, env: process.env, cwd: process.cwd() }));
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
if (args[0] === 'init') {
  fs.mkdirSync('.agentboard', { recursive: true });
  // A hostile config: it asks for every interface.
  fs.writeFileSync('.agentboard/config.json', JSON.stringify({ server: { host: '0.0.0.0', port: 4174 }, data: '.agentboard' }));
  process.exit(0);
}
if (args[0] !== 'start') { process.stdout.write('{}'); process.exit(0); }
const port = Number(flag('--port'));
const host = mode === 'ignore-host' || mode === 'lie' ? '0.0.0.0' : (flag('--host') || '0.0.0.0');
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: true }));
});
server.listen(port, host, () => {
  fs.mkdirSync('.agentboard', { recursive: true });
  const says = mode === 'lie' ? '127.0.0.1' : host;
  fs.writeFileSync('.agentboard/service.json', JSON.stringify({ url: 'http://' + says + ':' + port, host: says, port, pid: process.pid, startedAt: new Date().toISOString(), version: 'fake' }));
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`;

/** A fake Trella CLI folder with the layout trellaProblem expects (bin/trella.js and dist/index.js). */
function fakeTrella(mode: 'honest' | 'ignore-host' | 'lie'): { cli: string; dir: string; record: (command: string) => { argv: string[]; env: Record<string, string>; cwd: string } } {
  const dir = mkdtempSync(join(root, 'fake-'));
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'dist'));
  writeFileSync(join(dir, 'dist', 'index.js'), '');
  writeFileSync(join(dir, 'bin', 'trella.js'), FAKE);
  writeFileSync(join(dir, 'bin', 'mode.txt'), mode);
  process.env.AFFICE_TRELLA_CLI = join(dir, 'bin', 'trella.js');
  return { cli: join(dir, 'bin', 'trella.js'), dir, record: (command) => JSON.parse(readFileSync(join(dir, 'bin', `record-${command}.json`), 'utf8')) };
}

let n = 0;
function layoutFor(name: string): OfficeLayout {
  const project = join(root, `p${(n += 1)}`, name);
  const officeDir = join(project, 'Office');
  mkdirSync(officeDir, { recursive: true });
  return {
    project,
    name,
    officeDir,
    configFile: join(officeDir, 'affice.json'),
    chatDir: join(officeDir, 'chat'),
    reportsDir: join(officeDir, 'reports'),
    protocolFile: join(officeDir, 'PROTOCOL.md'),
    trellaWorkspace: officeDir,
  };
}

function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(true)); // taken
    probe.listen(port, host, () => probe.close(() => resolve(false)));
  });
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test('Trella is started with --host 127.0.0.1 whatever config.json says, and only on this machine', async () => {
  const fake = fakeTrella('honest');
  const layout = layoutFor('Honest');
  cleanups.push(() => stopTrella(layout));
  const result = await startTrella(layout);
  assert.ok(result.url, result.problem);
  const started = fake.record('start');
  const at = started.argv.indexOf('--host');
  assert.ok(at >= 0 && started.argv[at + 1] === '127.0.0.1', `argv: ${started.argv.join(' ')}`);
  assert.ok(started.argv.includes('--no-open'));
  // The hostile config.json the fake's init wrote asks for 0.0.0.0; the flag won.
  assert.equal(JSON.parse(readFileSync(join(layout.trellaWorkspace, '.agentboard', 'config.json'), 'utf8')).server.host, '0.0.0.0');
  assert.equal(JSON.parse(readFileSync(join(layout.trellaWorkspace, '.agentboard', 'service.json'), 'utf8')).host, '127.0.0.1');
  if (hasOutsideAddress) {
    const port = Number(new URL(result.url!).port);
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (entry.internal || entry.family !== 'IPv4') continue;
        assert.equal(await reachable(entry.address, port), false, `nothing listens on ${entry.address}:${port}`);
      }
    }
  }
});

test('a Trella that ignores --host and listens everywhere is stopped, with a sentence', async () => {
  const fake = fakeTrella('ignore-host');
  const layout = layoutFor('Wide');
  cleanups.push(() => stopTrella(layout));
  const result = await startTrella(layout);
  assert.equal(result.url, undefined);
  assert.match(result.problem ?? '', /which other computers on the network can reach\. Affice stopped it\. Trella must only listen on this machine \(127\.0\.0\.1\)\./);
  const pid = JSON.parse(readFileSync(join(layout.trellaWorkspace, '.agentboard', 'service.json'), 'utf8')).pid as number;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.throws(() => process.kill(pid, 0), 'the service is gone');
  assert.ok(fake.record('start').argv.includes('--host'));
});

test('a Trella that says 127.0.0.1 but really listens everywhere is caught by the health check on another address of the machine', { skip: hasOutsideAddress ? false : 'this machine has no network address besides loopback' }, async () => {
  fakeTrella('lie');
  const layout = layoutFor('Liar');
  cleanups.push(() => stopTrella(layout));
  const result = await startTrella(layout);
  assert.equal(result.url, undefined);
  assert.match(result.problem ?? '', /Trella answers on \d+\.\d+\.\d+\.\d+:\d+, so other computers on the network can reach it\. Affice stopped it\./);
});

test('a live service that Affice did not start and that listens on the network is not reused, and is left running', async () => {
  const fake = fakeTrella('ignore-host');
  const layout = layoutFor('Foreign');
  mkdirSync(join(layout.trellaWorkspace, '.agentboard'), { recursive: true });
  writeFileSync(join(layout.trellaWorkspace, '.agentboard', 'config.json'), '{}');
  const child = spawn(process.execPath, [fake.cli, 'start', '--port', '5412', '--host', '0.0.0.0'], { cwd: layout.trellaWorkspace, stdio: 'ignore' });
  strangers.push(child);
  for (let i = 0; i < 50 && !existsSync(join(layout.trellaWorkspace, '.agentboard', 'service.json')); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  cleanups.push(() => stopTrella(layout));
  const result = await startTrella(layout);
  assert.equal(result.url, undefined);
  assert.match(result.problem ?? '', /Affice will not use it\. Stop that service \(pid \d+\), then open the project again\./);
  assert.equal(child.exitCode, null, 'Affice never stops a service it did not start');
});

test('exposureProblem: a host that is not loopback is a problem, loopback is not', async () => {
  assert.match((await exposureProblem({ port: 5419, host: '0.0.0.0' })) ?? '', /listens on 0\.0\.0\.0/);
  assert.match((await exposureProblem({ port: 5419, host: '192.168.1.5' })) ?? '', /listens on 192\.168\.1\.5/);
  for (const host of ['127.0.0.1', 'localhost', '::1', undefined]) assert.equal(await exposureProblem({ port: 5419, ...(host ? { host } : {}) }), null, String(host));
});

test('exposureProblem sees a service bound to every interface from the machine\'s own address, and ignores an adapter that accepts any connection', { skip: hasOutsideAddress ? false : 'no network address besides loopback' }, async () => {
  const health = (_request: unknown, response: { setHeader(name: string, value: string): void; end(body: string): void }) => {
    response.setHeader('content-type', 'application/json');
    response.end('{"ok":true}');
  };
  const server = createHttpServer(health);
  await new Promise<void>((resolve) => server.listen(5418, '0.0.0.0', resolve));
  try {
    assert.match((await exposureProblem({ port: 5418, host: '127.0.0.1' })) ?? '', /answers on \d+\.\d+\.\d+\.\d+:5418/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const loopbackOnly = createHttpServer(health);
  await new Promise<void>((resolve) => loopbackOnly.listen(5417, '127.0.0.1', resolve));
  try {
    assert.equal(await exposureProblem({ port: 5417, host: '127.0.0.1' }), null);
  } finally {
    await new Promise<void>((resolve) => loopbackOnly.close(() => resolve()));
  }
});

test('SEC-14: Trella, its init and the board CLI run with no credentials of the user', async () => {
  const fake = fakeTrella('honest');
  const layout = layoutFor('Env');
  cleanups.push(() => stopTrella(layout));
  const result = await startTrella(layout);
  assert.ok(result.url, result.problem);
  await trellaBoards(layout.trellaWorkspace, fake.cli)('Board');

  const allowed = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LANGUAGE', 'TMPDIR', 'TMP', 'TEMP', 'TERM', 'TZ', 'NO_COLOR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']);
  for (const command of ['init', 'start', 'new-project']) {
    const { env } = fake.record(command);
    for (const name of canaries) assert.ok(!(name in env), `${command}: ${name} reached the child`);
    for (const name of Object.keys(env)) assert.ok(allowed.has(name) || /^LC_/.test(name) || /^__CF_/.test(name), `${command}: ${name} is not on the allow list`); // __CF_* is added by macOS itself to every process
    assert.equal(env.PATH, process.env.PATH, `${command}: PATH is kept`);
    assert.equal(env.NO_COLOR, '1');
  }
});

test('config.json that sends Trella\'s data, inbox or outbox outside the Office folder is refused before anything starts', async () => {
  const fake = fakeTrella('honest');
  for (const [field, value] of [['data', '/tmp/somewhere-else'], ['data', '../../../escape'], ['data', 7]] as const) {
    const layout = layoutFor('Escape');
    mkdirSync(join(layout.trellaWorkspace, '.agentboard'), { recursive: true });
    writeFileSync(join(layout.trellaWorkspace, '.agentboard', 'config.json'), JSON.stringify({ [field]: value }));
    const result = await startTrella(layout);
    assert.equal(result.url, undefined);
    assert.match(result.problem ?? '', /put its data folder outside the Office folder .* Affice did not start Trella/);
  }
  const layout = layoutFor('Adapter');
  mkdirSync(join(layout.trellaWorkspace, '.agentboard'), { recursive: true });
  writeFileSync(join(layout.trellaWorkspace, '.agentboard', 'config.json'), JSON.stringify({ fileAdapter: { enabled: true, inbox: '.agentboard/inbox', outbox: '/etc' } }));
  assert.match(trellaConfigProblem(layout.trellaWorkspace) ?? '', /outbox folder outside the Office folder/);
  assert.ok(!existsSync(join(fake.dir, 'bin', 'record-start.json')), 'no Trella was started for any of them');
});

test('trellaConfigProblem accepts a normal config, an unreadable one, and folders inside the Office folder', () => {
  const layout = layoutFor('Fine');
  assert.equal(trellaConfigProblem(layout.trellaWorkspace), null, 'no .agentboard yet');
  mkdirSync(join(layout.trellaWorkspace, '.agentboard'));
  const config = join(layout.trellaWorkspace, '.agentboard', 'config.json');
  writeFileSync(config, 'not json');
  assert.equal(trellaConfigProblem(layout.trellaWorkspace), null, 'Trella reports a file it cannot read');
  writeFileSync(config, JSON.stringify({ version: 2, data: '.agentboard', server: { host: '0.0.0.0', port: 80 }, fileAdapter: { enabled: true, inbox: '.agentboard/inbox', outbox: join(layout.trellaWorkspace, 'out') } }));
  assert.equal(trellaConfigProblem(layout.trellaWorkspace), null, 'host and port are overridden on the command line, not refused');
  writeFileSync(config, JSON.stringify({ data: 'board' }));
  assert.equal(trellaConfigProblem(layout.trellaWorkspace), null);
});

test('an .agentboard that is a symbolic link is refused, and nothing is created behind it', async () => {
  const fake = fakeTrella('honest');
  const layout = layoutFor('Linked');
  const behind = join(root, `behind-${(n += 1)}`);
  mkdirSync(behind);
  symlinkSync(behind, join(layout.trellaWorkspace, '.agentboard'));
  const result = await startTrella(layout);
  assert.equal(result.url, undefined);
  assert.match(result.problem ?? '', /\.agentboard is a symbolic link\. Affice never writes through symbolic links, so it did not start Trella/);
  assert.deepEqual(readdirSync(behind), [], 'nothing was written behind the link');
  assert.ok(!existsSync(join(fake.dir, 'bin', 'record-init.json')) && !existsSync(join(fake.dir, 'bin', 'record-start.json')));
});
