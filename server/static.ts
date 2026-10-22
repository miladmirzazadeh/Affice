// Serves the built client (dist/client) from the office server, so one process answers the API, the
// socket and the page. Unknown paths without a file extension fall back to index.html (the single page
// app); a missing file with an extension is a 404. The caller has already applied the local-only Host and
// Origin checks. index.html is served with the page token injected.

import { createReadStream, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

function fileInfo(path: string): { size: number } | null {
  try {
    const stats = statSync(path);
    return stats.isFile() ? { size: stats.size } : null;
  } catch {
    return null;
  }
}

/** The file inside `root` for a request path, or null (outside the folder, or not a file). */
export function resolveFile(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const base = resolve(root);
  const target = normalize(join(base, decoded));
  if (target !== base && !target.startsWith(base + sep)) return null;
  return fileInfo(target) ? target : null;
}

export type StaticHandler = (req: IncomingMessage, res: ServerResponse) => boolean;

export interface StaticOptions {
  /**
   * The page token to put into index.html as <meta name="affice-token">, for this request; null serves the
   * page without it (a cross-site request: the page then asks /api/session, which refuses a foreign page).
   */
  token?: (req: IncomingMessage) => string | null;
}

/** The page with its token as the first element of <head>. */
export function withToken(html: string, token: string): string {
  const meta = `<meta name="affice-token" content="${token}">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (head) => `${head}${meta}`);
  // No <head>: after the doctype (before it the page would fall into quirks mode), else first.
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  return doctype ? `${doctype[0]}${meta}${html.slice(doctype[0].length)}` : `${meta}${html}`;
}

/** True for paths the page never asks the static files for: the API and the socket. */
function reserved(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/') || pathname === '/ws';
}

/**
 * Returns a handler that answers GET and HEAD for files of `root`, and true when it answered. It leaves
 * every other method, and /api and /ws, to the caller.
 */
export function createStaticHandler(root: string, options: StaticOptions = {}): StaticHandler {
  const index = join(resolve(root), 'index.html');
  return (req, res) => {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') return false;
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (reserved(pathname)) return false;

    let file = resolveFile(root, pathname === '/' ? '/index.html' : pathname);
    if (!file && !extname(pathname)) file = fileInfo(index) ? index : null; // the single page app
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' });
      res.end(method === 'HEAD' ? undefined : 'Not found');
      return true;
    }

    const html = extname(file) === '.html';
    if (html && options.token) {
      // The page carries a secret that differs at every start: never cached, never sent as a bare file.
      const token = options.token(req);
      let body: string;
      try {
        body = readFileSync(file, 'utf8');
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' });
        res.end(method === 'HEAD' ? undefined : 'Not found');
        return true;
      }
      const page = token ? withToken(body, token) : body;
      res.writeHead(200, {
        'content-type': TYPES['.html'],
        'content-length': String(Buffer.byteLength(page)),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end(method === 'HEAD' ? undefined : page);
      return true;
    }

    const size = fileInfo(file)!.size;
    res.writeHead(200, {
      'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': String(size),
      // The built assets are named by their hash; the page that names them must always be fresh.
      'cache-control': html ? 'no-cache' : file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
    });
    if (method === 'HEAD') {
      res.end();
      return true;
    }
    const stream = createReadStream(file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
    return true;
  };
}
