// Creates a department's Trella project and board through the Trella CLI, run from the office root so it
// finds .agentboard. Without --as the CLI acts as the human in .agentboard/config.json: the user,
// who asked for the department. The board id is read back from `trella boards`.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { minimalEnv } from './env';
import { FRESH_COPY_ADVICE } from './runtime';

export interface BoardResult {
  boardId: string | null;
  error: string | null;
}

export type CreateBoard = (name: string) => Promise<BoardResult>;

interface Run {
  ok: boolean;
  stdout: string;
  error: string;
}

function run(root: string, cli: string, args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    // The minimal environment (SEC-14): the CLI needs a PATH and a home folder, not the user's credentials.
    execFile(process.execPath, [cli, ...args], { cwd: root, env: minimalEnv({ NO_COLOR: '1' }), timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const message = String(stderr).trim().split('\n').pop() || (error ? error.message : '');
      resolve({ ok: !error, stdout: String(stdout), error: message });
    });
  });
}

function json(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

interface BoardRow {
  id: string;
  projectId: string;
  name: string;
  createdAt?: string;
}

export function findBoard(summary: unknown, projectId: string, name: string): string | null {
  const boards = (summary as { boards?: BoardRow[] } | null)?.boards;
  if (!Array.isArray(boards)) return null;
  const matches = boards
    .filter((b) => b && b.projectId === projectId && b.name === name)
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
  return matches[0]?.id ?? null;
}

/**
 * Why the Trella CLI cannot run, as a sentence for the user, or null when it can: the file is missing
 * (wrong AFFICE_TRELLA_CLI, or the vendored copy is gone) or it was never built.
 */
export function trellaProblem(cli: string): string | null {
  if (!existsSync(cli)) {
    return `Trella was not found at ${cli}. If AFFICE_TRELLA_CLI is set, check its path, or unset it to use the bundled Trella. ${FRESH_COPY_ADVICE}`;
  }
  if (!existsSync(join(dirname(cli), '..', 'dist', 'index.js'))) {
    return `Trella is not built (${cli}). ${FRESH_COPY_ADVICE}`;
  }
  return null;
}

export function trellaBoards(root: string, cli: string): CreateBoard {
  return async (name) => {
    const problem = trellaProblem(cli);
    if (problem) return { boardId: null, error: problem };
    const project = await run(root, cli, ['new-project', name, '--json']);
    const projectId = project.ok ? ((json(project.stdout)?.project as { id?: string } | undefined)?.id ?? null) : null;
    if (!projectId) return { boardId: null, error: `trella new-project failed: ${project.error || 'no project id in its output'}` };

    const board = await run(root, cli, [
      'new-board', name,
      '--project', projectId,
      '--description', `The ${name} department's board, created from the Affice office.`,
      '--json',
    ]);
    if (!board.ok) return { boardId: null, error: `trella new-board failed: ${board.error}` };

    const boards = await run(root, cli, ['boards', '--json']);
    const boardId = boards.ok ? findBoard(json(boards.stdout), projectId, name) : null;
    if (!boardId) return { boardId: null, error: `the new board is not in trella boards: ${boards.error || 'not found'}` };
    return { boardId, error: null };
  };
}
