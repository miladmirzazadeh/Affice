// Who may talk to the office server, and the headers every answer carries (SEC-01, SEC-06, SEC-09).
//
// The Host must be exactly this server's own (localhost or 127.0.0.1 with its port; no DNS rebinding), an
// Origin, when a browser sends one, must be exactly this server's own origin (scheme, host and port, not
// just "some local page"), and Sec-Fetch-Site, where a browser sends it, must say same-origin or none. The
// token (server/auth.ts) is checked on top of this by the gate in server/app.ts. In development the page
// runs on another port (Vite); AFFICE_DEV_ORIGIN names that one extra origin.

import type { IncomingMessage, ServerResponse } from 'node:http';

export interface OriginPolicy {
  port: number;
  /** The origins that may call: http://localhost:<port>, http://127.0.0.1:<port> and the development origin. */
  origins: ReadonlySet<string>;
  /** The Host header values (with port) that belong to those origins. */
  hosts: ReadonlySet<string>;
}

/**
 * The development origin as `http://localhost:<port>` or `http://127.0.0.1:<port>`, or null when `value`
 * is not exactly that (a path, a query, another host, a missing port).
 */
export function parseDevOrigin(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || url.port === '') return null;
    return url.origin === value ? value : null;
  } catch {
    return null;
  }
}

export function originPolicy(port: number, devOrigin?: string | null): OriginPolicy {
  const origins = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`]);
  const extra = parseDevOrigin(devOrigin);
  if (extra) origins.add(extra);
  return { port, origins, hosts: new Set([...origins].map((origin) => origin.slice('http://'.length))) };
}

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function hostAllowed(policy: OriginPolicy, host: string | undefined): boolean {
  return host !== undefined && policy.hosts.has(host.toLowerCase());
}

/** A request with no Origin header is not a browser page (the MCP server, a script) and needs a token anyway. */
export function originAllowed(policy: OriginPolicy, origin: string | undefined): boolean {
  return origin === undefined || policy.origins.has(origin);
}

/**
 * Where a browser says the request comes from. `cross-site` and `same-site` (another port of localhost is
 * same-site) are refused; same-origin, none (the user typed the address) and no header (not a browser, or an
 * old one) pass.
 */
export function fetchSiteAllowed(req: Pick<IncomingMessage, 'headers'>): boolean {
  const site = one(req.headers['sec-fetch-site']);
  return site === undefined || site === 'same-origin' || site === 'none';
}

/** True when the browser itself says this request comes from a page of this server (the token is only given to those). */
export function sameOriginRequest(policy: OriginPolicy, req: Pick<IncomingMessage, 'headers'>): boolean {
  const origin = one(req.headers.origin);
  const site = one(req.headers['sec-fetch-site']);
  if (origin !== undefined) return policy.origins.has(origin) && (site === undefined || site === 'same-origin');
  // A same-origin GET carries no Origin header: only the Sec-Fetch-Site a browser adds says where it came from.
  return site === 'same-origin';
}

/** The refusal of a request that is not from a page of this server, or null. Host and Origin only (every route and the page). */
export function browserRefusal(policy: OriginPolicy, req: Pick<IncomingMessage, 'headers'>): string | null {
  if (!hostAllowed(policy, one(req.headers.host))) return 'Only local pages may use the office server.';
  if (!originAllowed(policy, one(req.headers.origin))) return 'Only the Affice page may use the office server.';
  return null;
}

/**
 * The Content-Security-Policy of the page and of everything else this server answers. Scripts and styles come
 * from the server itself; the page may talk to the server (and its socket), probe and frame the Trella service
 * (a local port), and nothing else. No inline script or style. Framing the page is refused (clickjacking).
 */
export function pageCsp(port: number): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ws://localhost:${port} ws://127.0.0.1:${port} http://localhost:* http://127.0.0.1:*`,
    // The Kanban view frames Trella, which listens on a local port chosen at start.
    'frame-src http://localhost:* http://127.0.0.1:*',
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** The headers every response carries; a route may replace one (the HTML report brings its own policy). */
export function securityHeaders(port: number): Record<string, string> {
  return {
    'content-security-policy': pageCsp(port),
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
  };
}

export function applySecurityHeaders(res: ServerResponse, headers: Record<string, string>): void {
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
}
