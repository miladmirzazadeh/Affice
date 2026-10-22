import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initWorkspace, readRuntime, type Workspace } from '@trella/core';
import { startServer, type RunningService } from './index.js';

let root: string;
let workspace: Workspace;
let service: RunningService;
let base: string;

const agentHeader = JSON.stringify({ type: 'agent', id: 'agent:codex', name: 'Codex' });

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

async function json<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  return (await (await api(path, init)).json()) as T;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'trella-server-'));
  workspace = initWorkspace(root, { workspaceName: 'Test project' });
  service = await startServer({ workspace, port: 0, webRoot: null, version: 'test' });
  base = service.url;
});

afterEach(async () => {
  await service.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('service lifecycle', () => {
  it('publishes its address so the CLI and MCP server can find it', () => {
    const runtime = readRuntime(workspace);
    expect(runtime?.url).toBe(service.url);
    expect(runtime?.pid).toBe(process.pid);
  });

  it('removes the published address on stop', async () => {
    await service.stop();
    expect(existsSync(join(workspace.dir, 'service.json'))).toBe(false);
  });

  it('answers a health check', async () => {
    const health = await json('/api/health');
    expect(health.ok).toBe(true);
    expect(health.workspace).toBe('Test project');
    expect(health.boards).toBe(1);
  });
});

describe('workspace, projects and boards', () => {
  it('starts with a general project and one board on the default workflow', async () => {
    const summary = await json('/api/workspace');
    expect(summary.projects.map((project: any) => project.id)).toEqual(['general']);
    expect(summary.boards).toHaveLength(1);
    expect(summary.boards[0].columns.map((column: any) => column.id)).toEqual([
      'backlog',
      'to-do',
      'in-progress',
      'review',
      'done',
      'failed',
    ]);
  });

  it('creates a project and a board with custom columns', async () => {
    const { project } = await json('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'Platform', description: 'Under the hood' }),
      headers: { 'x-trella-actor': agentHeader },
    });
    expect(project.id).toBe('platform');

    const created = await api('/api/boards', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Research',
        projectId: 'platform',
        description: 'Open questions',
        columns: [{ name: 'Questions' }, { name: 'Answered', terminal: true }],
      }),
      headers: { 'x-trella-actor': agentHeader },
    });
    expect(created.status).toBe(201);
    const { board } = await created.json();
    expect(board.projectId).toBe('platform');
    expect(board.columns.map((column: any) => column.id)).toEqual(['questions', 'answered']);
    expect(board.createdBy.name).toBe('Codex');
  });

  it('serves a specific board and scopes its cards', async () => {
    const { board } = await json('/api/boards', {
      method: 'POST',
      body: JSON.stringify({ name: 'Sprint 1' }),
    });
    await json('/api/cards', {
      method: 'POST',
      body: JSON.stringify({ boardId: board.id, title: 'Scoped card' }),
    });
    await json('/api/cards', { method: 'POST', body: JSON.stringify({ title: 'Default board' }) });

    const scoped = await json(`/api/board?board=${board.id}`);
    expect(scoped.board.id).toBe(board.id);
    expect(scoped.cards.map((card: any) => card.title)).toEqual(['Scoped card']);

    const byName = await json('/api/board?board=sprint-1');
    expect(byName.board.id).toBe(board.id);
  });

  it('adds, edits and removes a column, keeping the cards', async () => {
    const summary = await json('/api/workspace');
    const boardId = summary.boards[0].id;

    const added = await api(`/api/boards/${boardId}/columns`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Blocked', color: 'rose', position: 1 }),
    });
    expect(added.status).toBe(201);
    expect((await added.json()).board.columns[1].name).toBe('Blocked');

    const renamed = await json(`/api/boards/${boardId}/columns/blocked`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'On hold', color: 'amber' }),
    });
    expect(renamed.board.columns[1].name).toBe('On hold');
    expect(renamed.board.columns[1].id).toBe('blocked');

    await json('/api/cards', {
      method: 'POST',
      body: JSON.stringify({ title: 'Waiting', status: 'blocked' }),
    });
    const removed = await json(`/api/boards/${boardId}/columns/blocked/delete`, {
      method: 'POST',
      body: JSON.stringify({ moveCardsTo: 'to-do' }),
    });
    expect(removed.board.columns.some((column: any) => column.id === 'blocked')).toBe(false);

    const cards = await json('/api/cards?status=to-do');
    expect(cards.cards.map((card: any) => card.title)).toEqual(['Waiting']);
  });

  it('explains an unknown board instead of guessing', async () => {
    const response = await api('/api/board?board=nowhere');
    expect(response.status).toBe(404);
    const payload = await response.json();
    expect(payload.error.code).toBe('not_found');
    expect(payload.error.available).toBeDefined();
  });
});

describe('cards', () => {
  it('creates, reads, moves and comments on a card', async () => {
    const created = await api('/api/cards', {
      method: 'POST',
      body: JSON.stringify({ title: 'Ship the event stream', priority: 'high' }),
    });
    expect(created.status).toBe(201);
    const { card } = await created.json();
    expect(card.id).toMatch(/^[A-Z]{3}\d*-1$/);

    const moved = await json(`/api/cards/${card.id}/move`, {
      method: 'POST',
      body: JSON.stringify({ status: 'in-progress', position: 0 }),
    });
    expect(moved.card.status).toBe('in-progress');

    const commented = await api(`/api/cards/${card.id}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: 'Started.' }),
    });
    expect(commented.status).toBe(201);

    const detail = await json(`/api/cards/${card.id}`);
    expect(detail.card.comments).toHaveLength(1);
    expect(detail.activity.map((entry: any) => entry.action)).toEqual([
      'card.created',
      'card.moved',
      'card.commented',
    ]);
  });

  it('attributes a change to the identity in the actor header', async () => {
    const { card } = await json('/api/cards', {
      method: 'POST',
      body: JSON.stringify({ title: 'Agent work' }),
      headers: { 'x-trella-actor': agentHeader },
    });
    expect(card.creator).toEqual({ type: 'agent', id: 'agent:codex', name: 'Codex' });
  });

  it('falls back to the configured local human when no actor is supplied', async () => {
    const { card } = await json('/api/cards', {
      method: 'POST',
      body: JSON.stringify({ title: 'Human work' }),
    });
    expect(card.creator.type).toBe('human');
    expect(card.creator.id).toBe('local-human');
  });

  it('returns 409 with the current card when a write is stale', async () => {
    const { card } = await json('/api/cards', {
      method: 'POST',
      body: JSON.stringify({ title: 'Contested' }),
    });
    await json(`/api/cards/${card.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ description: 'agent note' }),
      headers: { 'x-trella-actor': agentHeader },
    });

    const stale = await api(`/api/cards/${card.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: 'Human title', expectedRevision: card.revision }),
    });
    expect(stale.status).toBe(409);
    const payload = await stale.json();
    expect(payload.error.code).toBe('conflict');
    expect(payload.error.current.description).toBe('agent note');
    expect(payload.error.currentRevision).toBe(2);
  });

  it('explains an unknown column instead of failing silently', async () => {
    const { card } = await json('/api/cards', {
      method: 'POST',
      body: JSON.stringify({ title: 'Somewhere' }),
    });
    const response = await api(`/api/cards/${card.id}/move`, {
      method: 'POST',
      body: JSON.stringify({ status: 'shipped' }),
    });
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe('invalid_status');
    expect(payload.error.available).toContain('review');
  });

  it('reports a missing card as 404', async () => {
    const response = await api('/api/cards/TES-999');
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe('not_found');
  });

  it('filters cards by status, label and search', async () => {
    await json('/api/cards', {
      method: 'POST',
      body: JSON.stringify({ title: 'Reconnect backoff', labels: ['api'], status: 'to-do' }),
    });
    await json('/api/cards', { method: 'POST', body: JSON.stringify({ title: 'Empty state' }) });

    expect((await json('/api/cards?status=to-do')).cards).toHaveLength(1);
    expect((await json('/api/cards?label=API')).cards).toHaveLength(1);
    expect((await json('/api/cards?q=empty')).cards[0].title).toBe('Empty state');
  });
});

describe('security', () => {
  it('refuses requests that are not addressed to localhost', async () => {
    // fetch() will not let a caller forge Host, so this drops to raw HTTP —
    // which is exactly what a DNS-rebinding attempt would look like.
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: service.port, path: '/api/board', method: 'GET' },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }
      );
      req.setHeader('host', 'board.example.com');
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it('refuses a cross-origin write', async () => {
    const response = await api('/api/cards', {
      method: 'POST',
      body: JSON.stringify({ title: 'Injected' }),
      headers: { origin: 'https://evil.example' },
    });
    expect(response.status).toBe(403);
  });
});

describe('event stream', () => {
  it('pushes a mutation made through another channel, tagged with its board', async () => {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/events`, { signal: controller.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    const frames: string[] = [];
    const collected = (async () => {
      let buffer = '';
      while (frames.length < 2) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf('\n\n');
        while (index !== -1) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          if (frame.startsWith('event: card.')) frames.push(frame);
          index = buffer.indexOf('\n\n');
        }
      }
    })();

    await new Promise((resolve) => setTimeout(resolve, 50));
    const { card } = await json('/api/cards', {
      method: 'POST',
      body: JSON.stringify({ title: 'Watched' }),
      headers: { 'x-trella-actor': agentHeader },
    });
    await json(`/api/cards/${card.id}/move`, {
      method: 'POST',
      body: JSON.stringify({ status: 'to-do' }),
      headers: { 'x-trella-actor': agentHeader },
    });

    await collected;
    controller.abort();

    expect(frames[0]).toContain('event: card.created');
    expect(frames[1]).toContain('event: card.moved');
    const payload = JSON.parse(frames[1]!.split('\ndata: ')[1]!);
    expect(payload.actor.name).toBe('Codex');
    expect(payload.card.status).toBe('to-do');
    expect(payload.boardId).toBe(card.boardId);
  });

  it('tells a client that fell behind to refetch', async () => {
    await json('/api/cards', { method: 'POST', body: JSON.stringify({ title: 'Missed' }) });

    const controller = new AbortController();
    const response = await fetch(`${base}/api/events?cursor=0`, { signal: controller.signal });
    const reader = response.body!.getReader();
    const { value } = await reader.read();
    const frame = new TextDecoder().decode(value);
    controller.abort();

    expect(frame).toContain('event: resync');
    expect(frame).toContain('missed-events');
  });
});

describe('file adapter', () => {
  const waitForFile = async (path: string) => {
    for (let i = 0; i < 60 && !existsSync(path); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return JSON.parse(readFileSync(path, 'utf8'));
  };

  it('applies a request file and writes the result to the outbox', async () => {
    writeFileSync(
      join(root, '.agentboard', 'inbox', 'req-1.json'),
      JSON.stringify({
        id: 'req-1',
        op: 'create_task',
        actor: { type: 'agent', id: 'agent:planner', name: 'Planner' },
        params: { title: 'From a file', priority: 'urgent' },
      })
    );

    const result = await waitForFile(join(root, '.agentboard', 'outbox', 'req-1.json'));
    expect(result.ok).toBe(true);
    expect(result.result.task.title).toBe('From a file');
    expect(result.result.task.creator.name).toBe('Planner');
  });

  it('can create a board through a file too', async () => {
    writeFileSync(
      join(root, '.agentboard', 'inbox', 'req-board.json'),
      JSON.stringify({
        id: 'req-board',
        op: 'create_board',
        actor: { type: 'agent', id: 'agent:planner', name: 'Planner' },
        params: { name: 'From a file', columns: [{ name: 'One' }, { name: 'Two' }] },
      })
    );

    const result = await waitForFile(join(root, '.agentboard', 'outbox', 'req-board.json'));
    expect(result.ok).toBe(true);
    expect(result.result.board.columns.map((column: any) => column.id)).toEqual(['one', 'two']);
  });

  it('writes an actionable error for an unknown op', async () => {
    writeFileSync(
      join(root, '.agentboard', 'inbox', 'req-bad.json'),
      JSON.stringify({
        id: 'req-bad',
        op: 'delete_everything',
        actor: { type: 'agent', id: 'a', name: 'A' },
      })
    );

    const result = await waitForFile(join(root, '.agentboard', 'outbox', 'req-bad.json'));
    expect(result.ok).toBe(false);
    expect(result.result.message).toContain('Supported: list_tasks');
  });
});
