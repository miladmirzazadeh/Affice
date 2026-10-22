// The page's token for the office server. The server puts it into index.html as
// <meta name="affice-token">; in development (Vite serves the page) there is no meta tag and the page asks
// GET /api/session, which the server answers only to a same-origin request. Every /api request carries it
// in the x-affice-token header, and the socket in its subprotocol, never in a URL. After a server restart
// the old token is refused: the page forgets it, asks again and retries once.

export const TOKEN_HEADER = 'x-affice-token';
/** The first subprotocol the page offers; the token follows as `affice.<token>`. The server answers with this one. */
export const SOCKET_PROTOCOL = 'affice';

let token: string | null = readMeta();
let asking: Promise<string | null> | null = null;

function readMeta(): string | null {
  if (typeof document === 'undefined') return null;
  return document.querySelector('meta[name="affice-token"]')?.getAttribute('content') || null;
}

export function currentToken(): string | null {
  return token;
}

/** Drops the held token (the server refused it), so the next use asks for a new one. */
export function forgetToken(): void {
  token = null;
}

/** GET /api/session: the token of this server start, for a page the server did not serve (development). */
export function fetchToken(): Promise<string | null> {
  asking ??= (async () => {
    try {
      const response = await fetch('/api/session', { cache: 'no-store' });
      if (!response.ok) return null;
      const body = (await response.json()) as { token?: unknown };
      token = typeof body.token === 'string' && body.token ? body.token : null;
      return token;
    } catch {
      return null;
    } finally {
      asking = null;
    }
  })();
  return asking;
}

export async function ensureToken(): Promise<string | null> {
  return token ?? fetchToken();
}

/** The subprotocols for `new WebSocket(url, ...)`. Without a token only the plain one is offered (the server will refuse). */
export function socketProtocols(value: string | null): string[] {
  return value ? [SOCKET_PROTOCOL, `${SOCKET_PROTOCOL}.${value}`] : [SOCKET_PROTOCOL];
}

/** fetch for the office server's own routes: adds the token, and on a 401 asks for a fresh token and tries once more. */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const attempt = async (): Promise<Response> => {
    const headers = new Headers(init.headers);
    const value = await ensureToken();
    if (value) headers.set(TOKEN_HEADER, value);
    return fetch(input, { ...init, headers });
  };
  const first = await attempt();
  if (first.status !== 401) return first;
  forgetToken();
  return attempt();
}
