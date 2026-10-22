// The secrets of server/auth.ts and the refresh gate of server/coalesce.ts.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import type { AppState, ClaudeStatus } from '../shared/types';
import { agentToken, AGENT_TOKEN_ENV, checkAgent, checkPage, checkTicket, makeTicket, pageToken, requestToken, safeEqual, TICKET_TTL_MS } from './auth';
import { RefreshGate } from './coalesce';
import type { HostHandle } from './host';
import { registerClaudeRoutes } from './claude/setup';
import { HttpRouter } from './router';
import { withToken } from './static';

const req = (headers: Record<string, string>) => ({ headers });

test('the page token is 32 random bytes as hex; an agent token is per department and not the page token', () => {
  assert.match(pageToken, /^[0-9a-f]{64}$/);
  assert.match(agentToken('general'), /^[0-9a-f]{64}$/);
  assert.equal(agentToken('general'), agentToken('general'), 'stable inside one process');
  assert.notEqual(agentToken('general'), agentToken('engineering'));
  assert.notEqual(agentToken('general'), pageToken);
  assert.equal(AGENT_TOKEN_ENV, 'AFFICE_AGENT_TOKEN');
});

test('checkPage reads the header or the socket subprotocol, and only the page token passes', () => {
  assert.equal(checkPage(req({ 'x-affice-token': pageToken })), true);
  assert.equal(checkPage(req({ 'sec-websocket-protocol': `affice, affice.${pageToken}` })), true);
  assert.equal(checkPage(req({ 'sec-websocket-protocol': `affice.${pageToken}` })), true);
  assert.equal(checkPage(req({})), false);
  assert.equal(checkPage(req({ 'x-affice-token': 'x' })), false);
  assert.equal(checkPage(req({ 'x-affice-token': `${pageToken}0` })), false);
  assert.equal(checkPage(req({ 'x-affice-token': agentToken('general') })), false);
  assert.equal(checkPage(req({ 'sec-websocket-protocol': 'affice' })), false);
  assert.equal(checkPage(req({ 'sec-websocket-protocol': `affice.${agentToken('general')}` })), false);
  assert.equal(requestToken(req({ 'x-affice-token': ' abc ' })), 'abc');
});

test('checkAgent returns the department only for that department\'s token', () => {
  assert.equal(checkAgent(req({ 'x-affice-token': agentToken('general'), 'x-affice-department': 'general' })), 'general');
  assert.equal(checkAgent(req({ 'x-affice-token': agentToken('engineering'), 'x-affice-department': 'general' })), null);
  assert.equal(checkAgent(req({ 'x-affice-token': agentToken('general') })), null);
  assert.equal(checkAgent(req({ 'x-affice-department': 'general' })), null);
  assert.equal(checkAgent(req({ 'x-affice-token': pageToken, 'x-affice-department': 'general' })), null);
  assert.equal(checkAgent(req({ 'x-affice-token': agentToken('General'), 'x-affice-department': 'General' })), null, 'not a department id');
  assert.equal(checkAgent(req({ 'sec-websocket-protocol': `affice.${agentToken('general')}`, 'x-affice-department': 'general' })), null, 'the socket does not take agents');
});

test('safeEqual compares whole strings', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', ''), true);
});

test('a ticket opens one scope for a minute', () => {
  const now = 1_000_000;
  const ticket = makeTicket('report:general:/a.html', now);
  assert.equal(checkTicket(ticket, 'report:general:/a.html', now), true);
  assert.equal(checkTicket(ticket, 'report:general:/a.html', now + TICKET_TTL_MS), true);
  assert.equal(checkTicket(ticket, 'report:general:/a.html', now + TICKET_TTL_MS + 1), false, 'expired');
  assert.equal(checkTicket(ticket, 'report:general:/b.html', now), false, 'another scope');
  assert.equal(checkTicket(ticket, 'report:engineering:/a.html', now), false);
  assert.equal(checkTicket('', 'report:general:/a.html', now), false);
  assert.equal(checkTicket('12.', 'report:general:/a.html', now), false);
  assert.equal(checkTicket('x.y', 'report:general:/a.html', now), false);
  assert.equal(checkTicket(ticket.replace(/^\d+/, '99999999999'), 'report:general:/a.html', now), false, 'the expiry is signed');
});

test('the token goes after <head> (or after the doctype), never before the doctype', () => {
  assert.equal(withToken('<!doctype html><html><head><title>x</title></head></html>', 'T'), '<!doctype html><html><head><meta name="affice-token" content="T"><title>x</title></head></html>');
  assert.equal(withToken('<!doctype html><title>x</title>', 'T'), '<!doctype html><meta name="affice-token" content="T"><title>x</title>');
  assert.equal(withToken('<title>x</title>', 'T'), '<meta name="affice-token" content="T"><title>x</title>');
});

test('a refresh runs once while it runs, and not again within the gap', async () => {
  let clock = 0;
  const gate = new RefreshGate(5_000, () => clock);
  let runs = 0;
  let release: () => void = () => undefined;
  const refresh = () => new Promise<string>((resolve) => {
    runs += 1;
    release = () => resolve(`fresh ${runs}`);
  });
  const held = () => 'held';
  const calls = [gate.run('a', refresh, held), gate.run('a', refresh, held), gate.run('a', refresh, held)];
  release();
  assert.deepEqual(await Promise.all(calls), ['fresh 1', 'fresh 1', 'fresh 1'], 'the callers share one run');
  assert.equal(runs, 1);
  clock = 4_999;
  assert.equal(await gate.run('a', refresh, held), 'held', 'inside the gap the held answer');
  assert.equal(runs, 1);
  assert.equal(await Promise.all([gate.run('b', async () => 'other', held)]).then((r) => r[0]), 'other', 'another key is its own gate');
  clock = 5_000;
  const again = gate.run('a', refresh, held);
  release();
  assert.equal(await again, 'fresh 2');
  assert.equal(runs, 2);
});

test('a failed refresh does not block the next one', async () => {
  const gate = new RefreshGate(0);
  await assert.rejects(gate.run('a', () => Promise.reject(new Error('boom')), () => 'held'), /boom/);
  assert.equal(await gate.run('a', async () => 'fine', () => 'held'), 'fine');
});

test('GET /api/claude?refresh=1 runs `claude` once for a burst of calls', async () => {
  const held: ClaudeStatus = { installed: true, path: '/x/claude', version: '2.1.287', minVersion: '2.1.211', tooOld: false, signedIn: true, authMethod: 'claude.ai', signingIn: false, loginUrl: null, error: null };
  let refreshed = 0;
  const host = {
    appState: () => ({ claude: held, project: null, recent: [] }) satisfies AppState,
    refreshClaude: async () => {
      refreshed += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { ...held, authMethod: 'oauth_token' };
    },
  } as unknown as HostHandle;
  const router = new HttpRouter();
  registerClaudeRoutes(router, host);
  const server = createServer((req2, res) => void router.handle(req2, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const burst = await Promise.all(Array.from({ length: 10 }, () => fetch(`${base}/api/claude?refresh=1`).then((r) => r.json() as Promise<ClaudeStatus>)));
    assert.equal(refreshed, 1, 'ten requests, one process run');
    assert.ok(burst.every((s) => s.authMethod === 'oauth_token'));
    await fetch(`${base}/api/claude?refresh=1`);
    assert.equal(refreshed, 1, 'a call right after is answered from the held status');
    await fetch(`${base}/api/claude`);
    assert.equal(refreshed, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
