// Decisions for the Decisions view, read straight from Trella's JSON files, read-only:
// <root>/.agentboard/projects/<project>/boards/<board>/board.json and cards/<KEY>.json.
// Trella is never called and never written; its own writes are atomic renames, so a card
// file is always whole.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DecisionCard, DecisionsView, Department } from '../../shared/types';

const DECISION_LABEL = 'decision';

interface BoardFile {
  id: string;
  name: string;
  createdAt?: string;
  columns?: Array<{ id: string; terminal?: boolean }>;
}

interface CardFile {
  id: string;
  boardId: string;
  title: string;
  status: string;
  labels?: string[];
  archived?: boolean;
  updatedAt: string;
}

/** The Trella workspace is not where the office expects it. */
export class TrellaMissing extends Error {}

/**
 * Trella's web UI has no route for a board or a card today (it shows the board it remembers),
 * so these query parameters are what a Trella change should read. Until then the link opens Trella.
 */
export function trellaCardUrl(trellaUrl: string, boardId: string, key: string): string {
  return `${trellaUrl.replace(/\/+$/, '')}/?board=${encodeURIComponent(boardId)}&card=${encodeURIComponent(key)}`;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null; // missing, or not valid JSON: skip it
  }
}

async function names(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** Every board of the workspace with the folder that holds its cards. */
async function readBoards(projectsDir: string): Promise<Array<{ board: BoardFile; dir: string }>> {
  const projects = await names(projectsDir);
  const found: Array<{ board: BoardFile; dir: string }> = [];
  for (const project of projects) {
    const boardsDir = join(projectsDir, project, 'boards');
    for (const folder of await names(boardsDir)) {
      const dir = join(boardsDir, folder);
      const board = await readJson<BoardFile>(join(dir, 'board.json'));
      if (board?.id && board.name) found.push({ board, dir });
    }
  }
  return found;
}

async function readCards(dir: string): Promise<CardFile[]> {
  const files = (await names(join(dir, 'cards'))).filter((name) => name.endsWith('.json'));
  const cards = await Promise.all(files.map((name) => readJson<CardFile>(join(dir, 'cards', name))));
  return cards.filter((card): card is CardFile => !!card?.id && !!card.boardId && typeof card.title === 'string');
}

function keyOrder(a: string, b: string): number {
  const split = (key: string) => {
    const m = /^(.*?)-(\d+)$/.exec(key);
    return m ? { prefix: m[1]!, n: Number(m[2]) } : { prefix: key, n: 0 };
  };
  const [x, y] = [split(a), split(b)];
  return x.prefix.localeCompare(y.prefix) || x.n - y.n;
}

/**
 * Open cards (not archived, not in a terminal column) labelled `decision` on every board of the
 * project's Trella workspace. The department's own board comes first, then the other boards in the
 * order they were created. No board has a special name: the general manager has no board of its own
 * and sees all of them.
 */
export async function readDecisions(
  root: string,
  trellaUrl: string,
  department: Pick<Department, 'trellaBoardId'>,
): Promise<DecisionsView> {
  const projectsDir = join(root, '.agentboard', 'projects');
  if ((await names(projectsDir)).length === 0) {
    throw new TrellaMissing(`No Trella workspace found at ${join(root, '.agentboard')}.`);
  }
  const boards = (await readBoards(projectsDir)).sort(
    (a, b) =>
      Number(b.board.id === department.trellaBoardId) - Number(a.board.id === department.trellaBoardId) ||
      (a.board.createdAt ?? '').localeCompare(b.board.createdAt ?? '') ||
      a.board.name.localeCompare(b.board.name),
  );

  const picked: DecisionCard[] = [];
  const seen = new Set<string>();
  for (const entry of boards) {
    const terminal = new Set((entry.board.columns ?? []).filter((column) => column.terminal).map((column) => column.id));
    const cards = (await readCards(entry.dir))
      .filter((card) => !card.archived && !terminal.has(card.status))
      .filter((card) => (card.labels ?? []).some((label) => label.trim().toLowerCase() === DECISION_LABEL))
      .sort((a, b) => keyOrder(a.id, b.id));
    for (const card of cards) {
      if (seen.has(card.id)) continue;
      seen.add(card.id);
      picked.push({
        key: card.id,
        title: card.title,
        boardId: card.boardId,
        boardName: entry.board.name,
        status: card.status,
        labels: card.labels ?? [],
        updatedAt: card.updatedAt,
        url: trellaCardUrl(trellaUrl, card.boardId, card.id),
      });
    }
  }

  return { generatedAt: new Date().toISOString(), cards: picked };
}
