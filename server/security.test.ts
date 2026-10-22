// The control channel: the page token and the agent tokens, the exact Origin, Sec-Fetch-Site, the
// security headers, the report policy, and the caller that the office derives instead of trusting a body.
// One real server on 5401 (and a second on 5402 with a development origin); the Claude and Trella seams are
// fakes, the office is real. The approvals MCP server is started as a real child process.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { WebSocket } from 'ws';
import type { ClaudeStatus, ServerEvent } from '../shared/types';
import { NEEDS_TOKEN, startServer, type RunningServer } from './app';
import { agentToken, pageToken } from './auth';
import { NO_PROJECT } from './host';
import { originPolicy, parseDevOrigin } from './security';

const PORT = 5401;
const DEV_PORT = 5402;
const OTHER_PORT = 5403; // another local page, as in the review's experiment
const root = realpathSync(mkdtempSync(join(tmpdir(), 'affice-security-')));
process.env.AFFICE_HOME = join(root, 'home', '.affice');
after(() => rmSync(root, { recursive: true, force: true }));

const ready: ClaudeStatus = {
  installed: true, path: '/usr/local/bin/claude', version: '2.1.287', minVersion: '2.1.211', tooOld: false,
  signedIn: true, authMethod: 'claude.ai', signingIn: false, loginUrl: null, error: null,
};
const seams = {
  claudeStatus: async () => ({ ...ready }),
  startTrella: async () => ({ url: 'http://localhost:5999' }),
  stopTrella: async () => undefined,
};

const client = join(root, 'client');
mkdirSync(join(client, 'assets'), { recursive: true });
writeFileSync(join(client, 'index.html'), '<!doctype html>\n<html><head><meta charset="utf-8"><title>Affice test page</title></head><body><div id="app"></div></body></html>');
writeFileSync(join(client, 'assets', 'index-abc123.js'), 'console.log("office");');

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** A raw request: the Host, Origin and Sec-Fetch-Site headers can be anything, and there is no token unless the test sends one. */
function http(path: string, options: { method?: string; headers?: Record<string, string>; body?: unknown; port?: number } = {}): Promise<Reply> {
  const port = options.port ?? PORT;
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        agent: false,
        headers: { host: `localhost:${port}`, ...(payload ? { 'content-type': 'application/json' } : {}), ...options.headers },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

const page = { 'x-affice-token': pageToken };
const agent = (department: string) => ({ 'x-affice-token': agentToken(department), 'x-affice-department': department });
const json = (reply: Reply) => JSON.parse(reply.body) as { error?: string; [key: string]: unknown };

/** What the socket does with these protocols and headers: 'open', or the status the upgrade got. */
function upgrade(protocols: string[] | undefined, headers: Record<string, string> = {}, port = PORT): Promise<{ outcome: string; protocol: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, protocols, { headers: { host: `localhost:${port}`, ...headers } });
    ws.on('open', () => {
      const protocol = ws.protocol;
      ws.close();
      resolve({ outcome: 'open', protocol });
    });
    ws.on('unexpected-response', (_req, res) => {
      resolve({ outcome: `status ${res.statusCode}`, protocol: '' });
      res.resume();
    });
    ws.on('error', () => undefined);
  });
}

let server: RunningServer;
let devServer: RunningServer;
let project: string;
let pageSocket: WebSocket;
const events: ServerEvent[] = [];

before(async () => {
  server = await startServer({ port: PORT, clientDir: client, project: null, log: () => undefined, host: { seams }, devOrigin: null });
  devServer = await startServer({ port: DEV_PORT, clientDir: null, project: null, log: () => undefined, host: { seams }, devOrigin: `http://localhost:${OTHER_PORT}` });
  project = join(root, 'projects', 'Orchard');
  mkdirSync(project, { recursive: true });
  pageSocket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, ['affice', `affice.${pageToken}`], { origin: `http://localhost:${PORT}` });
  pageSocket.on('message', (data) => events.push(JSON.parse(String(data)) as ServerEvent));
  await new Promise<void>((resolve, reject) => {
    pageSocket.once('open', () => resolve());
    pageSocket.once('error', reject);
  });
  pageSocket.send(JSON.stringify({ type: 'project.open', path: project }));
  await until(() => events.some((e) => e.type === 'app.state' && e.state.project !== null));
});

after(async () => {
  pageSocket?.close();
  await server?.close();
  await devServer?.close();
});

async function until(check: () => boolean, ms = 8_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// ---------------------------------------------------------------------------------------------- the tokens

test('a route without a token, or with a wrong one, is refused (401); the page token opens it', async () => {
  assert.equal((await http('/api/app')).status, 401);
  assert.equal(json(await http('/api/app')).error, NEEDS_TOKEN);
  assert.equal((await http('/api/app', { headers: { 'x-affice-token': 'nope' } })).status, 401);
  assert.equal((await http('/api/app', { headers: { 'x-affice-token': pageToken.slice(0, -1) + (pageToken.endsWith('0') ? '1' : '0') } })).status, 401);
  assert.equal((await http('/api/app', { headers: { 'x-affice-token': '' } })).status, 401);
  assert.equal((await http('/api/app', { headers: page })).status, 200);
  for (const path of ['/api/office', '/api/claude', '/api/projects', '/api/fs', '/api/data/general/branches', '/api/data/general/reports', '/api/data/general/decisions']) {
    assert.equal((await http(path)).status, 401, `${path} needs the token`);
  }
  assert.equal((await http('/api/claude?refresh=1')).status, 401, 'a refresh that starts a process needs the token too');
});

test('the agent token does not open a page route, and the page token does not open an agent route', async () => {
  for (const path of ['/api/app', '/api/office', '/api/claude', '/api/projects', '/api/fs', '/api/data/general/branches']) {
    assert.equal((await http(path, { headers: agent('general') })).status, 401, `${path} refuses a manager`);
  }
  // The agent routes: the agent token gets in (the answer is the office's own), the page token does not.
  assert.equal((await http('/api/office/departments', { headers: page })).status, 401);
  assert.equal((await http('/api/office/status', { headers: page })).status, 401);
  assert.equal((await http('/api/approvals', { method: 'POST', headers: page, body: { tool: 'Bash' } })).status, 401);
  assert.equal((await http('/api/approvals/perm_x/wait', { headers: page })).status, 401);
  assert.equal((await http('/api/office/ask', { method: 'POST', headers: page, body: { department: 'engineering', message: 'hi' } })).status, 401);
  assert.equal((await http('/api/office/departments')).status, 401);
  const departments = await http('/api/office/departments', { headers: agent('general') });
  assert.equal(departments.status, 200);
  assert.ok((JSON.parse(departments.body) as { id: string }[]).some((d) => d.id === 'general'));
});

test('an agent token is for its own department: another department, a made up one and a missing one are refused', async () => {
  const forgedDepartment = { 'x-affice-token': agentToken('engineering'), 'x-affice-department': 'general' };
  assert.equal((await http('/api/office/departments', { headers: forgedDepartment })).status, 401, "the token of engineering does not speak for general");
  assert.equal((await http('/api/office/departments', { headers: { 'x-affice-token': agentToken('general') } })).status, 401, 'no department named');
  assert.equal((await http('/api/office/departments', { headers: { 'x-affice-token': pageToken, 'x-affice-department': 'general' } })).status, 401, 'the page token is not an agent token');
  assert.equal((await http('/api/office/departments', { headers: { 'x-affice-token': agentToken('general'), 'x-affice-department': '../general' } })).status, 401);
});

test('the socket needs the page token: none, a wrong one, an agent token and a token in the URL are refused', async () => {
  assert.equal((await upgrade(undefined)).outcome, 'status 401');
  assert.equal((await upgrade(['affice'])).outcome, 'status 401');
  assert.equal((await upgrade(['affice', 'affice.wrong'])).outcome, 'status 401');
  assert.equal((await upgrade(['affice', `affice.${agentToken('general')}`])).outcome, 'status 401');
  const inUrl = await new Promise<string>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${pageToken}`, ['affice'], { headers: { host: `localhost:${PORT}` } });
    ws.on('open', () => resolve('open'));
    ws.on('unexpected-response', (_req, res) => resolve(`status ${res.statusCode}`));
    ws.on('error', () => undefined);
  });
  assert.equal(inUrl, 'status 401', 'a token in the URL is not read');
  const good = await upgrade(['affice', `affice.${pageToken}`]);
  assert.equal(good.outcome, 'open');
  assert.equal(good.protocol, 'affice', 'the answer names the plain protocol, so the token is never sent back');
});

test('no secret appears in an answer: not in the headers of the page, nor in an error', async () => {
  for (const reply of [await http('/'), await http('/api/app'), await http('/api/app', { headers: { 'x-affice-token': 'wrong' } }), await http('/api/office/departments', { headers: agent('general') })]) {
    assert.ok(!JSON.stringify(reply.headers).includes(pageToken));
    assert.ok(!JSON.stringify(reply.headers).includes(agentToken('general')));
  }
  const refused = await http('/api/app', { headers: { 'x-affice-token': 'wrong' } });
  assert.ok(!refused.body.includes('wrong'));
});

// ---------------------------------------------------------------------------------------------- origin

test('an exact Origin only: another localhost port, 127.0.0.1 on another port, https, null and app:// are refused even with the token', async () => {
  for (const origin of [`http://localhost:${OTHER_PORT}`, `http://127.0.0.1:${OTHER_PORT}`, 'http://localhost:3000', 'http://[::1]:9999', `https://localhost:${PORT}`, `https://127.0.0.1:${PORT}`, 'app://localhost', 'null', 'http://localhost', `http://localhost.evil.example:${PORT}`, `http://localhost:${PORT}.evil.example`]) {
    const reply = await http('/api/app', { headers: { ...page, origin } });
    assert.equal(reply.status, 403, `Origin ${origin}`);
    const post = await http('/api/approvals', { method: 'POST', headers: { ...agent('general'), origin }, body: { tool: 'Bash' } });
    assert.equal(post.status, 403, `Origin ${origin} on an agent route`);
    assert.equal((await upgrade(['affice', `affice.${pageToken}`], { origin })).outcome, 'status 403', `socket with Origin ${origin}`);
  }
  assert.equal((await http('/api/app', { headers: { ...page, origin: `http://localhost:${PORT}` } })).status, 200);
  assert.equal((await http('/api/app', { headers: { ...page, origin: `http://127.0.0.1:${PORT}`, host: `127.0.0.1:${PORT}` } })).status, 200);
  assert.equal((await upgrade(['affice', `affice.${pageToken}`], { origin: `http://localhost:${PORT}` })).outcome, 'open');
});

test('the Host must be this server\'s own, with its port', async () => {
  for (const host of [`localhost:${OTHER_PORT}`, 'localhost', `127.0.0.1:${OTHER_PORT}`, `[::1]:${PORT}`, `evil.example:${PORT}`, `localhost.evil.example:${PORT}`, `localhost:${PORT}@evil.example`, `0.0.0.0:${PORT}`]) {
    assert.equal((await http('/api/app', { headers: { ...page, host } })).status, 403, `Host ${host}`);
  }
  assert.equal((await http('/api/app', { headers: { ...page, host: `LOCALHOST:${PORT}` } })).status, 200, 'the host name is case-insensitive');
});

test('Sec-Fetch-Site: same-site and cross-site are refused (another local port is same-site); same-origin and none pass', async () => {
  for (const site of ['same-site', 'cross-site']) {
    assert.equal((await http('/api/app', { headers: { ...page, 'sec-fetch-site': site } })).status, 403, `${site} on a page route`);
    assert.equal((await http('/api/office/departments', { headers: { ...agent('general'), 'sec-fetch-site': site } })).status, 403, `${site} on an agent route`);
    assert.equal((await upgrade(['affice', `affice.${pageToken}`], { 'sec-fetch-site': site })).outcome, 'status 403', `${site} on the socket`);
  }
  for (const site of ['same-origin', 'none']) {
    assert.equal((await http('/api/app', { headers: { ...page, 'sec-fetch-site': site } })).status, 200, site);
  }
  assert.equal((await upgrade(['affice', `affice.${pageToken}`], { 'sec-fetch-site': 'same-origin' })).outcome, 'open');
});

test('a request with no Origin still needs the token', async () => {
  assert.equal((await http('/api/app')).status, 401);
  assert.equal((await http('/api/office/ask', { method: 'POST', body: { department: 'engineering', message: 'hi' } })).status, 401);
  assert.equal((await upgrade(['affice'])).outcome, 'status 401');
});

test('the development origin is the one extra, and only when it is exactly http://localhost:<port> or 127.0.0.1', async () => {
  assert.equal(parseDevOrigin('http://localhost:5190'), 'http://localhost:5190');
  assert.equal(parseDevOrigin('http://127.0.0.1:5190'), 'http://127.0.0.1:5190');
  for (const bad of [undefined, null, '', 'http://localhost', 'http://localhost:5190/', 'http://localhost:5190/path', 'https://localhost:5190', 'http://evil.example:5190', 'http://localhost.evil.example:5190', 'localhost:5190', 'http://user@localhost:5190', '*']) {
    assert.equal(parseDevOrigin(bad as string | undefined), null, String(bad));
  }
  const policy = originPolicy(PORT, 'http://localhost:5190');
  assert.deepEqual([...policy.origins].sort(), ['http://127.0.0.1:5401', 'http://localhost:5190', 'http://localhost:5401']);
  assert.deepEqual([...originPolicy(PORT, 'http://evil.example:1').origins].sort(), ['http://127.0.0.1:5401', 'http://localhost:5401']);

  // The second server trusts the page on 5403 (Vite behind a proxy keeps that Host and Origin) and no other port.
  const viaProxy = { host: `localhost:${OTHER_PORT}` };
  assert.equal((await http('/api/app', { port: DEV_PORT, headers: { ...page, ...viaProxy, origin: `http://localhost:${OTHER_PORT}` } })).status, 200);
  assert.equal((await http('/api/app', { port: DEV_PORT, headers: { ...page, ...viaProxy } })).status, 200, 'a same-origin GET through the proxy has a Host and no Origin');
  assert.equal((await http('/api/app', { port: DEV_PORT, headers: { ...page, origin: 'http://localhost:5404', host: 'localhost:5404' } })).status, 403);
  assert.equal((await http('/api/app', { port: DEV_PORT, headers: { ...page, origin: `http://localhost:${DEV_PORT}` } })).status, 200, 'its own origin still works');
  assert.equal((await upgrade(['affice', `affice.${pageToken}`], { origin: `http://localhost:${OTHER_PORT}`, host: `localhost:${OTHER_PORT}` }, DEV_PORT)).outcome, 'open');
  // The first server has no development origin: the same page is refused.
  assert.equal((await http('/api/app', { headers: { ...page, ...viaProxy, origin: `http://localhost:${OTHER_PORT}` } })).status, 403);
});

// ---------------------------------------------------------------------------------------------- the page and its token

test('index.html carries the token; GET /api/session gives it to a same-origin request only', async () => {
  const html = await http('/');
  assert.equal(html.status, 200);
  assert.match(html.body, new RegExp(`<meta name="affice-token" content="${pageToken}">`));
  assert.match(html.body, /^<!doctype html>/i, 'the doctype stays first');
  assert.equal(html.headers['cache-control'], 'no-store');
  const none = await http('/', { headers: { 'sec-fetch-site': 'none' } });
  assert.match(none.body, /affice-token/);
  for (const site of ['cross-site', 'same-site']) {
    const foreign = await http('/', { headers: { 'sec-fetch-site': site } });
    assert.equal(foreign.status, 200);
    assert.doesNotMatch(foreign.body, /affice-token/, `no token for ${site}`);
    assert.ok(!foreign.body.includes(pageToken));
  }
  assert.doesNotMatch((await http('/assets/index-abc123.js')).body, /affice-token/);

  const same = await http('/api/session', { headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(same.status, 200);
  assert.equal(json(same).token, pageToken);
  assert.equal(json(await http('/api/session', { headers: { origin: `http://localhost:${PORT}` } })).token, pageToken, 'a POST-like request names its Origin');
  assert.equal(json(await http('/api/session', { headers: { origin: `http://127.0.0.1:${PORT}`, 'sec-fetch-site': 'same-origin', host: `127.0.0.1:${PORT}` } })).token, pageToken);
  const foreignSession: Record<string, string>[] = [
    {},
    { origin: `http://localhost:${OTHER_PORT}` },
    { origin: `http://localhost:${OTHER_PORT}`, 'sec-fetch-site': 'same-origin' },
    { origin: 'https://evil.example' },
    { 'sec-fetch-site': 'same-site' },
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'none' },
    { origin: 'null' },
  ];
  for (const headers of foreignSession) {
    const reply = await http('/api/session', { headers });
    assert.equal(reply.status, 403, JSON.stringify(headers));
    assert.ok(!reply.body.includes(pageToken));
  }
  assert.equal((await http('/api/session', { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' }, body: {} })).status, 405);
});

// ---------------------------------------------------------------------------------------------- headers

test('every answer carries the frame ban, the CSP, nosniff, no referrer and COOP', async () => {
  const replies: [string, Reply][] = [
    ['the page', await http('/')],
    ['an asset', await http('/assets/index-abc123.js')],
    ['a missing asset', await http('/assets/missing.js')],
    ['an API answer', await http('/api/app', { headers: page })],
    ['a refusal', await http('/api/app')],
    ['an unknown API path', await http('/api/nothing', { headers: page })],
    ['a 403 for the Host', await http('/api/app', { headers: { host: 'evil.example' } })],
    ['a 403 for the Origin', await http('/', { headers: { origin: 'https://evil.example' } })],
    ['the session answer', await http('/api/session', { headers: { 'sec-fetch-site': 'same-origin' } })],
    ['an agent route', await http('/api/office/departments', { headers: agent('general') })],
  ];
  for (const [label, reply] of replies) {
    assert.equal(reply.headers['x-frame-options'], 'DENY', label);
    const csp = String(reply.headers['content-security-policy']);
    assert.match(csp, /frame-ancestors 'none'/, label);
    assert.match(csp, /default-src 'self'/, label);
    assert.match(csp, /script-src 'self'(;|$)/, label);
    assert.doesNotMatch(csp, /unsafe-eval|script-src[^;]*unsafe-inline/, label);
    assert.match(csp, /img-src 'self' data:/, label);
    assert.match(csp, /connect-src 'self' ws:\/\/localhost:5401 ws:\/\/127\.0\.0\.1:5401/, label);
    assert.match(csp, /frame-src http:\/\/localhost:\* http:\/\/127\.0\.0\.1:\*/, label);
    assert.match(csp, /object-src 'none'/, label);
    assert.equal(reply.headers['x-content-type-options'], 'nosniff', label);
    assert.equal(reply.headers['referrer-policy'], 'no-referrer', label);
    assert.equal(reply.headers['cross-origin-opener-policy'], 'same-origin', label);
  }
});

// ---------------------------------------------------------------------------------------------- reports

test('an HTML report is served sandboxed with no scripts and no network, and opens with a ticket for that file only', async () => {
  const reports = join(project, 'Office', 'reports');
  mkdirSync(reports, { recursive: true });
  const html = join(reports, '2026-10-20-report.html');
  const other = join(reports, 'other.html');
  writeFileSync(html, '<h1>Report</h1><script>fetch("/api/app")</script><img src="https://evil.example/x.png">');
  writeFileSync(other, '<h1>Other</h1>');
  const url = (path: string, extra = '') => `/api/data/general/report?path=${encodeURIComponent(path)}${extra}`;

  assert.equal((await http(url(html))).status, 401, 'a report needs the token or a ticket');
  assert.equal((await http(url(html), { headers: agent('general') })).status, 401, 'a manager cannot open it');
  const served = await http(url(html), { headers: page });
  assert.equal(served.status, 200);
  assert.equal(served.headers['content-security-policy'], "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  assert.equal(served.headers['content-disposition'], 'inline');
  assert.equal(served.headers['x-content-type-options'], 'nosniff');
  assert.equal(served.headers['x-frame-options'], 'DENY');
  assert.equal(served.headers['referrer-policy'], 'no-referrer');
  assert.match(String(served.headers['content-type']), /text\/html/);

  // A link cannot send the header: the page asks (with its token) for a ticket for this one file.
  assert.equal((await http(`/api/data/general/report-ticket?path=${encodeURIComponent(html)}`)).status, 401, 'no ticket without the token');
  assert.equal((await http(`/api/data/general/report-ticket?path=${encodeURIComponent(html)}`, { headers: agent('general') })).status, 401);
  assert.equal((await http('/api/data/general/report-ticket', { headers: page })).status, 400);
  assert.equal((await http(`/api/data/nobody/report-ticket?path=${encodeURIComponent(html)}`, { headers: page })).status, 404);
  const { ticket } = json(await http(`/api/data/general/report-ticket?path=${encodeURIComponent(html)}`, { headers: page })) as { ticket: string };
  assert.match(ticket, /^\d+\.[0-9a-f]{64}$/);
  const byTicket = await http(url(html, `&ticket=${encodeURIComponent(ticket)}`));
  assert.equal(byTicket.status, 200);
  assert.match(byTicket.body, /<h1>Report<\/h1>/);
  assert.equal(byTicket.headers['content-security-policy'], "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  assert.equal((await http(url(other, `&ticket=${encodeURIComponent(ticket)}`))).status, 401, 'the ticket opens that file only');
  assert.equal((await http(`/api/data/engineering/report?path=${encodeURIComponent(html)}&ticket=${encodeURIComponent(ticket)}`)).status, 401, 'and only for that department');
  assert.equal((await http(url(html, '&ticket=1.abc'))).status, 401);
  assert.equal((await http(url(html, `&ticket=${encodeURIComponent(ticket.replace(/^\d+/, '99999999999999'))}`))).status, 401, 'a longer life breaks the signature');
  assert.equal((await http('/api/app', { headers: {} })).status, 401);
  assert.equal((await http(`/api/app?ticket=${encodeURIComponent(ticket)}`)).status, 401, 'a ticket opens no other route');
  assert.equal((await http(url(html, `&ticket=${encodeURIComponent(ticket)}`), { headers: { origin: `http://localhost:${OTHER_PORT}` } })).status, 403, 'and not for another local page');
});

// ---------------------------------------------------------------------------------------------- the caller

test('the caller of an approval is the department of the agent token, not a field of the body; the cards of others are out of reach', async () => {
  const created = await http('/api/approvals', { method: 'POST', headers: agent('general'), body: { department: 'engineering', tool: 'Edit', input: { file_path: '/tmp/x' }, toolUseId: null } });
  assert.equal(created.status, 200);
  const { id } = json(created) as { id: string };
  const snapshot = json(await http('/api/office', { headers: page })) as unknown as { permissions: { id: string; department: string }[] };
  const card = snapshot.permissions.find((p) => p.id === id);
  assert.equal(card?.department, 'general', 'the body said engineering; the token says general');

  assert.equal((await http(`/api/approvals/${id}/wait`, { headers: agent('engineering') })).status, 404, 'another manager cannot wait for it');
  assert.equal((await http(`/api/approvals/${id}/cancel`, { method: 'POST', headers: agent('engineering') })).status, 404, 'nor cancel it');
  assert.ok(((json(await http('/api/office', { headers: page })) as unknown as { permissions: { id: string }[] }).permissions).some((p) => p.id === id), 'the card is still open');

  // Only the page answers: the agent socket is refused, the page socket answers.
  assert.equal((await upgrade(['affice', `affice.${agentToken('general')}`])).outcome, 'status 401');
  const resolved = new Promise<ServerEvent>((resolve) => {
    pageSocket.on('message', (data) => {
      const event = JSON.parse(String(data)) as ServerEvent;
      if (event.type === 'permission.resolved' && event.id === id) resolve(event);
    });
  });
  pageSocket.send(JSON.stringify({ type: 'permission.answer', id, allow: true }));
  assert.equal(((await resolved) as { allow: boolean }).allow, true);
  const waited = await http(`/api/approvals/${id}/wait`, { headers: agent('general') });
  assert.deepEqual(json(waited), { status: 'answered', allow: true });

  assert.equal((await http('/api/approvals', { method: 'POST', headers: agent('general'), body: { tool: 7 } })).status, 400);
});

test('ask_manager takes its caller from the token: a forged from changes nothing, an unknown caller is refused', async () => {
  const ask = (as: string, body: unknown) => http('/api/office/ask', { method: 'POST', headers: agent(as), body });
  const forged = await ask('general', { from: 'nobody', department: 'general', message: 'hi' });
  assert.equal(forged.status, 400);
  assert.match(json(forged).error!, /General manager cannot ask itself/, 'from: nobody would have been a 404; the caller is general');
  // The body names a real caller (general), the token names a department that is not in this office: the token wins.
  const forgedAsOther = await ask('engineering', { from: 'general', department: 'general', message: 'hi' });
  assert.equal(forgedAsOther.status, 404);
  assert.match(json(forgedAsOther).error!, /no department engineering to ask from/);
  const ghost = await ask('ghost', { department: 'general', message: 'hi' });
  assert.equal(ghost.status, 404);
  assert.match(json(ghost).error!, /no department ghost to ask from/);
  assert.equal((await ask('general', { message: 'hi' })).status, 400);
});

test('with no project open an agent route passes the gate and gets the office\'s own answer', async () => {
  const none = await startServer({ port: 5404, clientDir: null, project: null, log: () => undefined, host: { seams }, devOrigin: null });
  try {
    assert.equal((await http('/api/office/departments', { port: 5404 })).status, 401);
    const reply = await http('/api/office/departments', { port: 5404, headers: agent('general') });
    assert.equal(reply.status, 409);
    assert.equal(json(reply).error, NO_PROJECT);
  } finally {
    await none.close();
  }
});

// ---------------------------------------------------------------------------------------------- the MCP server

interface Mcp {
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  stop(): void;
}

/** The real approvals MCP server as a child process, with the environment the driver would give it. */
function startMcp(env: Record<string, string>): Mcp {
  const child = spawn(process.execPath, ['--import', 'tsx', join(import.meta.dirname, 'claude', 'approvals-mcp.ts')], {
    env: { ...process.env, AFFICE_URL: `http://127.0.0.1:${PORT}`, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const waiting = new Map<number, (message: { result?: { content: { text: string }[]; isError?: boolean } }) => void>();
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line) as { id?: number; result?: { content: { text: string }[]; isError?: boolean } };
      if (message.id !== undefined) waiting.get(message.id)?.(message);
    }
  });
  let next = 1;
  return {
    call(name, args) {
      const id = next++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`the MCP server did not answer ${name}`)), 20_000);
        waiting.set(id, (message) => {
          clearTimeout(timer);
          resolve({ text: message.result?.content[0]?.text ?? '', isError: message.result?.isError === true });
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`);
      });
    },
    stop() {
      child.kill('SIGTERM');
    },
  };
}

test('the approvals MCP server sends its token: an approval waits for the page, and a wrong or missing token is denied', async () => {
  const mcp = startMcp({ AFFICE_DEPARTMENT: 'general', AFFICE_AGENT_TOKEN: agentToken('general') });
  const wrong = startMcp({ AFFICE_DEPARTMENT: 'general', AFFICE_AGENT_TOKEN: agentToken('engineering') });
  const none = startMcp({ AFFICE_DEPARTMENT: 'general', AFFICE_AGENT_TOKEN: '' });
  try {
    const decision = mcp.call('approve', { tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'toolu_1' });
    const open = async () => ((json(await http('/api/office', { headers: page })) as unknown as { permissions: { id: string; department: string; tool: string }[] }).permissions);
    await until(() => events.length > 0);
    let card: { id: string; department: string; tool: string } | undefined;
    for (let i = 0; i < 100 && !card; i += 1) {
      card = (await open()).find((p) => p.tool === 'Bash');
      if (!card) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(card, 'the card reached the page');
    assert.equal(card.department, 'general');
    pageSocket.send(JSON.stringify({ type: 'permission.answer', id: card.id, allow: true }));
    const answered = await decision;
    assert.equal((JSON.parse(answered.text) as { behavior: string }).behavior, 'allow');

    const listed = await mcp.call('list_departments', {});
    assert.equal(listed.isError, false);
    assert.match(listed.text, /"id": "general"/);

    const denied = await wrong.call('approve', { tool_name: 'Bash', input: { command: 'rm -rf /' } });
    const refusal = JSON.parse(denied.text) as { behavior: string; message: string };
    assert.equal(refusal.behavior, 'deny');
    assert.match(refusal.message, /did not accept the approval request/);
    assert.equal((await open()).some((p) => p.tool === 'Bash' && p.id !== card.id), false, 'no card was made for a wrong token');
    const noList = await wrong.call('list_departments', {});
    assert.equal(noList.isError, true);

    const missing = JSON.parse((await none.call('approve', { tool_name: 'Bash', input: {} })).text) as { behavior: string; message: string };
    assert.equal(missing.behavior, 'deny');
    assert.match(missing.message, /has no token/);
    assert.equal((await none.call('ask_manager', { department: 'engineering', message: 'hi' })).isError, true);
  } finally {
    mcp.stop();
    wrong.stop();
    none.stop();
  }
});
