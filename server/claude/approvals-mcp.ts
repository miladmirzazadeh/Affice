// The office's permission prompt tool: a stdio MCP server with one tool, `approve`, plus the office
// tools every manager has (`list_departments`, `office_status`, `ask_manager`).
//
// Claude Code starts it from the --mcp-config the driver passes (server name `office`) and calls
// `mcp__office__approve` through --permission-prompt-tool whenever a tool call needs the user's
// permission. The tool posts the request to the office server, long-polls for the user's answer
// in the browser, and returns the decision as JSON text:
//   {"behavior":"allow","updatedInput":<input>}  or  {"behavior":"deny","message":"..."}
//
// Plain JSON-RPC 2.0 over stdio, one message per line, no SDK. Logs go to stderr only: stdout
// carries the protocol.

import { request as httpRequest } from 'node:http';
import { createInterface } from 'node:readline';

// This file is bundled on its own (dist/approvals-mcp.js), so it repeats the three names of server/auth.ts
// instead of importing the module that holds the server's secrets.
const AGENT_TOKEN_ENV = 'AFFICE_AGENT_TOKEN';
const TOKEN_HEADER = 'x-affice-token';
const DEPARTMENT_HEADER = 'x-affice-department';

const OFFICE_URL = process.env.AFFICE_URL ?? 'http://127.0.0.1:5191';
/** The department of the manager this server runs for (the driver sets it; the model cannot change it). */
const DEPARTMENT = process.env.AFFICE_DEPARTMENT ?? '';
/** The agent token of that department (server/auth.ts): who the office takes this server to be. Never logged, never sent in a body. */
const AGENT_TOKEN = process.env[AGENT_TOKEN_ENV] ?? '';
const NO_TOKEN = `This office tool has no token (${AGENT_TOKEN_ENV} is not set for this manager), so the office would not take its requests. Restart the session from Affice.`;

/** The headers every request to the office carries: the token and the department it was made for. */
function officeHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { ...extra, [TOKEN_HEADER]: AGENT_TOKEN, [DEPARTMENT_HEADER]: DEPARTMENT };
}

type Id = string | number;
type Decision = { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string };

const TOOL = {
  name: 'approve',
  description:
    'Asks the user in the office whether a tool call may run. Used by Claude Code as the permission prompt tool; not for the model to call.',
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string', description: 'The tool that wants to run.' },
      input: { type: 'object', description: 'The input it would run with.' },
      tool_use_id: { type: 'string', description: 'The tool_use id of the call.' },
    },
    required: ['tool_name', 'input'],
  },
};

const OFFICE_TOOLS = [
  {
    name: 'list_departments',
    description: "Lists the departments of the office: id, name, kind, responsibility, model, session status, Trella board id and repos.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'office_status',
    description: 'What is happening in the office now: per department the session state, the agents with status, title, card key and current tool, and the approvals waiting for the user.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'ask_manager',
    description:
      "Asks another department manager a question or gives it a request, and returns its reply. Say who you are and what you need: the manager does not see your conversation. The message appears in that department's chat as from you; the session is started when it is off. Waits for the end of the manager's turn, up to 10 minutes. When that manager accepts edits, the user is asked first (a card in your chat) and the call is refused if the user declines. Refused when the chain is already two managers deep, when that manager is waiting for an answer itself, when it runs with approvals off, or when it is you.",
    inputSchema: {
      type: 'object',
      properties: {
        department: { type: 'string', description: 'The id of the department to ask, from list_departments.' },
        message: { type: 'string', description: 'What to ask or tell that manager. Include who you are and what you need.' },
      },
      required: ['department', 'message'],
    },
  },
];

const inflight = new Map<Id, AbortController>();

function write(message: object): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id: Id, result: unknown): void {
  write({ jsonrpc: '2.0', id, result });
}

function fail(id: Id, code: number, message: string): void {
  write({ jsonrpc: '2.0', id, error: { code, message } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${OFFICE_URL}${path}`, { ...init, headers: officeHeaders(init.headers as Record<string, string> | undefined) });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

/** Asks the office and waits for the user. Network errors are retried for a while, then denied. */
async function decide(args: Record<string, unknown>, signal: AbortSignal): Promise<Decision> {
  const input = isRecord(args.input) ? args.input : {};
  const deny = (message: string): Decision => ({ behavior: 'deny', message });
  if (!AGENT_TOKEN) return deny(NO_TOKEN);
  let approvalId: string | null = null;
  let failures = 0;
  while (!signal.aborted) {
    try {
      if (approvalId === null) {
        const created = await request('/api/approvals', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            tool: typeof args.tool_name === 'string' ? args.tool_name : 'unknown',
            input,
            toolUseId: typeof args.tool_use_id === 'string' ? args.tool_use_id : null,
            // The names of the fields Claude Code sent, so the office can confirm the contract in its log.
            argKeys: Object.keys(args),
          }),
          signal,
        });
        if (created.status !== 200 || !isRecord(created.body) || typeof created.body.id !== 'string') {
          const reason = isRecord(created.body) && typeof created.body.error === 'string' ? created.body.error : `status ${created.status}`;
          return deny(`The office did not accept the approval request (${reason}), so nothing was approved.`);
        }
        approvalId = created.body.id;
      }
      const waited = await request(`/api/approvals/${encodeURIComponent(approvalId)}/wait`, { signal });
      failures = 0;
      if (waited.status === 404) return deny('The office lost this approval request (it may have restarted). Ask again.');
      if (waited.status !== 200 || !isRecord(waited.body)) throw new Error(`status ${waited.status}`);
      if (waited.body.status === 'answered') {
        return waited.body.allow === true
          ? { behavior: 'allow', updatedInput: input }
          : deny('The user declined.');
      }
      // Still pending: poll again.
    } catch (error) {
      if (signal.aborted) break;
      failures += 1;
      if (failures > 20) {
        return deny(`The office server is not reachable (${error instanceof Error ? error.message : String(error)}), so nothing was approved.`);
      }
      await sleep(1000);
    }
  }
  // Cancelled by Claude Code (an interrupt, for example): withdraw the card from the browser.
  if (approvalId !== null) {
    void request(`/api/approvals/${encodeURIComponent(approvalId)}/cancel`, { method: 'POST' }).catch(() => undefined);
  }
  return deny('Cancelled.');
}

/** A POST without a response timeout (fetch gives up on headers after 300 s; ask_manager may take 10 minutes). */
function postLong(path: string, payload: unknown, signal: AbortSignal): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${OFFICE_URL}${path}`, { method: 'POST', headers: officeHeaders({ 'content-type': 'application/json' }), signal }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: text });
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(JSON.stringify(payload));
  });
}

/** Runs one office tool; the text goes back to the manager that called it. */
async function officeTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<{ text: string; isError: boolean }> {
  const answer = (status: number, body: unknown, text: (body: unknown) => string) =>
    status === 200
      ? { text: text(body), isError: false }
      : { text: isRecord(body) && typeof body.error === 'string' ? body.error : `The office answered ${status}.`, isError: true };
  if (!AGENT_TOKEN) return { text: NO_TOKEN, isError: true };
  try {
    if (name === 'list_departments' || name === 'office_status') {
      const { status, body } = await request(name === 'list_departments' ? '/api/office/departments' : '/api/office/status', { signal });
      return answer(status, body, (b) => JSON.stringify(b, null, 2));
    }
    // Who is asking is not said in the body: the office takes it from the agent token of this server's department.
    const { status, body } = await postLong('/api/office/ask', { department: args.department, message: args.message }, signal);
    return answer(status, body, (b) => (isRecord(b) && typeof b.reply === 'string' ? b.reply : JSON.stringify(b)));
  } catch (error) {
    return { text: `The office server is not reachable (${error instanceof Error ? error.message : String(error)}).`, isError: true };
  }
}

async function callTool(id: Id, params: Record<string, unknown>): Promise<void> {
  const name = String(params.name);
  const office = OFFICE_TOOLS.some((tool) => tool.name === name);
  if (name !== TOOL.name && !office) {
    fail(id, -32602, `Unknown tool: ${name}`);
    return;
  }
  const controller = new AbortController();
  inflight.set(id, controller);
  try {
    const args = isRecord(params.arguments) ? params.arguments : {};
    const result = office
      ? await officeTool(name, args, controller.signal)
      : { text: JSON.stringify(await decide(args, controller.signal)), isError: false };
    // A cancelled request gets no response, as the MCP specification asks.
    if (!controller.signal.aborted) reply(id, { content: [{ type: 'text', text: result.text }], ...(result.isError ? { isError: true } : {}) });
  } finally {
    inflight.delete(id);
  }
}

function handle(message: Record<string, unknown>): void {
  const method = typeof message.method === 'string' ? message.method : null;
  if (method === null) return; // a response to a request we never sent
  const id = typeof message.id === 'string' || typeof message.id === 'number' ? message.id : null;
  const params = isRecord(message.params) ? message.params : {};

  switch (method) {
    case 'initialize':
      if (id === null) return;
      reply(id, {
        // Echo the client's version: this server only uses what every version has (tools/list, tools/call).
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'office', version: '0.1.0' },
      });
      return;
    case 'ping':
      if (id !== null) reply(id, {});
      return;
    case 'tools/list':
      if (id !== null) reply(id, { tools: [TOOL, ...OFFICE_TOOLS] });
      return;
    case 'tools/call':
      if (id !== null) void callTool(id, params);
      return;
    case 'notifications/cancelled': {
      const target = params.requestId;
      if (typeof target === 'string' || typeof target === 'number') inflight.get(target)?.abort();
      return;
    }
    default:
      // Other notifications (initialized, roots changes) need nothing; unknown requests get an error.
      if (id !== null) fail(id, -32601, `Method not found: ${method}`);
  }
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (!line.trim()) return;
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (Array.isArray(message)) message.forEach((item) => isRecord(item) && handle(item));
  else if (isRecord(message)) handle(message);
});
lines.on('close', () => {
  for (const controller of inflight.values()) controller.abort();
  process.exit(0);
});
