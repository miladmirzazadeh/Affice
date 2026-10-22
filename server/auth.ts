// The secrets of the control channel (SEC-01, SEC-03, SEC-08). Two kinds, both made when the
// process starts and never written to disk, a log or an API answer (except as described below):
//
//   pageToken          one per process. Only the browser page gets it: injected into the served
//                      index.html as <meta name="affice-token">, or from GET /api/session to a
//                      same-origin request. Every route of the page and every socket command needs it.
//                      It must never enter a child process environment or an argv.
//   agentToken(dept)   one per department, an HMAC of the department id under the process secret. The
//                      manager processes get it (AFFICE_AGENT_TOKEN) in the MCP config env of the
//                      approvals MCP server only, which sends it with the department it was started for.
//                      It opens the agent routes (approval request, wait and cancel, list_departments,
//                      office_status, ask) and nothing else: no approval answer, no bypass, no chat, no
//                      project or department command. One manager's token does not work for another
//                      department, so `from` is derived here and never trusted from a body.
//
// Tokens are compared in constant time. Anyone who can read the page (index.html over loopback) or the
// environment of the MCP process already runs as the user; the tokens defend against other web pages
// and against agents that cannot run a process, not against that.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/** The environment variable of the approvals MCP server (set in its MCP config env, not in the manager's own). */
export const AGENT_TOKEN_ENV = 'AFFICE_AGENT_TOKEN';
/** The header of a route request, from the page or from the MCP server. */
export const TOKEN_HEADER = 'x-affice-token';
/** The department the MCP server was started for; the agent token must be that department's. */
export const AGENT_DEPARTMENT_HEADER = 'x-affice-department';
/** The WebSocket subprotocol that carries the page token: `new WebSocket(url, ['affice', 'affice.<token>'])`. */
export const SOCKET_PROTOCOL = 'affice';
export const SOCKET_TOKEN_PREFIX = 'affice.';

const secret = randomBytes(32);

/** Random per process, 32 bytes as hex. */
export const pageToken: string = randomBytes(32).toString('hex');

/** The agent token of a department: an HMAC of the id under the process secret, 32 bytes as hex. */
export function agentToken(department: string): string {
  return createHmac('sha256', secret).update(`agent:${department}`).digest('hex');
}

/** Constant-time string comparison (both sides are hashed first, so the length does not leak either). */
export function safeEqual(a: string, b: string): boolean {
  const left = createHmac('sha256', secret).update(a).digest();
  const right = createHmac('sha256', secret).update(b).digest();
  return timingSafeEqual(left, right);
}

function header(req: Pick<IncomingMessage, 'headers'>, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** The token the request carries: the x-affice-token header, else the WebSocket subprotocol list. */
export function requestToken(req: Pick<IncomingMessage, 'headers'>): string | null {
  const direct = header(req, TOKEN_HEADER);
  if (direct) return direct.trim();
  const protocols = header(req, 'sec-websocket-protocol');
  if (protocols) {
    for (const entry of protocols.split(',')) {
      const protocol = entry.trim();
      if (protocol.startsWith(SOCKET_TOKEN_PREFIX)) return protocol.slice(SOCKET_TOKEN_PREFIX.length);
    }
  }
  return null;
}

/** True when the request carries the page token (header or WebSocket subprotocol). */
export function checkPage(req: Pick<IncomingMessage, 'headers'>): boolean {
  const token = requestToken(req);
  return token !== null && safeEqual(token, pageToken);
}

/**
 * The department of a valid agent request, or null. The request names its department in
 * x-affice-department and must carry that department's agent token; a token of another department,
 * the page token or no token all give null.
 */
export function checkAgent(req: Pick<IncomingMessage, 'headers'>): string | null {
  const department = header(req, AGENT_DEPARTMENT_HEADER)?.trim();
  const token = header(req, TOKEN_HEADER)?.trim();
  if (!department || !token || !/^[a-z0-9-]{1,32}$/.test(department)) return null;
  return safeEqual(token, agentToken(department)) ? department : null;
}

/** How long a ticket opens its file. */
export const TICKET_TTL_MS = 60_000;

/**
 * A short-lived ticket for one scope (a report file), for the one request a header cannot be sent with: a
 * link that opens in a new tab. The page asks for it with its token; the ticket only opens that scope, for a
 * minute. Format: <expires at in ms>.<HMAC of scope and expiry>.
 */
export function makeTicket(scope: string, now = Date.now()): string {
  const expires = String(now + TICKET_TTL_MS);
  return `${expires}.${createHmac('sha256', secret).update(`ticket:${scope}:${expires}`).digest('hex')}`;
}

export function checkTicket(ticket: string, scope: string, now = Date.now()): boolean {
  const dot = ticket.indexOf('.');
  if (dot < 1) return false;
  const expires = ticket.slice(0, dot);
  if (!/^\d{1,16}$/.test(expires) || Number(expires) < now) return false;
  return safeEqual(ticket, `${expires}.${createHmac('sha256', secret).update(`ticket:${scope}:${expires}`).digest('hex')}`);
}
