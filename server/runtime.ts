// Where Affice runs from and how it is configured: the package root, the built client, the version, the
// port. The same code runs from the TypeScript sources (development, tsx) and from the bundle in dist/
// (the npm package), so nothing here assumes one layout: the package root is found by walking up from
// this file to the package.json named affice.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The port of the office server unless AFFICE_PORT or --port says otherwise. */
export const DEFAULT_PORT = 4747;
/** The port a Trella service starts looking from (it steps up when that one is taken). */
export const DEFAULT_TRELLA_PORT = 4174;

function readJson(path: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

let cachedRoot: string | null = null;

/** The folder that holds package.json (name affice): the repository in development, the installed package otherwise. */
export function packageRoot(): string {
  if (cachedRoot) return cachedRoot;
  const here = dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (;;) {
    if (readJson(join(dir, 'package.json'))?.name === 'affice') return (cachedRoot = dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Not inside a package (a copied bundle): the folder above this file, which both layouts share.
  return (cachedRoot = resolve(here, '..'));
}

/**
 * What to say when files the package should carry are missing. True for someone who ran `npx affice` (a fresh
 * copy fixes it) and for a contributor in a clone (where the files come from a build).
 */
export const FRESH_COPY_ADVICE = 'Run npx --yes affice@latest to fetch a fresh copy. In a clone of the repository, run npm run build there.';

/** The version in package.json. */
export function afficeVersion(): string {
  const version = readJson(join(packageRoot(), 'package.json'))?.version;
  return typeof version === 'string' ? version : '0.0.0';
}

/** The port of the office server: AFFICE_PORT, else 4747. */
export function serverPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AFFICE_PORT;
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_PORT;
}

/** The built client the server serves: AFFICE_CLIENT_DIR, else dist/client of the package. Null while it is not built. */
export function clientDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidate = env.AFFICE_CLIENT_DIR ? resolve(env.AFFICE_CLIENT_DIR) : join(packageRoot(), 'dist', 'client');
  return existsSync(join(candidate, 'index.html')) ? candidate : null;
}
