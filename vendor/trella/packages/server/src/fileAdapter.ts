import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isTrellaError, type Actor, type BoardService } from '@trella/core';

/**
 * The file adapter: a controlled bridge for agents that can only read and write
 * files. Drop a JSON request into the inbox, read the result from the outbox.
 * It runs through the same domain service as every other channel — direct writes
 * to the database are still not a supported route.
 */
export interface FileRequest {
  /** Correlation id echoed back in the result. Defaults to the file name. */
  id?: string;
  op: string;
  actor: Actor;
  params?: Record<string, unknown>;
}

export interface FileAdapterOptions {
  board: BoardService;
  inbox: string;
  outbox: string;
  pollMs?: number;
  onError?: (error: unknown) => void;
}

export class FileAdapter {
  readonly #board: BoardService;
  readonly #inbox: string;
  readonly #outbox: string;
  readonly #processed: string;
  readonly #onError: (error: unknown) => void;
  #watcher: ReturnType<typeof watch> | null = null;
  #timer: NodeJS.Timeout | null = null;
  #running = false;

  constructor(options: FileAdapterOptions) {
    this.#board = options.board;
    this.#inbox = options.inbox;
    this.#outbox = options.outbox;
    this.#processed = join(options.inbox, 'processed');
    this.#onError = options.onError ?? (() => {});

    mkdirSync(this.#inbox, { recursive: true });
    mkdirSync(this.#outbox, { recursive: true });
    mkdirSync(this.#processed, { recursive: true });

    // fs.watch is fast but misses events on some platforms and network shares,
    // so a slow poll backs it up.
    try {
      this.#watcher = watch(this.#inbox, { persistent: false }, () => this.drain());
    } catch {
      this.#watcher = null;
    }
    this.#timer = setInterval(() => this.drain(), options.pollMs ?? 1000);
    this.#timer.unref?.();
    this.drain();
  }

  close(): void {
    this.#watcher?.close();
    if (this.#timer) clearInterval(this.#timer);
    this.#watcher = null;
    this.#timer = null;
  }

  /** Processes every pending request file. Safe to call concurrently. */
  drain(): void {
    if (this.#running) return;
    this.#running = true;
    try {
      const entries = readdirSync(this.#inbox, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => entry.name)
        .sort();

      for (const name of entries) {
        const path = join(this.#inbox, name);
        if (!existsSync(path)) continue;
        let result: unknown;
        let ok = true;
        let request: FileRequest | null = null;
        try {
          request = JSON.parse(readFileSync(path, 'utf8')) as FileRequest;
          result = this.#apply(request);
        } catch (error) {
          ok = false;
          result = isTrellaError(error)
            ? error.toJSON().error
            : { code: 'internal', message: error instanceof Error ? error.message : String(error) };
          this.#onError(error);
        }

        const id = request?.id ?? name.replace(/\.json$/, '');
        writeFileSync(
          join(this.#outbox, `${id}.json`),
          `${JSON.stringify({ id, ok, op: request?.op ?? null, result, at: new Date().toISOString() }, null, 2)}\n`
        );
        try {
          renameSync(path, join(this.#processed, `${Date.now()}-${name}`));
        } catch {
          // Another drain already moved it.
        }
      }
    } catch (error) {
      this.#onError(error);
    } finally {
      this.#running = false;
    }
  }

  #apply(request: FileRequest): unknown {
    const params = request.params ?? {};
    const actor = request.actor;
    const cardId = () => String(params.task_id ?? params.cardId ?? params.id ?? '');
    const boardId = () => String(params.board_id ?? params.boardId ?? params.board ?? '');
    const revision = () =>
      params.expected_revision === undefined && params.expectedRevision === undefined
        ? undefined
        : Number(params.expected_revision ?? params.expectedRevision);

    switch (request.op) {
      case 'list_tasks':
        return { tasks: this.#board.listCards(params as never) };
      case 'get_task':
        return { task: this.#board.getCard(cardId()) };
      case 'create_task':
        return { task: this.#board.createCard(params as never, actor) };
      case 'update_task':
        return {
          task: this.#board.updateCard(
            cardId(),
            (params.fields ?? params) as never,
            actor,
            revision()
          ),
        };
      case 'move_task':
        return {
          task: this.#board.moveCard(
            cardId(),
            {
              status: String(params.destination_status ?? params.status ?? ''),
              position: params.position === undefined ? undefined : Number(params.position),
            },
            actor,
            revision()
          ),
        };
      case 'claim_task':
        return { task: this.#board.claimCard(cardId(), actor, revision()) };
      case 'add_comment':
        return { comment: this.#board.addComment(cardId(), String(params.body ?? ''), actor) };
      case 'get_activity':
        return { activity: this.#board.getActivity({ cardId: cardId() }) };
      case 'list_boards':
        return this.#board.workspace();
      case 'get_board':
        return { board: this.#board.boardSnapshot(boardId() || undefined) };
      case 'create_board':
        return { board: this.#board.createBoard(params as never, actor) };
      case 'create_project':
        return { project: this.#board.createProject(params as never, actor) };
      case 'add_column':
        return { board: this.#board.addColumn(boardId(), params as never, actor) };
      case 'remove_column':
        return {
          board: this.#board.removeColumn(
            boardId(),
            String(params.column_id ?? params.columnId ?? ''),
            actor,
            { moveCardsTo: (params.move_cards_to ?? params.moveCardsTo) as string | undefined }
          ),
        };
      default:
        throw new Error(
          `Unknown op "${request.op}". Supported: list_tasks, get_task, create_task, ` +
            `update_task, move_task, claim_task, add_comment, get_activity, list_boards, ` +
            `get_board, create_board, create_project, add_column, remove_column.`
        );
    }
  }
}
