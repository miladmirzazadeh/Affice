// The office side of approvals. The approvals MCP server (server/claude/approvals-mcp.ts) POSTs each
// permission request here and long-polls for the answer; the user answers in the browser with
// `permission.answer`.
//
//   POST /api/approvals              {tool, input, toolUseId, argKeys}  ->  {id}
//   GET  /api/approvals/:id/wait     up to 25 s  ->  {status: 'pending'} | {status: 'answered', allow}
//   POST /api/approvals/:id/cancel   Claude Code cancelled the call (an interrupt): close the card
//
// All three are agent routes: they need the agent token of the department that asks (server/auth.ts), and
// the department of the card is that department, never a field of the body. A manager can only wait for
// and cancel its own cards. Only the page answers (`permission.answer` over the socket, with the page token).

import { randomUUID } from 'node:crypto';
import { RouteError } from '../shared/server-api';
import type { PermissionRequest, ServerEvent } from '../shared/types';
import type { HttpRouter } from './router';

export type WaitResult = { status: 'pending' } | { status: 'answered'; allow: boolean };

interface Entry {
  request: PermissionRequest;
  answer: boolean | null;
  waiters: Set<(allow: boolean) => void>;
}

export interface ApprovalHooks {
  /** Broadcasts permission.requested and permission.resolved. */
  emit(event: ServerEvent): void;
  /** Builds the request (agent, summary) or throws a RouteError when the department has no session. */
  describe(input: { department: string; tool: string; input: unknown; toolUseId: string | null }): Omit<PermissionRequest, 'id' | 'at'>;
  /** The agent waits for the user (true) or not any more (false). */
  waiting(department: string, agentId: string | null, waiting: boolean): void;
}

const KEEP_ANSWERED_MS = 60_000;

export class Approvals {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly hooks: ApprovalHooks) {}

  /** The department a request belongs to, or null when it is unknown (or no longer kept). */
  departmentOf(id: string): string | null {
    return this.entries.get(id)?.request.department ?? null;
  }

  open(): PermissionRequest[] {
    return [...this.entries.values()].filter((e) => e.answer === null).map((e) => e.request);
  }

  create(input: { department: string; tool: string; input: unknown; toolUseId: string | null }): PermissionRequest {
    const request: PermissionRequest = { id: `perm_${randomUUID()}`, ...this.hooks.describe(input), at: new Date().toISOString() };
    this.entries.set(request.id, { request, answer: null, waiters: new Set() });
    this.hooks.emit({ type: 'permission.requested', request });
    this.hooks.waiting(request.department, request.agentId, true);
    return request;
  }

  /** Returns false when the request is unknown or already answered. */
  answer(id: string, allow: boolean): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.answer !== null) return false;
    entry.answer = allow;
    this.hooks.emit({ type: 'permission.resolved', id, allow });
    const { department, agentId } = entry.request;
    const stillWaiting = this.open().some((r) => r.department === department && r.agentId === agentId);
    if (!stillWaiting) this.hooks.waiting(department, agentId, false);
    for (const wake of entry.waiters) wake(allow);
    entry.waiters.clear();
    // Kept a little while, so a poll that was between requests still gets the answer.
    setTimeout(() => this.entries.delete(id), KEEP_ANSWERED_MS).unref();
    return true;
  }

  wait(id: string, timeoutMs: number): Promise<WaitResult> {
    const entry = this.entries.get(id);
    if (!entry) return Promise.reject(new RouteError(404, 'No such approval request.'));
    if (entry.answer !== null) return Promise.resolve({ status: 'answered', allow: entry.answer });
    return new Promise((resolve) => {
      const wake = (allow: boolean) => {
        clearTimeout(timer);
        resolve({ status: 'answered', allow });
      };
      const timer = setTimeout(() => {
        entry.waiters.delete(wake);
        resolve({ status: 'pending' });
      }, timeoutMs);
      entry.waiters.add(wake);
    });
  }

  /** Denies every open request of the department (its session stopped or the department was removed). */
  closeDepartment(department: string): void {
    for (const request of this.open()) if (request.department === department) this.answer(request.id, false);
  }
}

function field(body: unknown, key: string): unknown {
  return body && typeof body === 'object' ? (body as Record<string, unknown>)[key] : undefined;
}

/** The cards of other departments do not exist for a manager: it asks about its own only. */
function own(approvals: Approvals, id: string, caller: string | undefined): void {
  if (!caller) throw new RouteError(403, 'The caller is not known.');
  const department = approvals.departmentOf(id);
  if (department !== null && department !== caller) throw new RouteError(404, 'No such approval request.');
}

/** `current` returns the open project's approvals, or throws a RouteError while no project is open. */
export function registerApprovalRoutes(router: HttpRouter, current: () => Approvals, log: (line: string) => void): void {
  router.post(
    '/api/approvals',
    ({ body, caller }) => {
      const approvals = current();
      if (!caller) throw new RouteError(403, 'The caller is not known.');
      const tool = field(body, 'tool');
      if (typeof tool !== 'string') throw new RouteError(400, 'tool is required.');
      const toolUseId = field(body, 'toolUseId');
      const argKeys = field(body, 'argKeys');
      log(`approval requested by ${caller}: ${tool} (the prompt tool received ${Array.isArray(argKeys) ? argKeys.join(', ') : 'unknown fields'})`);
      const request = approvals.create({ department: caller, tool, input: field(body, 'input') ?? {}, toolUseId: typeof toolUseId === 'string' ? toolUseId : null });
      return { id: request.id };
    },
    { agent: true },
  );
  router.get(
    '/api/approvals/:id/wait',
    ({ params, caller }) => {
      own(current(), params.id, caller);
      return current().wait(params.id, 25_000);
    },
    { agent: true },
  );
  router.post(
    '/api/approvals/:id/cancel',
    ({ params, caller }) => {
      own(current(), params.id, caller);
      return { cancelled: current().answer(params.id, false) };
    },
    { agent: true },
  );
}
