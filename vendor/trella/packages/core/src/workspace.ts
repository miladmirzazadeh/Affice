import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { TrellaError } from './errors.js';
import { requireActor } from './service.js';
import type { Actor, ProjectConfig } from './types.js';

export const WORKSPACE_DIR = '.agentboard';
export const CONFIG_FILE = 'config.json';
export const RUNTIME_FILE = 'service.json';
export const DEFAULT_PORT = 4174;

export interface Workspace {
  /** Project root: the directory that contains `.agentboard/`. */
  root: string;
  dir: string;
  configPath: string;
  config: ProjectConfig;
}

/** Where the local service publishes its address for the CLI and MCP server. */
export interface ServiceRuntime {
  url: string;
  host: string;
  port: number;
  pid: number;
  startedAt: string;
  version: string;
}

/** Walks up from `from` looking for an initialised workspace. */
export function findWorkspace(from: string = process.cwd()): Workspace | null {
  let dir = resolve(from);
  for (;;) {
    const configPath = join(dir, WORKSPACE_DIR, CONFIG_FILE);
    if (existsSync(configPath)) {
      return { root: dir, dir: join(dir, WORKSPACE_DIR), configPath, config: readConfig(configPath) };
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function requireWorkspace(from: string = process.cwd()): Workspace {
  const workspace = findWorkspace(from);
  if (!workspace) {
    throw new TrellaError(
      'not_initialized',
      'No Trella workspace here yet. Run `npx trella init` in your project root to create one.'
    );
  }
  return workspace;
}

export function readConfig(configPath: string): ProjectConfig {
  const raw = readFileSync(configPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new TrellaError('invalid_input', `${configPath} is not valid JSON.`, { cause });
  }
  return withDefaults(parsed as Partial<ProjectConfig>);
}

function withDefaults(input: Partial<ProjectConfig>): ProjectConfig {
  return {
    version: input.version ?? 2,
    workspace: { name: input.workspace?.name ?? 'Trella' },
    identity: input.identity ? requireActor(input.identity) : defaultIdentity(),
    data: input.data ?? WORKSPACE_DIR,
    server: {
      port: input.server?.port ?? DEFAULT_PORT,
      host: input.server?.host ?? '127.0.0.1',
      open: input.server?.open ?? true,
    },
    fileAdapter: {
      enabled: input.fileAdapter?.enabled ?? true,
      inbox: input.fileAdapter?.inbox ?? join(WORKSPACE_DIR, 'inbox'),
      outbox: input.fileAdapter?.outbox ?? join(WORKSPACE_DIR, 'outbox'),
    },
  };
}

/** Best-effort human identity: git first, then the OS account. */
export function defaultIdentity(): Actor {
  let name = '';
  try {
    name = execFileSync('git', ['config', '--get', 'user.name'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    name = '';
  }
  if (!name) {
    try {
      name = userInfo().username;
    } catch {
      name = 'You';
    }
  }
  return { type: 'human', id: 'local-human', name: name || 'You' };
}

export interface InitOptions {
  workspaceName?: string;
  identity?: Actor;
  port?: number;
  force?: boolean;
}

export function initWorkspace(root: string, options: InitOptions = {}): Workspace {
  const dir = join(root, WORKSPACE_DIR);
  const configPath = join(dir, CONFIG_FILE);

  if (existsSync(configPath) && !options.force) {
    return { root, dir, configPath, config: readConfig(configPath) };
  }

  mkdirSync(join(dir, 'projects'), { recursive: true });

  const config: ProjectConfig = withDefaults({
    version: 2,
    workspace: { name: options.workspaceName ?? basename(root) },
    identity: options.identity ?? defaultIdentity(),
    server: { port: options.port ?? DEFAULT_PORT, host: '127.0.0.1', open: true },
  });

  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  // The board itself is project data worth committing; the runtime address,
  // exchange folders and lock are specific to this machine.
  const ignorePath = join(dir, '.gitignore');
  if (!existsSync(ignorePath)) {
    writeFileSync(
      ignorePath,
      [
        '# Commit config.json and projects/ if you want the board shared with the',
        '# repository. Everything below is local to this machine.',
        'service.json',
        'state.json',
        '.lock/',
        'inbox/',
        'outbox/',
        '*.tmp',
        '',
      ].join('\n')
    );
  }

  return { root, dir, configPath, config };
}

function basename(path: string): string {
  const parts = resolve(path).split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? 'Trella';
}

/** The `.agentboard` directory that holds the JSON. */
export function dataPath(workspace: Workspace): string {
  const configured = workspace.config.data;
  return isAbsolute(configured) ? configured : join(workspace.root, configured);
}

export function runtimePath(workspace: Workspace): string {
  return join(workspace.dir, RUNTIME_FILE);
}

export function writeRuntime(workspace: Workspace, runtime: ServiceRuntime): void {
  mkdirSync(workspace.dir, { recursive: true });
  writeFileSync(runtimePath(workspace), `${JSON.stringify(runtime, null, 2)}\n`);
}

export function clearRuntime(workspace: Workspace): void {
  try {
    rmSync(runtimePath(workspace), { force: true });
  } catch {
    // Nothing to clean up.
  }
}

/**
 * Reads the published service address, discarding a stale file left behind by a
 * process that exited without cleaning up.
 */
export function readRuntime(workspace: Workspace): ServiceRuntime | null {
  const path = runtimePath(workspace);
  if (!existsSync(path)) return null;
  try {
    const runtime = JSON.parse(readFileSync(path, 'utf8')) as ServiceRuntime;
    if (!runtime.url || !runtime.pid) return null;
    if (!isProcessAlive(runtime.pid)) return null;
    return runtime;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
