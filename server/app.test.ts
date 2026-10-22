// One process serving the API, the socket and the built client on a spare port (5345), with the local-only
// Host and Origin checks, the single page fallback, and a clean shutdown. The Claude and Trella seams are
// fakes; the office is real. Every API request here carries the page token; the token and origin rules
// themselves are tested in server/security.test.ts.

import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { WebSocket } from 'ws';
import type { ClaudeStatus, ServerEvent } from '../shared/types';
import { PortInUseError, startServer, type RunningServer } from './app';
import { pageToken } from './auth';
import { NO_PROJECT } from './host';
import { resolveFile } from './static';

const PORT = 5345;
const root = realpathSync(mkdtempSync(join(tmpdir(), 'affice-app-')));
process.env.AFFICE_HOME = join(root, 'home', '.affice');
after(() => rmSync(root, { recursive: true, force: true }));

const ready: ClaudeStatus = {
  installed: true, path: '/usr/local/bin/claude', version: '2.1.287', minVersion: '2.1.211', tooOld: false,
  signedIn: true, authMethod: 'claude.ai', signingIn: false, loginUrl: null, error: null,
};

const client = join(root, 'client');
mkdirSync(join(client, 'assets'), { recursive: true });
writeFileSync(join(client, 'index.html'), '<!doctype html><title>Affice test page</title><div id="app"></div>');
writeFileSync(join(client, 'assets', 'index-abc123.js'), 'console.log("office");');
writeFileSync(join(root, 'secret.txt'), 'outside the client folder');

const calls: string[] = [];
const seams = {
  claudeStatus: async () => {
    calls.push('claude');
    return { ...ready };
  },
  startTrella: async () => {
    calls.push('trella.start');
    return { url: 'http://localhost:5999' };
  },
  stopTrella: async () => {
    calls.push('trella.stop');
  },
};

/** The page's token and subprotocols for the socket, as the served page uses them. */
const PROTOCOLS = ['affice', `affice.${pageToken}`];

/** A raw request, so the Host and Origin headers can be anything. It carries the page token unless the headers say otherwise. */
function raw(path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: PORT, path, method, agent: false, headers: { host: `localhost:${PORT}`, 'x-affice-token': pageToken, ...headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

let server: RunningServer;

test('the server starts on its port, bound to 127.0.0.1, with the client', async () => {
  server = await startServer({ port: PORT, clientDir: client, project: null, log: () => undefined, host: { seams } });
  assert.equal(server.port, PORT);
  assert.equal(server.url, `http://localhost:${PORT}`);
  assert.equal(server.servesClient, true);
  assert.deepEqual(calls, ['claude'], 'Claude Code was checked before the port opened, no project, no Trella');
});

test('the page, its assets and the single page fallback', async () => {
  const page = await raw('/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'] as string, /text\/html/);
  assert.equal(page.headers['cache-control'], 'no-store', 'the page carries this start\'s token, so it is never cached');
  assert.match(page.body, /<meta name="affice-token" content="[0-9a-f]{64}">/);
  assert.match(page.body, /Affice test page/);

  const asset = await raw('/assets/index-abc123.js');
  assert.equal(asset.status, 200);
  assert.match(asset.headers['content-type'] as string, /text\/javascript/);
  assert.match(asset.headers['cache-control'] as string, /immutable/);

  const route = await raw('/rooms/engineering');
  assert.equal(route.status, 200, 'an unknown path without an extension is the single page');
  assert.match(route.body, /Affice test page/);

  const missing = await raw('/assets/missing-file.js');
  assert.equal(missing.status, 404);

  const head = await raw('/', {}, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');

  const post = await raw('/', {}, 'POST');
  assert.equal(post.status, 404, 'the page answers GET and HEAD only, nothing else is served at /');
});

test('the API answers before the page, and with no project every office route is 409', async () => {
  const app = await raw('/api/app');
  assert.equal(app.status, 200);
  const state = JSON.parse(app.body) as { claude: ClaudeStatus; project: unknown };
  assert.equal(state.claude.signedIn, true);
  assert.equal(state.project, null);

  const office = await raw('/api/office');
  assert.equal(office.status, 409);
  assert.equal((JSON.parse(office.body) as { error: string }).error, NO_PROJECT);

  const unknown = await raw('/api/does-not-exist');
  assert.equal(unknown.status, 404);
  assert.match(unknown.headers['content-type'] as string, /application\/json/, 'an unknown API path is never the page');
});

test('only local pages may use it: a foreign Host or Origin is refused, for the API and for the page', async () => {
  for (const path of ['/', '/api/app', '/assets/index-abc123.js']) {
    const host = await raw(path, { host: 'evil.example' });
    assert.equal(host.status, 403, `Host evil.example on ${path}`);
    const rebinding = await raw(path, { host: `localhost.evil.example:${PORT}` });
    assert.equal(rebinding.status, 403, `a DNS rebinding name on ${path}`);
    const origin = await raw(path, { origin: 'https://evil.example' });
    assert.equal(origin.status, 403, `Origin evil.example on ${path}`);
  }
  assert.equal((await raw('/api/app', { host: `127.0.0.1:${PORT}` })).status, 200);
  assert.equal((await raw('/api/app', { origin: `http://localhost:${PORT}` })).status, 200);
});

test('a path outside the client folder is never served', async () => {
  assert.equal(resolveFile(client, '/../secret.txt'), null);
  assert.equal(resolveFile(client, '/%2e%2e/secret.txt'), null);
  assert.equal(resolveFile(client, '/assets/../../secret.txt'), null);
  assert.equal(resolveFile(client, '/index.html'), join(client, 'index.html'));
  for (const path of ['/..%2fsecret.txt', '/%2e%2e%2fsecret.txt', '/assets/..%2f..%2fsecret.txt', '/%00']) {
    const reply = await raw(path);
    assert.doesNotMatch(reply.body, /outside the client folder/, path);
  }
});

function frames(ws: WebSocket, count: number): Promise<ServerEvent[]> {
  return new Promise((resolve, reject) => {
    const seen: ServerEvent[] = [];
    ws.on('message', (data) => {
      seen.push(JSON.parse(String(data)) as ServerEvent);
      if (seen.length === count) resolve(seen);
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error(`only ${seen.length} frames`)), 4_000).unref();
  });
}

test('the socket sends app.state then office.state, and refuses a foreign Origin', async () => {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`, PROTOCOLS, { origin: `http://localhost:${PORT}` });
  const [app, office] = await frames(ws, 2);
  assert.equal(app.type, 'app.state');
  assert.equal(office.type, 'office.state');
  ws.close();

  const foreign = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, PROTOCOLS, { origin: 'https://evil.example' });
  const outcome = await new Promise<string>((resolve) => {
    foreign.on('open', () => resolve('open'));
    foreign.on('unexpected-response', (_req, res) => resolve(`status ${res.statusCode}`));
    foreign.on('error', () => resolve('error'));
  });
  assert.notEqual(outcome, 'open');

  const wrongPath = new WebSocket(`ws://localhost:${PORT}/other`, PROTOCOLS);
  const refused = await new Promise<string>((resolve) => {
    wrongPath.on('open', () => resolve('open'));
    wrongPath.on('unexpected-response', (_req, res) => resolve(`status ${res.statusCode}`));
    wrongPath.on('error', () => resolve('error'));
  });
  assert.notEqual(refused, 'open');
});

test('a taken port is reported before anything starts, and the first server is untouched', async () => {
  const before = calls.length;
  await assert.rejects(startServer({ port: PORT, clientDir: client, project: null, log: () => undefined, host: { seams } }), (error: unknown) => error instanceof PortInUseError && error.port === PORT);
  assert.equal(calls.length, before, 'no Claude check, no Trella');
  assert.equal((await raw('/api/app')).status, 200);
});

test('project.open over the socket opens an office and starts its Trella; close stops everything and frees the port', async () => {
  const project = join(root, 'projects', 'Orchard');
  mkdirSync(project, { recursive: true });
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`, PROTOCOLS);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const opened = new Promise<ServerEvent>((resolve) => {
    ws.on('message', (data) => {
      const event = JSON.parse(String(data)) as ServerEvent;
      if (event.type === 'app.state' && event.state.project) resolve(event);
    });
  });
  ws.send(JSON.stringify({ type: 'project.open', path: project }));
  const event = await opened;
  assert.equal(event.type === 'app.state' && event.state.project?.name, 'Orchard');
  assert.ok(calls.includes('trella.start'));
  assert.equal((await raw('/api/office')).status, 200, 'the office routes follow the open project');
  ws.close();

  await server.close();
  assert.ok(calls.includes('trella.stop'), 'closing the server stopped the project Trella');
  await assert.rejects(raw('/api/app'), /ECONNREFUSED/);
  // The port can be used again at once.
  const again = await startServer({ port: PORT, clientDir: null, project: null, log: () => undefined, host: { seams } });
  assert.equal(again.servesClient, false);
  assert.equal((await raw('/')).status, 404, 'without a built client the page is a 404, the API still answers');
  assert.equal((await raw('/api/app')).status, 200);
  await again.close();
});
