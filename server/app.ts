// The Affice server as a function: http on 127.0.0.1 for /api/*, the WebSocket at /ws, the data routes
// and, when the client is built, the client itself, all on one port. It starts with no project; the app
// host (server/host.ts) opens a project's office when the browser asks (project.open), or at start with
// `project`. Routes and commands of an office go to the open project's office, and answer an error while
// none is open. server/index.ts is the entry that runs it; the tests call startServer directly.
//
// Only the Affice page and the managers' own tools may use it:
//  - the Host must be this server's own, a browser Origin must be exactly this server's origin (scheme, host
//    and port; AFFICE_DEV_ORIGIN is the one extra, for Vite), and Sec-Fetch-Site must not say cross-site or
//    same-site (server/security.ts);
//  - every /api route and the socket also need a token (server/auth.ts): the page token for the page's
//    routes and commands, a manager's agent token for the agent routes only. The page gets its token in
//    index.html and from GET /api/session (same-origin only); the socket carries it as a subprotocol;
//  - every answer carries the security headers (frame ban, CSP, nosniff, no referrer, COOP).

import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import type { ServerEvent } from '../shared/types';
import { registerApprovalRoutes } from './approvals';
import { checkAgent, checkPage, checkTicket, pageToken, SOCKET_PROTOCOL } from './auth';
import { registerClaudeRoutes } from './claude/setup';
import { registerDataRoutes } from './data/index';
import { AppHost, type HostOptions } from './host';
import { parseCommand, registerOfficeToolRoutes } from './office';
import { registerProjectRoutes } from './project/index';
import { HttpRouter, sendJson, type Gate } from './router';
import { NEEDS_TOKEN } from './running';
import { clientDir as findClientDir, serverPort } from './runtime';
import { applySecurityHeaders, browserRefusal, fetchSiteAllowed, originPolicy, parseDevOrigin, sameOriginRequest, securityHeaders } from './security';
import { createStaticHandler } from './static';

export const BIND_HOST = '127.0.0.1';

/** What a route answers when the request has no valid token. The launcher recognises a running Affice by it. */
export { NEEDS_TOKEN };

/** Thrown by startServer when the port is taken, before anything (Trella, a project) was started. */
export class PortInUseError extends Error {
  constructor(readonly port: number) {
    super(`Port ${port} is already in use.`);
  }
}

export interface ServerOptions {
  /** Default AFFICE_PORT, else 4747. */
  port?: number;
  /** A project to open at start. Default AFFICE_PROJECT; null opens none. */
  project?: string | null;
  /** The built client to serve. Default dist/client of the package; null serves no page (the API only). */
  clientDir?: string | null;
  log?: (line: string) => void;
  /** Overrides for the app host (the tests pass seams and fake sessions). */
  host?: Partial<HostOptions>;
  /** The one extra origin of the page in development (Vite), as http://localhost:<port>. Default AFFICE_DEV_ORIGIN; null allows none. */
  devOrigin?: string | null;
}

export interface RunningServer {
  /** The address for a browser: http://localhost:<port>. */
  url: string;
  port: number;
  host: AppHost;
  /** True when the built client is served on this port. */
  servesClient: boolean;
  /** Stops the sessions and Trella, closes the sockets and the port. */
  close(): Promise<void>;
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, BIND_HOST, () => probe.close(() => resolve(true)));
  });
}

export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const port = options.port ?? serverPort();
  const log = options.log ?? ((line: string) => console.log(`[affice] ${line}`));
  const staticRoot = options.clientDir === undefined ? findClientDir() : options.clientDir;
  const requested = options.devOrigin === undefined ? process.env.AFFICE_DEV_ORIGIN : options.devOrigin;
  const devOrigin = parseDevOrigin(requested);
  if (requested && !devOrigin) log(`AFFICE_DEV_ORIGIN is ignored: ${requested} is not http://localhost:<port> or http://127.0.0.1:<port>.`);
  const policy = originPolicy(port, devOrigin);
  const headers = securityHeaders(port);
  // The page gets its token unless a browser says the request is from another site.
  const serveStatic = staticRoot ? createStaticHandler(staticRoot, { token: (req) => (fetchSiteAllowed(req) ? pageToken : null) }) : null;

  // Before anything starts: a taken port must not leave a Trella service behind.
  if (!(await portFree(port))) throw new PortInUseError(port);

  const host = new AppHost({
    officeUrl: `http://${BIND_HOST}:${port}`,
    log,
    onStderr: (department, line) => {
      if (line.trim()) console.error(`[${department}] ${line}`);
    },
    ...options.host,
  });

  // The gate of every route: page routes need the page token (or, for a report link, a ticket for that
  // file); agent routes need the agent token of the department that calls, which the route then sees as `caller`.
  const gate: Gate = (req, route) => {
    if (route.access === 'agent') {
      const caller = checkAgent(req);
      return caller ? { caller } : { status: 401, error: NEEDS_TOKEN };
    }
    if (checkPage(req)) return {};
    if (route.scope !== null && route.ticket !== null && checkTicket(route.ticket, route.scope)) return {};
    return { status: 401, error: NEEDS_TOKEN };
  };
  const router = new HttpRouter(gate);
  router.get('/api/app', () => host.appState());
  router.get('/api/office', () => host.requireOffice().snapshot());
  registerApprovalRoutes(router, () => host.requireOffice().approvals, log);
  registerOfficeToolRoutes(router, () => host.requireOffice());
  try {
    registerDataRoutes(router, host.paths, host.departments);
  } catch (error) {
    console.error('[affice] the data routes failed to register; the office runs without them:', error);
  }
  registerClaudeRoutes(router, host);
  registerProjectRoutes(router, host);

  const server = createServer((req, res) => {
    applySecurityHeaders(res, headers);
    const refusal = browserRefusal(policy, req);
    if (refusal) {
      sendJson(res, 403, { error: refusal });
      return;
    }
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const api = pathname === '/api' || pathname.startsWith('/api/');
    // A request that a browser says comes from another site (cross-site, or another local port) never reaches a route.
    if (api && !fetchSiteAllowed(req)) {
      sendJson(res, 403, { error: 'Only the Affice page may use the office server.' });
      return;
    }
    if (api && pathname === '/api/session') {
      // The page's token, to the page itself only: a same-origin request, by Origin or by Sec-Fetch-Site.
      if (req.method !== 'GET') sendJson(res, 405, { error: 'Method not allowed' });
      else if (!sameOriginRequest(policy, req)) sendJson(res, 403, { error: 'Only the Affice page may ask for the token.' });
      else sendJson(res, 200, { token: pageToken });
      return;
    }
    router
      .handle(req, res)
      .then((handled) => {
        if (handled) return;
        if (serveStatic?.(req, res)) return;
        sendJson(res, 404, { error: 'Not found' });
      })
      .catch((error) => {
        console.error('[affice] request failed:', error);
        sendJson(res, 500, { error: 'Internal error' });
      });
  });

  // The page offers two subprotocols, `affice` and `affice.<token>`; the answer names the first, so the token is never sent back.
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
    handleProtocols: (protocols) => (protocols.has(SOCKET_PROTOCOL) ? SOCKET_PROTOCOL : false),
  });
  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const refuse = (status: string) => {
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (path !== '/ws' || browserRefusal(policy, req) || !fetchSiteAllowed(req)) return refuse('403 Forbidden');
    if (!checkPage(req)) return refuse('401 Unauthorized');
    sockets.handleUpgrade(req, socket, head, (ws) => sockets.emit('connection', ws, req));
  });

  sockets.on('connection', (ws: WebSocket) => {
    ws.send(JSON.stringify({ type: 'app.state', state: host.appState() } satisfies ServerEvent));
    ws.send(JSON.stringify({ type: 'office.state', snapshot: host.officeSnapshot() } satisfies ServerEvent));
    ws.on('message', (data) => {
      const command = parseCommand(String(data));
      if (typeof command === 'string') {
        ws.send(JSON.stringify({ type: 'error', department: null, message: command } satisfies ServerEvent));
        return;
      }
      void host.handle(command);
    });
    ws.on('error', () => undefined);
  });

  host.on('event', (event: ServerEvent) => {
    const frame = JSON.stringify(event);
    for (const client of sockets.clients) if (client.readyState === WebSocket.OPEN) client.send(frame);
  });

  // Claude Code is checked (and the project opened) before the first page can connect.
  await host.start(options.project === undefined ? {} : { project: options.project });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, BIND_HOST, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    // The port was taken between the check and now: undo what start() opened.
    await host.shutdown().catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new PortInUseError(port);
    throw error;
  }
  // The server must not die of a socket error after start.
  server.on('error', (error) => console.error('[affice] server error:', error));

  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      await host.shutdown().catch(() => undefined);
      for (const client of sockets.clients) client.terminate();
      sockets.close();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    })();
    return closing;
  };

  const project = host.layout()?.project;
  log(`listening on http://${BIND_HOST}:${port}${project ? ` with ${project}` : ', no project open'}${serveStatic ? '' : ' (no built client: the API only)'}`);
  return { url: `http://localhost:${port}`, port, host, servesClient: serveStatic !== null, close };
}
