import { createReadStream, existsSync, statSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Serves the built interface. Everything under `assets/` carries a content hash
 * from the bundler, so it can be cached forever; `index.html` never is.
 */
export function createStaticHandler(root: string | null) {
  return function serveStatic(pathname: string, response: ServerResponse): boolean {
    if (!root || !existsSync(root)) return false;

    const relative = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
    const target = resolve(root, relative);
    // Never serve outside the web root, whatever the request encodes.
    if (target !== resolve(root) && !target.startsWith(resolve(root) + sep)) return false;

    let file = target;
    if (!existsSync(file) || statSync(file).isDirectory()) {
      const index = join(root, 'index.html');
      if (!existsSync(index)) return false;
      file = index;
    }

    const extension = extname(file).toLowerCase();
    const isHashedAsset = file.includes(`${sep}assets${sep}`) && extension !== '.html';
    response.writeHead(200, {
      'content-type': MIME[extension] ?? 'application/octet-stream',
      'content-length': statSync(file).size,
      'cache-control': isHashedAsset ? 'public, max-age=31536000, immutable' : 'no-store',
      // The board never loads anything from another origin.
      'content-security-policy':
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self'",
      'x-content-type-options': 'nosniff',
    });
    createReadStream(file).pipe(response);
    return true;
  };
}
