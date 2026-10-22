import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { RouteError } from '../shared/server-api';
import { HttpRouter, matchPath, sendJson } from './router';

test('patterns match whole paths and decode :params', () => {
  const segments = '/api/data/:department/branches'.split('/').filter(Boolean);
  assert.deepEqual(matchPath(segments, '/api/data/engineering/branches'), { department: 'engineering' });
  assert.deepEqual(matchPath(segments, '/api/data/a%20b/branches'), { department: 'a b' });
  assert.equal(matchPath(segments, '/api/data/engineering/reports'), null);
  assert.equal(matchPath(segments, '/api/data/engineering/branches/x'), null);
  assert.equal(matchPath(segments, '/api/data/%E0%A4/branches'), null);
});

let server: Server;
let base: string;

before(async () => {
  const router = new HttpRouter();
  router.get('/api/data/:department/:view', ({ params, query }) => ({ params, q: query.get('q') }));
  router.get('/api/missing/:id', ({ params }) => {
    throw new RouteError(404, `No ${params.id}`);
  });
  router.get('/api/broken', () => {
    throw new Error('boom');
  });
  router.post('/api/echo', ({ body }) => ({ body }));
  router.get('/api/file', () => ({ contentType: 'text/markdown; charset=utf-8', body: '# Report', headers: { 'x-content-type-options': 'nosniff' } }));
  server = createServer((req, res) => {
    void router.handle(req, res).then((handled) => handled || sendJson(res, 404, { error: 'Not found' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

test('handlers answer JSON with their params and query', async () => {
  const res = await fetch(`${base}/api/data/engineering/branches?q=x`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  assert.deepEqual(await res.json(), { params: { department: 'engineering', view: 'branches' }, q: 'x' });
});

test('RouteError sets the status, other errors are 500, unknown paths 404, wrong methods 405', async () => {
  const missing = await fetch(`${base}/api/missing/7`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'No 7' });
  assert.equal((await fetch(`${base}/api/broken`)).status, 500);
  assert.equal((await fetch(`${base}/api/nothing`)).status, 404);
  assert.equal((await fetch(`${base}/api/echo`)).status, 405);
});

test('a {contentType, body} result is sent as the file itself', async () => {
  const res = await fetch(`${base}/api/file`);
  assert.equal(res.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await res.text(), '# Report');
});

test('POST bodies are parsed as JSON, and bad JSON is a 400', async () => {
  const ok = await fetch(`${base}/api/echo`, { method: 'POST', body: JSON.stringify({ a: 1 }), headers: { 'content-type': 'application/json' } });
  assert.deepEqual(await ok.json(), { body: { a: 1 } });
  const bad = await fetch(`${base}/api/echo`, { method: 'POST', body: '{nope' });
  assert.equal(bad.status, 400);
});
