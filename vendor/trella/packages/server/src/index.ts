import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isAbsolute, join } from 'node:path';
import {
  BoardService,
  TrellaError,
  clearRuntime,
  dataPath,
  writeRuntime,
  type ServiceRuntime,
  type Workspace,
} from '@trella/core';
import { createApi } from './api.js';
import { EventStream } from './stream.js';
import { FileAdapter } from './fileAdapter.js';
import { createStaticHandler } from './static.js';
import { Router, isAllowedOrigin, isLocalHost, readJsonBody, sendError, sendJson } from './http.js';

export { FileAdapter } from './fileAdapter.js';
export type { FileRequest } from './fileAdapter.js';

export interface StartOptions {
  workspace: Workspace;
  /** Directory of the built interface. Omitted in API-only mode. */
  webRoot?: string | null;
  port?: number;
  host?: string;
  version?: string;
  /** Reuse an existing service instead of opening the database twice. */
  board?: BoardService;
}

export interface RunningService {
  url: string;
  host: string;
  port: number;
  board: BoardService;
  server: Server;
  stop: () => Promise<void>;
}

export async function startServer(options: StartOptions): Promise<RunningService> {
  const { workspace } = options;
  const config = workspace.config;
  const host = options.host ?? config.server.host ?? '127.0.0.1';
  const version = options.version ?? '0.1.0';

  const board =
    options.board ??
    new BoardService({ data: dataPath(workspace), workspaceName: config.workspace.name });

  const stream = new EventStream(board);
  const api = createApi({ board, stream, config, version });
  const serveStatic = createStaticHandler(options.webRoot ?? null);

  const fileAdapter = config.fileAdapter.enabled
    ? new FileAdapter({
        board,
        inbox: absolute(workspace.root, config.fileAdapter.inbox),
        outbox: absolute(workspace.root, config.fileAdapter.outbox),
        onError: (error) => {
          process.stderr.write(`trella: file adapter — ${describe(error)}\n`);
        },
      })
    : null;

  const server = createServer((request, response) => {
    void handle(api, serveStatic, request, response);
  });
  server.keepAliveTimeout = 0; // Long-lived SSE streams manage their own lifetime.

  const port = await listen(server, host, options.port ?? config.server.port);
  const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;

  const runtime: ServiceRuntime = {
    url,
    host,
    port,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    version,
  };
  writeRuntime(workspace, runtime);

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    fileAdapter?.close();
    stream.close();
    clearRuntime(workspace);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections?.();
    if (!options.board) board.close();
  };

  return { url, host, port, board, server, stop };
}

async function handle(
  api: Router,
  serveStatic: ReturnType<typeof createStaticHandler>,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  try {
    if (!isLocalHost(request.headers.host)) {
      sendJson(response, 403, {
        error: {
          code: 'forbidden',
          message: 'Trella only serves requests addressed to localhost.',
        },
      });
      return;
    }

    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    const method = request.method ?? 'GET';

    if (method !== 'GET' && method !== 'HEAD' && !isAllowedOrigin(request.headers.origin)) {
      sendJson(response, 403, {
        error: { code: 'forbidden', message: 'Cross-origin writes are not allowed.' },
      });
      return;
    }

    const matched = api.match(method, url.pathname);
    if (matched) {
      const body =
        method === 'GET' || method === 'HEAD' ? undefined : await readJsonBody(request);
      const result = await matched.route.handler({
        request,
        response,
        url,
        params: matched.params,
        body,
      });
      if (matched.route.streaming) return;
      sendJson(response, response.statusCode === 200 ? 200 : response.statusCode, result);
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      sendError(response, new TrellaError('not_found', `No route for ${method} ${url.pathname}.`));
      return;
    }

    if (serveStatic(url.pathname, response)) return;

    sendJson(response, 404, {
      error: {
        code: 'not_found',
        message:
          'The interface is not built. Run `npm run build` in the Trella repository, ' +
          'or use the API at /api/board.',
      },
    });
  } catch (error) {
    if (!response.headersSent) sendError(response, error);
    else response.end();
  }
}

/** Binds to `port`, stepping forward if a neighbouring project already has it. */
function listen(server: Server, host: string, port: number, attempts = 20): Promise<number> {
  return new Promise((resolve, reject) => {
    let remaining = attempts;
    let current = port;

    const onError = (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE' && remaining > 0) {
        remaining -= 1;
        current += 1;
        server.listen(current, host);
        return;
      }
      server.off('error', onError);
      reject(error);
    };

    server.on('error', onError);
    server.once('listening', () => {
      server.off('error', onError);
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : current);
    });
    server.listen(current, host);
  });
}

function absolute(root: string, path: string): string {
  return isAbsolute(path) ? path : join(root, path);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
