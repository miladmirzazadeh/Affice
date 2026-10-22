import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { TrellaError } from './errors.js';
import type { ActivityEvent, Board, Card, Project } from './types.js';

/**
 * Storage is a folder of JSON you can open, read, diff and commit — no database,
 * no binary file, no tool required to inspect it.
 *
 *   .agentboard/
 *     config.json                        the workspace's own settings
 *     state.json                         { revision, seq } — the change stamp
 *     projects/<project>/project.json
 *     projects/<project>/boards/<board>/board.json
 *     projects/<project>/boards/<board>/cards/<CARD-ID>.json
 *     projects/<project>/boards/<board>/activity.jsonl
 *
 * The trade-off against SQLite is real: plain files give no transactions, so
 * this layer supplies the two things that were free before. Every write goes to
 * a temporary file and is moved into place, so a reader never sees half a card;
 * and every mutation runs inside a cross-process lock directory, so two writers
 * cannot interleave. `state.json` is bumped last, which is how another process
 * knows to reload.
 */

const LOCK_DIR = '.lock';
const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 30_000;

export interface StoreSnapshot {
  projects: Map<string, Project>;
  boards: Map<string, Board>;
  /** Every card in the workspace, by its globally unique id. */
  cards: Map<string, Card>;
  cardsByBoard: Map<string, string[]>;
  seq: number;
  revision: number;
}

export class FileStore {
  readonly root: string;
  #snapshot: StoreSnapshot = emptySnapshot();
  #loaded = false;

  constructor(root: string) {
    this.root = root;
    mkdirSync(join(root, 'projects'), { recursive: true });
  }

  /* ------------------------------------------------------------------ paths */

  #statePath(): string {
    return join(this.root, 'state.json');
  }

  #projectDir(projectId: string): string {
    return join(this.root, 'projects', projectId);
  }

  #boardDir(board: Board): string {
    return join(this.#projectDir(board.projectId), 'boards', board.id);
  }

  #cardPath(board: Board, cardId: string): string {
    return join(this.#boardDir(board), 'cards', `${cardId}.json`);
  }

  /* ------------------------------------------------------------------ state */

  #readState(): { revision: number; seq: number } {
    const path = this.#statePath();
    if (!existsSync(path)) return { revision: 0, seq: 0 };
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { revision?: number; seq?: number };
      return { revision: Number(parsed.revision ?? 0), seq: Number(parsed.seq ?? 0) };
    } catch {
      return { revision: 0, seq: 0 };
    }
  }

  #writeState(revision: number, seq: number): void {
    writeAtomic(this.#statePath(), `${JSON.stringify({ revision, seq }, null, 2)}\n`);
  }

  /**
   * Reloads from disk when someone else has written since the last read. Called
   * before every operation, so a CLI command in one terminal and the service in
   * another never disagree about what is on the board.
   */
  snapshot(): StoreSnapshot {
    const state = this.#readState();
    if (!this.#loaded || state.revision !== this.#snapshot.revision) this.#load(state);
    return this.#snapshot;
  }

  #load(state: { revision: number; seq: number }): void {
    const snapshot = emptySnapshot();
    snapshot.revision = state.revision;
    snapshot.seq = state.seq;

    const projectsRoot = join(this.root, 'projects');
    for (const projectId of listDirs(projectsRoot)) {
      const project = readJson<Project>(join(projectsRoot, projectId, 'project.json'));
      if (!project) continue;
      snapshot.projects.set(project.id, project);

      const boardsRoot = join(projectsRoot, projectId, 'boards');
      for (const boardId of listDirs(boardsRoot)) {
        const board = readJson<Board>(join(boardsRoot, boardId, 'board.json'));
        if (!board) continue;
        snapshot.boards.set(board.id, board);

        const ids: string[] = [];
        const cardsRoot = join(boardsRoot, boardId, 'cards');
        for (const file of listFiles(cardsRoot, '.json')) {
          const card = readJson<Card>(join(cardsRoot, file));
          if (!card) continue;
          snapshot.cards.set(card.id, card);
          ids.push(card.id);
        }
        ids.sort((a, b) => {
          const left = snapshot.cards.get(a)!;
          const right = snapshot.cards.get(b)!;
          return left.position - right.position || left.id.localeCompare(right.id);
        });
        snapshot.cardsByBoard.set(board.id, ids);
      }
    }

    this.#snapshot = snapshot;
    this.#loaded = true;
  }

  /* ------------------------------------------------------------------ locking */

  /**
   * Runs `body` with the workspace lock held, then stamps `state.json` so other
   * processes reload. A lock left behind by a process that died is broken after
   * 30 seconds, or immediately if its pid is gone.
   */
  mutate<T>(body: (snapshot: StoreSnapshot) => T): T {
    this.#acquireLock();
    try {
      const snapshot = this.snapshot();
      const result = body(snapshot);
      snapshot.revision += 1;
      this.#writeState(snapshot.revision, snapshot.seq);
      return result;
    } finally {
      this.#releaseLock();
    }
  }

  #acquireLock(): void {
    const lockPath = join(this.root, LOCK_DIR);
    const deadline = Date.now() + LOCK_TIMEOUT_MS;

    for (;;) {
      try {
        mkdirSync(lockPath);
        writeFileSync(
          join(lockPath, 'owner.json'),
          JSON.stringify({ pid: process.pid, at: new Date().toISOString() })
        );
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (this.#breakStaleLock(lockPath)) continue;
        if (Date.now() > deadline) {
          throw new TrellaError(
            'service_unavailable',
            `Another Trella process is holding the board lock at ${lockPath}. ` +
              `If nothing is running, delete that directory and try again.`
          );
        }
        sleep(15);
      }
    }
  }

  #breakStaleLock(lockPath: string): boolean {
    try {
      const owner = JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8')) as {
        pid: number;
        at: string;
      };
      const age = Date.now() - new Date(owner.at).getTime();
      const dead = !isProcessAlive(owner.pid);
      if (dead || age > LOCK_STALE_MS) {
        rmSync(lockPath, { recursive: true, force: true });
        return true;
      }
      return false;
    } catch {
      // No owner file, or unreadable: treat an old directory as abandoned.
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          rmSync(lockPath, { recursive: true, force: true });
          return true;
        }
      } catch {
        return false;
      }
      return false;
    }
  }

  #releaseLock(): void {
    rmSync(join(this.root, LOCK_DIR), { recursive: true, force: true });
  }

  /* ------------------------------------------------------------------ writes */

  saveProject(project: Project): void {
    const dir = this.#projectDir(project.id);
    mkdirSync(join(dir, 'boards'), { recursive: true });
    writeAtomic(join(dir, 'project.json'), pretty(project));
    this.#snapshot.projects.set(project.id, project);
  }

  saveBoard(board: Board): void {
    const dir = this.#boardDir(board);
    mkdirSync(join(dir, 'cards'), { recursive: true });
    writeAtomic(join(dir, 'board.json'), pretty(board));
    this.#snapshot.boards.set(board.id, board);
    if (!this.#snapshot.cardsByBoard.has(board.id)) this.#snapshot.cardsByBoard.set(board.id, []);
  }

  saveCard(card: Card): void {
    const board = this.#snapshot.boards.get(card.boardId);
    if (!board) throw new TrellaError('not_found', `No board with id "${card.boardId}".`);
    mkdirSync(join(this.#boardDir(board), 'cards'), { recursive: true });
    writeAtomic(this.#cardPath(board, card.id), pretty(card));

    this.#snapshot.cards.set(card.id, card);
    const ids = this.#snapshot.cardsByBoard.get(card.boardId) ?? [];
    if (!ids.includes(card.id)) ids.push(card.id);
    this.#snapshot.cardsByBoard.set(card.boardId, ids);
  }

  removeCard(card: Card): void {
    const board = this.#snapshot.boards.get(card.boardId);
    if (board) rmSync(this.#cardPath(board, card.id), { force: true });
    this.#snapshot.cards.delete(card.id);
    this.#snapshot.cardsByBoard.set(
      card.boardId,
      (this.#snapshot.cardsByBoard.get(card.boardId) ?? []).filter((id) => id !== card.id)
    );
  }

  removeBoard(board: Board): void {
    rmSync(this.#boardDir(board), { recursive: true, force: true });
    for (const id of this.#snapshot.cardsByBoard.get(board.id) ?? []) this.#snapshot.cards.delete(id);
    this.#snapshot.cardsByBoard.delete(board.id);
    this.#snapshot.boards.delete(board.id);
  }

  removeProject(project: Project): void {
    for (const board of [...this.#snapshot.boards.values()]) {
      if (board.projectId === project.id) this.removeBoard(board);
    }
    rmSync(this.#projectDir(project.id), { recursive: true, force: true });
    this.#snapshot.projects.delete(project.id);
  }

  /** Appends to the board's log and returns the workspace-wide sequence number. */
  appendActivity(boardId: string, entry: Omit<ActivityEvent, 'seq'>): ActivityEvent {
    const board = this.#snapshot.boards.get(boardId);
    if (!board) throw new TrellaError('not_found', `No board with id "${boardId}".`);
    const seq = this.#snapshot.seq + 1;
    this.#snapshot.seq = seq;
    const full: ActivityEvent = { ...entry, seq };
    mkdirSync(this.#boardDir(board), { recursive: true });
    appendFileSync(join(this.#boardDir(board), 'activity.jsonl'), `${JSON.stringify(full)}\n`);
    return full;
  }

  readActivity(boardId: string): ActivityEvent[] {
    const board = this.#snapshot.boards.get(boardId);
    if (!board) return [];
    const path = join(this.#boardDir(board), 'activity.jsonl');
    if (!existsSync(path)) return [];
    const entries: ActivityEvent[] = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as ActivityEvent);
      } catch {
        // A truncated final line from a killed process; the rest of the log stands.
      }
    }
    return entries;
  }

  /** Every board's activity, oldest first. Used for the workspace-wide log. */
  readAllActivity(): ActivityEvent[] {
    const entries: ActivityEvent[] = [];
    for (const boardId of this.#snapshot.boards.keys()) entries.push(...this.readActivity(boardId));
    return entries.sort((a, b) => a.seq - b.seq);
  }
}

/* --------------------------------------------------------------------- utils */

function emptySnapshot(): StoreSnapshot {
  return {
    projects: new Map(),
    boards: new Map(),
    cards: new Map(),
    cardsByBoard: new Map(),
    seq: 0,
    revision: 0,
  };
}

function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Write to a sibling temporary file, then rename: a reader never sees a partial file. */
function writeAtomic(path: string, contents: string): void {
  const temporary = `${path}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temporary, contents);
  renameSync(temporary, path);
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function listDirs(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
}

function listFiles(path: string, extension: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => entry.name)
    .sort();
}

function sleep(ms: number): void {
  // Synchronous: the store's API is synchronous, and the wait is milliseconds.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
