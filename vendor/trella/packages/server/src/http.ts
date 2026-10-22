import type { IncomingMessage, ServerResponse } from 'node:http';
import { TrellaError, isTrellaError } from '@trella/core';

export interface RequestContext {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  params: Record<string, string>;
  body: unknown;
}

export type Handler = (context: RequestContext) => unknown | Promise<unknown>;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
  /** Streaming routes own their response; the router must not write to it. */
  streaming: boolean;
}

/**
 * A deliberately small router. Trella only needs exact segments and `:name`
 * captures, and a dependency-free server is one less thing to keep patched in a
 * tool people run on their own machine.
 */
export class Router {
  readonly #routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler, options: { streaming?: boolean } = {}) {
    this.#routes.push({
      method,
      segments: pattern.split('/').filter(Boolean),
      handler,
      streaming: options.streaming ?? false,
    });
    return this;
  }

  get(pattern: string, handler: Handler, options?: { streaming?: boolean }) {
    return this.add('GET', pattern, handler, options);
  }
  post(pattern: string, handler: Handler) {
    return this.add('POST', pattern, handler);
  }
  patch(pattern: string, handler: Handler) {
    return this.add('PATCH', pattern, handler);
  }

  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
    const parts = pathname.split('/').filter(Boolean);
    let pathMatched = false;

    for (const route of this.#routes) {
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i += 1) {
        const segment = route.segments[i]!;
        const part = parts[i]!;
        if (segment.startsWith(':')) params[segment.slice(1)] = decodeURIComponent(part);
        else if (segment !== part) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      pathMatched = true;
      if (route.method === method) return { route, params };
    }

    if (pathMatched) {
      throw new TrellaError('invalid_input', `${method} is not supported on this path.`, {
        status: 405,
      });
    }
    return null;
  }
}

const MAX_BODY_BYTES = 2 * 1024 * 1024;

export async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new TrellaError('invalid_input', 'Request body is larger than 2 MB.', { status: 413 });
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new TrellaError('invalid_input', 'Request body is not valid JSON.', {
      status: 400,
      cause,
    });
  }
}

export function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload ?? null);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

export function sendError(response: ServerResponse, error: unknown): void {
  if (isTrellaError(error)) {
    sendJson(response, error.status, error.toJSON());
    return;
  }
  const message = error instanceof Error ? error.message : 'Unexpected server error.';
  sendJson(response, 500, { error: { code: 'internal', message } });
}

/**
 * Only serves requests that are genuinely local. Binding to 127.0.0.1 stops
 * remote connections; checking Host stops a page on another origin from using
 * DNS rebinding to reach the board through the browser.
 */
export function isLocalHost(header: string | undefined): boolean {
  if (!header) return false;
  const host = header.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0';
}

export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // Non-browser callers (CLI, MCP) send no Origin.
  try {
    const url = new URL(origin);
    return isLocalHost(url.host);
  } catch {
    return false;
  }
}
