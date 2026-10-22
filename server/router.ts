// A small JSON router: `:name` path segments, handlers return values that are sent as JSON, and a
// thrown RouteError sets the status. Implements the frozen `Router` of shared/server-api.ts and adds
// `post` for the server's own endpoints.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isRawResponse, RouteError, type RawResponse, type RouteOptions, type RouteRequest, type Router } from '../shared/server-api';

export type { RouteOptions };

export interface PostRequest extends RouteRequest {
  body: unknown;
}

/** What a handler of a route sees. `caller` is the department the gate verified, on an agent route. */
type Handler = (request: RouteRequest & { body?: unknown; caller?: string }) => Promise<unknown> | unknown;

/** What the gate is asked about a request: which kind of route, and the ticket and its scope when the route takes one. */
export interface GateRoute {
  access: 'page' | 'agent';
  scope: string | null;
  ticket: string | null;
}

/** The gate of the server (server/app.ts): `{caller}` lets the request in, anything else refuses it. */
export type Gate = (req: IncomingMessage, route: GateRoute) => { caller?: string } | { status: number; error: string };

interface Route {
  method: 'GET' | 'POST';
  segments: string[];
  handler: Handler;
  options: RouteOptions;
}

const MAX_BODY = 1024 * 1024;

export function matchPath(segments: string[], path: string): Record<string, string> | null {
  const parts = path.split('/').filter(Boolean);
  if (parts.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    let part: string;
    try {
      part = decodeURIComponent(parts[i]);
    } catch {
      return null;
    }
    if (segment.startsWith(':')) params[segment.slice(1)] = part;
    else if (segment !== part) return null;
  }
  return params;
}

export class HttpRouter implements Router {
  private readonly routes: Route[] = [];

  /** The server passes its gate; a router without one lets every request in (the unit tests of single route sets). */
  constructor(private readonly gate: Gate | null = null) {}

  get(pattern: string, handler: (request: RouteRequest & { caller?: string }) => Promise<unknown> | unknown, options: RouteOptions = {}): void {
    this.routes.push({ method: 'GET', segments: pattern.split('/').filter(Boolean), handler, options });
  }

  post(pattern: string, handler: (request: PostRequest & { caller?: string }) => Promise<unknown> | unknown, options: RouteOptions = {}): void {
    this.routes.push({ method: 'POST', segments: pattern.split('/').filter(Boolean), handler: handler as Handler, options });
  }

  /** Answers the request. Returns false when no route matches the path, so the caller can 404. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    let pathMatched = false;
    for (const route of this.routes) {
      const params = matchPath(route.segments, url.pathname);
      if (!params) continue;
      pathMatched = true;
      if (route.method !== req.method) continue;
      try {
        // Before the body is read: a request without the right token costs nothing.
        let caller: string | undefined;
        if (this.gate) {
          const scope = route.options.ticketScope ? route.options.ticketScope({ params, query: url.searchParams }) : null;
          const verdict = this.gate(req, { access: route.options.agent ? 'agent' : 'page', scope, ticket: url.searchParams.get('ticket') });
          if ('status' in verdict) {
            sendJson(res, verdict.status, { error: verdict.error });
            return true;
          }
          caller = verdict.caller;
        }
        const body = route.method === 'POST' ? await readJson(req) : undefined;
        const result = await route.handler({ params, query: url.searchParams, body, caller });
        if (isRawResponse(result)) sendRaw(res, result);
        else sendJson(res, 200, result === undefined ? null : result);
      } catch (error) {
        if (error instanceof RouteError) sendJson(res, error.status, { error: error.message });
        else {
          console.error(`[affice] ${req.method} ${url.pathname} failed:`, error);
          sendJson(res, 500, { error: 'Internal error' });
        }
      }
      return true;
    }
    if (pathMatched) {
      sendJson(res, 405, { error: 'Method not allowed' });
      return true;
    }
    return false;
  }
}

function sendRaw(res: ServerResponse, raw: RawResponse): void {
  res.writeHead(200, { ...raw.headers, 'content-type': raw.contentType, 'cache-control': 'no-store' });
  res.end(raw.body);
}

export function sendJson(res: ServerResponse, status: number, value: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new RouteError(413, 'The request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve(null);
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new RouteError(400, 'The request body is not JSON.'));
      }
    });
    req.on('error', reject);
  });
}
