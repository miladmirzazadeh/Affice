// The Trella service seam against the real, built Trella (vendored in a clone, bundled in dist/trella):
// start for a temporary project on a spare port, init once, reuse, stop, switch. Skipped while Trella is
// not built (npm run build:trella). Spare ports 5340 to 5343 only.

import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { OfficeLayout } from '../shared/server-api';
import { ensureTrellaWorkspace, freePort, startTrella, stopTrella, trellaCli } from './trella-service';
import { trellaProblem } from './trella-cli';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'affice-trella-')));
process.env.AFFICE_TRELLA_PORT = '5340';
const cleanups: Array<() => Promise<void> | void> = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  rmSync(root, { recursive: true, force: true });
});

const built = trellaProblem(trellaCli()) === null;
const skip = built ? false : 'Trella is not built (npm run build:trella)';

let n = 0;
/** A project with an Office folder, laid out the way ensureOffice does. */
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

function runtime(layout: OfficeLayout): { url: string; port: number; pid: number } {
  return JSON.parse(readFileSync(join(layout.trellaWorkspace, '.agentboard', 'service.json'), 'utf8'));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function health(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1_500) });
    return response.ok && ((await response.json()) as { ok?: boolean }).ok === true;
  } catch {
    return false;
  }
}

function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(true));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(false)));
  });
}

function portOf(url: string): number {
  return Number(new URL(url).port);
}

test('a missing Trella is a plain sentence, and stopTrella is safe after it', async () => {
  const previous = process.env.AFFICE_TRELLA_CLI;
  process.env.AFFICE_TRELLA_CLI = join(root, 'no-such-trella', 'bin', 'trella.js');
  try {
    const layout = layoutFor('missing');
    const result = await startTrella(layout);
    assert.match(result.problem ?? '', /Trella was not found/);
    assert.equal(result.url, undefined);
    await stopTrella(layout);
    assert.equal(existsSync(join(layout.trellaWorkspace, '.agentboard')), false, 'nothing was created for a Trella that cannot run');
  } finally {
    if (previous === undefined) delete process.env.AFFICE_TRELLA_CLI;
    else process.env.AFFICE_TRELLA_CLI = previous;
  }
});

test('freePort steps over a port that is taken', async () => {
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(5343, '127.0.0.1', resolve));
  try {
    assert.equal(await freePort(5343), 5344);
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
});

test('startTrella creates the workspace once, answers on localhost, reuses its service, and stopTrella ends it', { skip }, async () => {
  const layout = layoutFor('Orchard');
  cleanups.push(() => stopTrella(layout));
  assert.equal(existsSync(join(layout.trellaWorkspace, '.agentboard')), false);

  const started = await startTrella(layout);
  assert.equal(started.problem, undefined, started.problem);
  assert.match(started.url!, /^http:\/\/localhost:\d+$/, 'the hostname is localhost, the same site as the page');

  const config = JSON.parse(readFileSync(join(layout.trellaWorkspace, '.agentboard', 'config.json'), 'utf8')) as { workspace: { name: string } };
  assert.equal(config.workspace.name, 'Orchard', 'trella init was given the project name');
  const first = runtime(layout);
  assert.equal(portOf(started.url!), first.port, 'the address is the one in service.json');
  assert.ok(first.port >= 5340 && first.port <= 5349, `spare port, got ${first.port}`);
  assert.ok(alive(first.pid));
  assert.equal(await health(first.port), true);
  // The page the iframe loads: the built board.
  const page = await fetch(`${started.url}/`);
  assert.match(await page.text(), /<html/i);

  // A second start is the same service, not a second one.
  const again = await startTrella(layout);
  assert.equal(again.url, started.url);
  assert.equal(runtime(layout).pid, first.pid);

  // Concurrent calls share one start.
  const [a, b] = await Promise.all([startTrella(layout), startTrella(layout)]);
  assert.equal(a.url, b.url);

  await stopTrella(layout);
  assert.equal(alive(first.pid), false, 'the service is gone');
  assert.equal(await listening(first.port), false, 'its port is free again');
  assert.equal(existsSync(join(layout.trellaWorkspace, '.agentboard', 'service.json')), false, 'service.json is gone');
  await stopTrella(layout); // safe twice
});

test('an existing workspace is not initialised again', { skip }, async () => {
  const layout = layoutFor('Keep');
  cleanups.push(() => stopTrella(layout));
  assert.equal(await ensureTrellaWorkspace(layout), null);
  const configFile = join(layout.trellaWorkspace, '.agentboard', 'config.json');
  // A setting the user changed by hand must survive: init would have rewritten the file.
  const marker = readFileSync(configFile, 'utf8').replace(/\n$/, '') + '\n\n';
  writeFileSync(configFile, marker);
  const result = await startTrella(layout);
  assert.equal(result.problem, undefined, result.problem);
  await stopTrella(layout);
  assert.equal(readFileSync(configFile, 'utf8'), marker, 'the config was left alone');
});

test('a live service that Affice did not start is reused and left running', { skip }, async () => {
  const layout = layoutFor('Foreign');
  assert.equal(await ensureTrellaWorkspace(layout), null);
  const port = await freePort(5341);
  const outside = spawn(process.execPath, [trellaCli(), 'start', '--port', String(port), '--no-open'], { cwd: layout.trellaWorkspace, stdio: 'ignore' });
  cleanups.push(() => {
    outside.kill('SIGTERM');
  });
  for (let i = 0; i < 100 && !(await health(port)); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await health(port), true, 'the outside service is up');

  const result = await startTrella(layout);
  assert.equal(result.url, `http://localhost:${port}`);
  assert.equal(runtime(layout).pid, outside.pid, 'no second service was started');
  await stopTrella(layout);
  assert.equal(await health(port), true, 'stopTrella leaves a service it did not start');
  outside.kill('SIGTERM');
  await new Promise((resolve) => outside.once('close', resolve));
  assert.equal(await listening(port), false);
});

test('a stale service.json (a crashed service) is ignored and cleaned up', { skip }, async () => {
  const layout = layoutFor('Stale');
  assert.equal(await ensureTrellaWorkspace(layout), null);
  const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => dead.once('close', resolve));
  const file = join(layout.trellaWorkspace, '.agentboard', 'service.json');
  writeFileSync(file, JSON.stringify({ url: 'http://127.0.0.1:5342', host: '127.0.0.1', port: 5342, pid: dead.pid, startedAt: new Date().toISOString(), version: '0.0.0' }));
  // Cleaning alone: a dead pid's file goes.
  await stopTrella(layout);
  assert.equal(existsSync(file), false);
  writeFileSync(file, JSON.stringify({ url: 'http://127.0.0.1:5342', host: '127.0.0.1', port: 5342, pid: dead.pid, startedAt: new Date().toISOString(), version: '0.0.0' }));
  cleanups.push(() => stopTrella(layout));
  const result = await startTrella(layout);
  assert.equal(result.problem, undefined, result.problem);
  assert.notEqual(runtime(layout).pid, dead.pid);
  assert.equal(await health(portOf(result.url!)), true);
});

test('a switch moves the service: the first office stops, the second starts, and two can run side by side', { skip }, async () => {
  const one = layoutFor('One');
  const two = layoutFor('Two');
  cleanups.push(() => stopTrella(one), () => stopTrella(two));
  const first = await startTrella(one);
  assert.equal(first.problem, undefined, first.problem);
  const pidOne = runtime(one).pid;

  // What the host does on a switch: close, then open.
  await stopTrella(one);
  assert.equal(alive(pidOne), false);
  const second = await startTrella(two);
  assert.equal(second.problem, undefined, second.problem);
  assert.equal(await health(portOf(second.url!)), true);
  assert.equal(await health(portOf(first.url!)) && portOf(first.url!) !== portOf(second.url!), false, 'the first office has no service any more');

  // One service per workspace: a second office gets its own address.
  const third = await startTrella(one);
  assert.equal(third.problem, undefined, third.problem);
  assert.notEqual(portOf(third.url!), portOf(second.url!));
  assert.equal(await health(portOf(second.url!)), true);
  await stopTrella(one);
  await stopTrella(two);
  assert.equal(await health(portOf(second.url!)), false);
});

test('Trella that stops right after it starts is explained in a sentence', { skip }, async () => {
  // A CLI that exits at once: the sentence names what it printed.
  const dir = join(root, 'broken-trella');
  mkdirSync(join(dir, 'bin'), { recursive: true });
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'index.js'), '');
  writeFileSync(join(dir, 'bin', 'trella.js'), "console.error('trella: the database is locked'); process.exit(1);\n");
  const previous = process.env.AFFICE_TRELLA_CLI;
  process.env.AFFICE_TRELLA_CLI = join(dir, 'bin', 'trella.js');
  try {
    const layout = layoutFor('Broken');
    mkdirSync(join(layout.trellaWorkspace, '.agentboard'), { recursive: true });
    writeFileSync(join(layout.trellaWorkspace, '.agentboard', 'config.json'), '{}');
    const result = await startTrella(layout);
    assert.match(result.problem ?? '', /Trella stopped right after it started: trella: the database is locked/);
    await stopTrella(layout);
  } finally {
    if (previous === undefined) delete process.env.AFFICE_TRELLA_CLI;
    else process.env.AFFICE_TRELLA_CLI = previous;
  }
});

test('the vendored CLI really runs (sanity for the other tests)', { skip }, () => {
  const out = execFileSync(process.execPath, [trellaCli(), '--version'], { encoding: 'utf8' });
  assert.match(out.trim(), /^\d+\.\d+\.\d+$/);
});
