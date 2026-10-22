// The routes: an unknown department, the three views, and the report route, which must serve
// a file only from the department's report folders (symlinks resolved).

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { isRawResponse, RouteError, type RouteRequest } from '../../shared/server-api';
import type { Department } from '../../shared/types';
import { registerDataRoutes } from './index';

type Handler = (request: RouteRequest) => Promise<unknown> | unknown;

describe('data routes', () => {
  let root = '';
  const handlers = new Map<string, Handler>();
  let department: Department;

  const call = (pattern: string, params: Record<string, string>, query: Record<string, string> = {}) => {
    const handler = handlers.get(pattern);
    assert.ok(handler, `${pattern} is registered`);
    return Promise.resolve().then(() => handler({ params, query: new URLSearchParams(query) }));
  };
  const status = async (promise: Promise<unknown>): Promise<number> => {
    try {
      await promise;
    } catch (error) {
      assert.ok(error instanceof RouteError, 'a RouteError, not a crash');
      return error.status;
    }
    return 200;
  };

  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'office-routes-')));
    mkdirSync(join(root, 'reports', 'sub'), { recursive: true });
    mkdirSync(join(root, 'secret'));
    writeFileSync(join(root, 'reports', 'a.md'), '# A\n');
    writeFileSync(join(root, 'reports', 'page.html'), '<title>P</title>');
    writeFileSync(join(root, 'reports', 'data.json'), '{}');
    writeFileSync(join(root, 'reports', 'sub', 'deep.md'), '# Deep\n');
    writeFileSync(join(root, 'secret', 'private.md'), '# Private\n');
    symlinkSync(join(root, 'secret', 'private.md'), join(root, 'reports', 'link.md'));
    mkdirSync(join(root, 'reports', 'dir.md'));
    department = {
      id: 'dev', name: 'Dev', color: 'indigo', responsibility: '', cwd: root, model: 'claude-sonnet-5-5', permission: 'ask',
      repos: [], reportDirs: ['reports'], trellaBoardId: null, sessionId: null, slot: 0, createdAt: '2026-10-17T00:00:00.000Z',
    };
    registerDataRoutes(
      { get: (pattern, handler) => void handlers.set(pattern, handler) },
      { root, project: root, trellaCli: '', trellaUrl: 'http://127.0.0.1:4174' },
      { byId: (id) => (id === 'dev' ? department : null) },
    );
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  it('registers the four routes and answers 404 for an unknown department', async () => {
    for (const view of ['branches', 'reports', 'decisions', 'report']) {
      assert.equal(await status(call(`/api/data/:department/${view}`, { department: 'nope' })), 404);
    }
  });

  it('lists the reports of the department, not a link that leaves the folder (SEC-13)', async () => {
    const view = (await call('/api/data/:department/reports', { department: 'dev' })) as { reports: Array<{ file: string; path: string }> };
    assert.deepEqual(view.reports.map((r) => r.file).sort(), ['a.md', 'page.html'], 'link.md points at secret/private.md and is not listed');
    // The listing and the route agree: whatever is listed is served, and the link the route refuses is not listed.
    for (const report of view.reports) {
      assert.ok(isRawResponse(await call('/api/data/:department/report', { department: 'dev' }, { path: report.path })), report.file);
    }
    assert.equal(await status(call('/api/data/:department/report', { department: 'dev' }, { path: join(root, 'reports', 'link.md') })), 403);
  });

  it('serves a report from a report folder, markdown as text and html sandboxed', async () => {
    const path = (file: string) => join(root, 'reports', file);
    const md = await call('/api/data/:department/report', { department: 'dev' }, { path: path('a.md') });
    assert.ok(isRawResponse(md));
    assert.deepEqual([md.contentType, md.body], ['text/markdown; charset=utf-8', '# A\n']);

    const html = await call('/api/data/:department/report', { department: 'dev' }, { path: path('page.html') });
    assert.ok(isRawResponse(html));
    assert.equal(html.contentType, 'text/html; charset=utf-8');
    assert.equal(html.headers?.['content-security-policy'], "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:", 'no scripts, no network, no navigation (SEC-12)');
    assert.equal(html.headers?.['content-disposition'], 'inline');

    const deep = await call('/api/data/:department/report', { department: 'dev' }, { path: path('sub/deep.md') });
    assert.ok(isRawResponse(deep));
  });

  it('refuses everything else: outside, traversal, symlink out, other types, relative, missing', async () => {
    const ask = (path: string | undefined) =>
      status(call('/api/data/:department/report', { department: 'dev' }, path === undefined ? {} : { path }));
    assert.equal(await ask(join(root, 'secret', 'private.md')), 403, 'outside the folders');
    assert.equal(await ask(join(root, 'reports', '..', 'secret', 'private.md')), 403, 'traversal');
    assert.equal(await ask(join(root, 'reports', 'link.md')), 403, 'a symlink that leaves the folder');
    assert.equal(await ask(join(root, 'reports', 'data.json')), 403, 'not a report type');
    assert.equal(await ask('/etc/hosts'), 403, 'another place on the disk');
    assert.equal(await ask('/nonexistent/place.md'), 403, 'a probe learns nothing about other files');
    assert.equal(await ask('reports/a.md'), 400, 'relative');
    assert.equal(await ask(undefined), 400, 'no path');
    assert.equal(await ask(join(root, 'reports', 'gone.md')), 404, 'missing');
    assert.equal(await ask(join(root, 'reports', 'dir.md')), 404, 'a folder named like a report');
  });

  it('recognises only the raw response shape', () => {
    assert.equal(isRawResponse({ contentType: 'text/html', body: '' }), true);
    assert.equal(isRawResponse({ generatedAt: 'x', reports: [] }), false);
    assert.equal(isRawResponse({ contentType: 'text/html', body: '', extra: 1 }), false);
    assert.equal(isRawResponse(null), false);
  });
});
