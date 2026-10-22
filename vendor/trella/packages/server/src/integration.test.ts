/**
 * End-to-end: the real CLI binary and the real MCP binary, against a real
 * service, watched by a real event stream. This is the test that would catch a
 * channel drifting away from the shared domain service.
 */
import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initWorkspace, type Workspace } from '@trella/core';
import { startServer, type RunningService } from './index.js';

const run = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const CLI = join(repoRoot, 'packages/cli/bin/trella.js');
const MCP = join(repoRoot, 'packages/mcp/bin/trella-mcp.js');
const built = existsSync(join(repoRoot, 'packages/cli/dist/index.js'));

const AGENT = JSON.stringify({ type: 'agent', id: 'agent:codex', name: 'Codex' });

let root: string;
let workspace: Workspace;
let service: RunningService;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'trella-e2e-'));
  workspace = initWorkspace(root, { workspaceName: 'Integration' });
  service = await startServer({ workspace, port: 0, webRoot: null, version: 'test' });
});

afterEach(async () => {
  await service.stop();
  rmSync(root, { recursive: true, force: true });
});

/** Collects SSE frames the way the open board would. */
function watchStream(url: string) {
  const controller = new AbortController();
  const events: Array<{ type: string; data: any }> = [];
  const ready = fetch(`${url}/api/events`, { signal: controller.signal }).then(async (response) => {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index = buffer.indexOf('\n\n');
          while (index !== -1) {
            const frame = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const type = /^event: (.+)$/m.exec(frame)?.[1];
            const data = /^data: (.+)$/m.exec(frame)?.[1];
            if (type && data) events.push({ type, data: JSON.parse(data) });
            index = buffer.indexOf('\n\n');
          }
        }
      } catch {
        // Aborted at the end of the test.
      }
    })();
  });

  return {
    events,
    ready,
    stop: () => controller.abort(),
    async waitFor(type: string, timeoutMs = 4000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = events.find((event) => event.type === type);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`No "${type}" event within ${timeoutMs}ms. Saw: ${events.map((e) => e.type).join(', ')}`);
    },
  };
}

const cli = (args: string[]) =>
  run(process.execPath, [CLI, ...args], {
    cwd: root,
    env: { ...process.env, TRELLA_URL: service.url, TRELLA_ACTOR: AGENT, NO_COLOR: '1' },
  });

/** The MCP binary over stdio, with just enough JSON-RPC to call one tool at a time. */
async function startMcp(env: Record<string, string>) {
  const child = spawn(process.execPath, [MCP], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let buffer = '';
  const pending = new Map<number, (message: any) => void>();
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    for (let index = buffer.indexOf('\n'); index !== -1; index = buffer.indexOf('\n')) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });

  let nextId = 1;
  const rpc = (method: string, params: unknown) =>
    new Promise<any>((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  return {
    rpc,
    /** Calls a tool and returns its parsed payload; an error result throws. */
    async tool(name: string, args: Record<string, unknown>) {
      const reply = await rpc('tools/call', { name, arguments: args });
      const payload = JSON.parse(reply.result.content[0].text);
      if (reply.result.isError) throw new Error(`${name}: ${JSON.stringify(payload)}`);
      return payload;
    },
    stop: () => child.kill(),
  };
}

describe.skipIf(!built)('agent to board', () => {
  it('shows a card the CLI created on the open board within a moment', async () => {
    const stream = watchStream(service.url);
    await stream.ready;
    await new Promise((resolve) => setTimeout(resolve, 50));

    await cli(['create', 'Wire up the reconnect', '--priority', 'high', '--label', 'api']);

    const event = await stream.waitFor('card.created');
    expect(event.data.card.title).toBe('Wire up the reconnect');
    expect(event.data.actor).toEqual({ type: 'agent', id: 'agent:codex', name: 'Codex' });
    stream.stop();

    const board = await (await fetch(`${service.url}/api/board`)).json();
    expect(board.cards).toHaveLength(1);
  });

  it('streams a claim and a move made from the command line', async () => {
    await cli(['create', 'Reconnect']);
    const id = JSON.parse((await cli(['list', '--json'])).stdout).cards[0].id;
    const stream = watchStream(service.url);
    await stream.ready;
    await new Promise((resolve) => setTimeout(resolve, 50));

    await cli(['claim', id]);
    await cli(['move', id, 'in-progress']);

    const claimed = await stream.waitFor('card.claimed');
    const moved = await stream.waitFor('card.moved');
    stream.stop();

    expect(claimed.data.card.assignee.name).toBe('Codex');
    expect(moved.data.card.status).toBe('in-progress');
    expect(moved.data.previousStatus).toBe('backlog');
  });
});

describe.skipIf(!built)('board to agent', () => {
  it('lets the CLI read a change the board just made', async () => {
    // The board writes as the configured human, with no actor header.
    const created = await (
      await fetch(`${service.url}/api/cards`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Written in the browser', priority: 'urgent' }),
      })
    ).json();

    const { stdout } = await cli(['show', created.card.id, '--json']);
    const seen = JSON.parse(stdout);
    expect(seen.card.title).toBe('Written in the browser');
    expect(seen.card.priority).toBe('urgent');
    expect(seen.card.creator.type).toBe('human');
  });

  it('rejects an agent write that is based on a stale revision', async () => {
    await cli(['create', 'Contested']);
    const first = JSON.parse((await cli(['list', '--json'])).stdout).cards[0].id;
    await fetch(`${service.url}/api/cards/${first}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'edited in the browser' }),
    });

    await expect(
      cli(['update', first, '--title', 'Agent title', '--expect', '1'])
    ).rejects.toThrow(/revision/);

    const { stdout } = await cli(['show', first, '--json']);
    expect(JSON.parse(stdout).card.title).toBe('Contested');
  });
});

describe.skipIf(!built)('MCP server', () => {
  it('finds the workspace through TRELLA_PROJECT when the cwd is useless', async () => {
    // How a GUI client launches it: no project directory to start in, so the
    // workspace has to come from the environment. `trella mcp` is the documented
    // command, so it is the one under test — not the trella-mcp bin.
    const child = spawn(process.execPath, [CLI, 'mcp'], {
      cwd: tmpdir(),
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TRELLA_PROJECT: root,
        TRELLA_ACTOR: AGENT,
      },
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    let buffer = '';
    const pending = new Map<number, (message: any) => void>();
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) {
          const message = JSON.parse(line);
          pending.get(message.id)?.(message);
          pending.delete(message.id);
        }
        index = buffer.indexOf('\n');
      }
    });

    let nextId = 1;
    const call = (method: string, params: unknown) =>
      new Promise<any>((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });

    try {
      await call('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'gui', version: '1' },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

      const listed = await call('tools/call', { name: 'list_boards', arguments: {} });
      expect(listed.result.isError).toBeFalsy();
      const payload = JSON.parse(listed.result.content[0].text);
      expect(payload.boards).toHaveLength(1);
      expect(payload.projects.map((project: { id: string }) => project.id)).toEqual(['general']);
    } finally {
      child.kill();
    }
  }, 20_000);


  it('exposes the semantic tools and writes through the same service', async () => {
    const child = spawn(process.execPath, [MCP], {
      cwd: root,
      env: { ...process.env, TRELLA_URL: service.url, TRELLA_ACTOR: AGENT },
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    let buffer = '';
    /** Every line the server put on stdout, checked for purity at the end. */
    const transcript: string[] = [];
    const pending = new Map<number, (message: any) => void>();
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) transcript.push(line);
        if (line) {
          const message = JSON.parse(line);
          pending.get(message.id)?.(message);
          pending.delete(message.id);
        }
        index = buffer.indexOf('\n');
      }
    });

    let nextId = 1;
    const call = (method: string, params: unknown) =>
      new Promise<any>((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });

    try {
      const init = await call('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      });
      expect(init.result.serverInfo.name).toBe('trella');
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

      const tools = await call('tools/list', {});
      expect(tools.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([
        'add_column',
        'add_comment',
        'claim_task',
        'create_board',
        'create_project',
        'create_task',
        'get_activity',
        'get_board',
        'get_task',
        'list_boards',
        'list_tasks',
        'move_task',
        'remove_column',
        'update_board',
        'update_task',
      ]);

      const created = await call('tools/call', {
        name: 'create_task',
        arguments: { title: 'Planned by an agent', priority: 'high' },
      });
      const task = JSON.parse(created.result.content[0].text).task;
      expect(task.id).toMatch(/-1$/);

      const stale = await call('tools/call', {
        name: 'update_task',
        arguments: { task_id: task.id, fields: { title: 'x' }, expected_revision: 99 },
      });
      expect(stale.result.isError).toBe(true);
      expect(JSON.parse(stale.result.content[0].text).error).toBe('conflict');

      // A stdio MCP server may write nothing but JSON-RPC to stdout. Anything
      // else — a stray log line, a Node warning routed the wrong way — corrupts
      // the stream and the client drops the connection.
      for (const line of transcript.filter((entry) => entry.trim())) {
        const message = JSON.parse(line) as { jsonrpc?: string };
        expect(message.jsonrpc).toBe('2.0');
      }

      // The card the MCP server created is on the same board as everything else.
      const board = await (await fetch(`${service.url}/api/board`)).json();
      expect(board.cards.map((card: { title: string }) => card.title)).toEqual(['Planned by an agent']);
      expect(board.cards[0].creator).toEqual({ type: 'agent', id: 'agent:codex', name: 'Codex' });
    } finally {
      child.kill();
    }
  }, 20_000);

  it('records the identity named in a call and reports actor ids in the activity', async () => {
    const mcp = await startMcp({ TRELLA_URL: service.url, TRELLA_ACTOR: AGENT });
    const sonnet = { type: 'agent', id: 'agent:sonnet-test', name: 'Sonnet Test' };
    // A name outside Latin-1 has to survive the trip through the HTTP header.
    const persian = { type: 'agent', id: 'agent:persian', name: '\u062a\u0631\u0644\u0627' };

    try {
      // Every tool that writes accepts the field; the reads do not.
      const tools = (await mcp.rpc('tools/list', {})).result.tools as Array<{
        name: string;
        inputSchema: { properties: Record<string, unknown> };
      }>;
      const takingIdentity = tools
        .filter((tool) => 'agent_identity' in tool.inputSchema.properties)
        .map((tool) => tool.name)
        .sort();
      expect(takingIdentity).toEqual([
        'add_column',
        'add_comment',
        'claim_task',
        'create_board',
        'create_project',
        'create_task',
        'move_task',
        'remove_column',
        'update_board',
        'update_task',
      ]);

      // Without the field the server's own identity is used, as before.
      const id = (await mcp.tool('create_task', { title: 'Shared server' })).task.id;
      await mcp.tool('move_task', {
        task_id: id,
        destination_status: 'in-progress',
        agent_identity: sonnet,
      });
      await mcp.tool('add_comment', { task_id: id, body: 'On it', agent_identity: persian });
      await mcp.tool('update_task', {
        task_id: id,
        fields: { priority: 'high' },
        agent_identity: sonnet,
      });

      const { activity } = await mcp.tool('get_activity', { task_id: id });
      expect(
        activity.map((entry: any) => [entry.action, entry.actor, entry.actor_id])
      ).toEqual([
        ['card.created', 'Codex', 'agent:codex'],
        ['card.moved', 'Sonnet Test', 'agent:sonnet-test'],
        ['card.commented', persian.name, 'agent:persian'],
        ['card.updated', 'Sonnet Test', 'agent:sonnet-test'],
      ]);

      // get_task carries the same ids, and the board itself agrees.
      const detail = await mcp.tool('get_task', { task_id: id });
      expect(detail.activity.map((entry: any) => entry.actor_id)).toEqual(
        activity.map((entry: any) => entry.actor_id)
      );
      const card = (await (await fetch(`${service.url}/api/cards/${id}`)).json()).card;
      expect(card.creator).toEqual({ type: 'agent', id: 'agent:codex', name: 'Codex' });
      expect(card.lastActor).toEqual(sonnet);
      expect(card.comments[0].actor).toEqual(persian);
    } finally {
      mcp.stop();
    }
  }, 20_000);
});
