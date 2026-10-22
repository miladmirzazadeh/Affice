import { TrellaError, conflict, invalidInput, invalidStatus, notFound } from './errors.js';
import { newId, slugify } from './ids.js';
import { FileStore, type StoreSnapshot } from './store.js';
import {
  COLUMN_COLORS,
  DEFAULT_COLUMNS,
  DEFAULT_PROJECT_ID,
  PRIORITIES,
  type ActivityAction,
  type ActivityEvent,
  type Actor,
  type Board,
  type BoardEvent,
  type BoardSnapshot,
  type Card,
  type CardFilter,
  type CardSummary,
  type Column,
  type ColumnColor,
  type ColumnInput,
  type Comment,
  type CreateBoardInput,
  type CreateCardInput,
  type CreateProjectInput,
  type FieldChange,
  type MoveCardInput,
  type Priority,
  type Project,
  type UpdateCardInput,
  type WorkspaceSummary,
} from './types.js';

/** Smallest gap we will split before renormalising a column's sort keys. */
const MIN_POSITION_GAP = 1e-4;

type Listener = (event: BoardEvent) => void;

export interface BoardServiceOptions {
  /** The `.agentboard` directory that holds the JSON. */
  data: string;
  workspaceName?: string;
}

/**
 * The one place state changes. The HTTP API, the CLI, the MCP server and the
 * file adapter all call these methods; none of them reimplement a mutation, and
 * none of them write to the JSON files directly.
 */
export class BoardService {
  readonly #store: FileStore;
  readonly #listeners = new Set<Listener>();
  #workspaceName: string;

  constructor(options: BoardServiceOptions) {
    this.#store = new FileStore(options.data);
    this.#workspaceName = options.workspaceName ?? 'Trella';
    this.#bootstrap();
  }

  /* ------------------------------------------------------------- lifecycle */

  #bootstrap(): void {
    const snapshot = this.#store.snapshot();
    if (snapshot.projects.size > 0) return;

    const now = new Date().toISOString();
    this.#store.mutate(() => {
      this.#store.saveProject({
        id: DEFAULT_PROJECT_ID,
        name: 'General',
        description: 'Boards that do not belong anywhere more specific.',
        createdAt: now,
        updatedAt: now,
        createdBy: null,
      });
    });

    // A workspace with no board at all has nothing to show, so seed one.
    this.createBoard(
      { name: this.#workspaceName, projectId: DEFAULT_PROJECT_ID },
      { type: 'human', id: 'local-human', name: 'You' }
    );
  }

  close(): void {
    // Nothing to release: the store holds no handles between operations.
  }

  /** Subscribe to committed mutations. Returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(events: BoardEvent[]): void {
    for (const event of events) {
      for (const listener of this.#listeners) {
        try {
          listener(event);
        } catch {
          // A broken subscriber must never block a change that is already saved.
        }
      }
    }
  }

  get workspaceName(): string {
    return this.#workspaceName;
  }

  cursor(): number {
    return this.#store.snapshot().seq;
  }

  /* ---------------------------------------------------------------- lookup */

  listProjects(): Project[] {
    return [...this.#store.snapshot().projects.values()].sort((a, b) =>
      a.id === DEFAULT_PROJECT_ID ? -1 : b.id === DEFAULT_PROJECT_ID ? 1 : a.name.localeCompare(b.name)
    );
  }

  getProject(id: string): Project {
    const project = this.#store.snapshot().projects.get(id);
    if (!project) throw notFound('project', id);
    return project;
  }

  /** Accepts an id, a slug, or a name. Case-insensitive on names. */
  resolveProject(query: string): Project {
    const snapshot = this.#store.snapshot();
    const wanted = query.trim();
    const direct = snapshot.projects.get(wanted) ?? snapshot.projects.get(slugify(wanted));
    if (direct) return direct;

    const matches = [...snapshot.projects.values()].filter(
      (project) => project.name.toLowerCase() === wanted.toLowerCase()
    );
    if (matches.length === 1) return matches[0]!;
    throw new TrellaError(
      'not_found',
      `No project called "${query}". Available: ${this.listProjects().map((p) => p.id).join(', ')}.`,
      { details: { query, available: this.listProjects().map((p) => p.id) } }
    );
  }

  listBoards(projectId?: string): Board[] {
    const snapshot = this.#store.snapshot();
    // Creation order, not alphabetical: the board a caller gets when it names
    // none has to stay the same one after somebody adds "Alpha".
    return [...snapshot.boards.values()]
      .filter((board) => !projectId || board.projectId === projectId)
      .sort((a, b) => a.projectId.localeCompare(b.projectId) || a.createdAt.localeCompare(b.createdAt));
  }

  getBoard(id: string): Board {
    const board = this.#store.snapshot().boards.get(id);
    if (!board) throw notFound('board', id);
    return board;
  }

  /**
   * Finds the board an agent means. Accepts the board id, `project/slug`, a
   * slug, or a name. Ambiguity is an error that lists the candidates rather than
   * a guess, because guessing here puts work on the wrong board.
   */
  resolveBoard(query: string, projectHint?: string): Board {
    const snapshot = this.#store.snapshot();
    const wanted = query.trim();
    const direct = snapshot.boards.get(wanted);
    if (direct) return direct;

    let candidates = [...snapshot.boards.values()];
    let scoped = wanted;

    if (wanted.includes('/')) {
      const [projectPart, ...rest] = wanted.split('/');
      const project = this.resolveProject(projectPart!);
      candidates = candidates.filter((board) => board.projectId === project.id);
      scoped = rest.join('/');
    } else if (projectHint) {
      const project = this.resolveProject(projectHint);
      candidates = candidates.filter((board) => board.projectId === project.id);
    }

    const needle = scoped.toLowerCase();
    const matches = candidates.filter(
      (board) =>
        board.id.toLowerCase() === needle ||
        board.slug.toLowerCase() === needle ||
        board.name.toLowerCase() === needle
    );
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      throw new TrellaError(
        'invalid_input',
        `"${query}" matches more than one board: ${matches.map((b) => `${b.id} (${b.projectId}/${b.slug})`).join(', ')}. Use the board id.`,
        { details: { query, matches: matches.map((b) => b.id) } }
      );
    }

    throw new TrellaError(
      'not_found',
      `No board called "${query}". Available: ${this.listBoards()
        .map((board) => `${board.id} (${board.projectId}/${board.slug})`)
        .join(', ')}.`,
      { details: { query, available: this.listBoards().map((board) => board.id) } }
    );
  }

  /** The board a caller gets when it does not name one. */
  defaultBoard(): Board {
    const boards = this.listBoards();
    const general = boards.filter((board) => board.projectId === DEFAULT_PROJECT_ID);
    const board = general[0] ?? boards[0];
    if (!board) throw new TrellaError('not_found', 'This workspace has no boards yet.');
    return board;
  }

  #boardOr(boardId: string | undefined): Board {
    return boardId ? this.resolveBoard(boardId) : this.defaultBoard();
  }

  workspace(): WorkspaceSummary {
    const snapshot = this.#store.snapshot();
    return {
      projects: this.listProjects(),
      boards: this.listBoards().map((board) => {
        const cards = (snapshot.cardsByBoard.get(board.id) ?? []).map((id) => snapshot.cards.get(id)!);
        const terminal = new Set(board.columns.filter((c) => c.terminal).map((c) => c.id));
        return {
          ...board,
          cardCount: cards.filter((card) => !card.archived).length,
          openCount: cards.filter((card) => !card.archived && !terminal.has(card.status)).length,
        };
      }),
      defaultBoardId: this.listBoards()[0]?.id ?? null,
      cursor: snapshot.seq,
    };
  }

  boardSnapshot(boardId?: string, options: { includeArchived?: boolean } = {}): BoardSnapshot {
    const board = this.#boardOr(boardId);
    return {
      project: this.getProject(board.projectId),
      board,
      cards: this.listCards({
        boardId: board.id,
        archived: options.includeArchived ? undefined : false,
      }),
      cursor: this.cursor(),
    };
  }

  /* ---------------------------------------------------------------- reading */

  listCards(filter: CardFilter = {}): CardSummary[] {
    const snapshot = this.#store.snapshot();
    const boardId = filter.boardId ? this.resolveBoard(filter.boardId).id : undefined;

    let cards = boardId
      ? (snapshot.cardsByBoard.get(boardId) ?? []).map((id) => snapshot.cards.get(id)!)
      : [...snapshot.cards.values()];

    if (filter.archived === true) cards = cards.filter((card) => card.archived);
    else if (filter.archived !== undefined || filter.archived === undefined) {
      if (filter.archived !== undefined) cards = cards.filter((card) => card.archived === filter.archived);
      else cards = cards.filter((card) => !card.archived);
    }

    if (filter.status) {
      const board = boardId ? this.getBoard(boardId) : null;
      if (board && !board.columns.some((column) => column.id === filter.status)) {
        throw invalidStatus(filter.status, board.columns.map((column) => column.id));
      }
      cards = cards.filter((card) => card.status === filter.status);
    }
    if (filter.assignee) cards = cards.filter((card) => card.assignee?.id === filter.assignee);
    if (filter.priority) cards = cards.filter((card) => card.priority === filter.priority);
    if (filter.label) {
      const needle = filter.label.toLowerCase();
      cards = cards.filter((card) => card.labels.some((label) => label.toLowerCase() === needle));
    }
    if (filter.query) {
      const needle = filter.query.toLowerCase();
      cards = cards.filter(
        (card) =>
          card.title.toLowerCase().includes(needle) ||
          card.description.toLowerCase().includes(needle)
      );
    }

    cards = cards.sort(
      (a, b) => a.boardId.localeCompare(b.boardId) || a.status.localeCompare(b.status) || a.position - b.position
    );
    if (filter.limit && Number.isFinite(filter.limit)) {
      cards = cards.slice(0, Math.max(1, Math.floor(filter.limit)));
    }
    return cards.map(summarize);
  }

  getCard(id: string): Card {
    const card = this.#store.snapshot().cards.get(id.trim().toUpperCase());
    if (!card) throw notFound('card', id);
    return card;
  }

  listComments(cardId: string): Comment[] {
    return this.getCard(cardId).comments;
  }

  getActivity(
    options: { cardId?: string; boardId?: string; limit?: number } = {}
  ): ActivityEvent[] {
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 2000);
    let entries: ActivityEvent[];

    if (options.cardId) {
      const card = this.getCard(options.cardId);
      entries = this.#store.readActivity(card.boardId).filter((entry) => entry.cardId === card.id);
    } else if (options.boardId) {
      entries = this.#store.readActivity(this.resolveBoard(options.boardId).id);
    } else {
      entries = this.#store.readAllActivity();
    }
    return entries.slice(-limit);
  }

  /** Activity newer than `cursor`, oldest first. Used to resume a dropped stream. */
  activitySince(cursor: number, limit = 500): ActivityEvent[] {
    return this.#store
      .readAllActivity()
      .filter((entry) => entry.seq > cursor)
      .slice(0, limit);
  }

  /* --------------------------------------------------------------- projects */

  createProject(input: CreateProjectInput, actor: Actor): Project {
    const author = requireActor(actor);
    const name = requireText(input.name, 'project name', 60);
    const description = optionalText(input.description, 'description', 2000);

    const { project, events } = this.#store.mutate((snapshot) => {
      const id = uniqueSlug(slugify(name), (candidate) => snapshot.projects.has(candidate));
      const now = new Date().toISOString();
      const created: Project = {
        id,
        name,
        description,
        createdAt: now,
        updatedAt: now,
        createdBy: author,
      };
      this.#store.saveProject(created);
      return { project: created, events: [] as BoardEvent[] };
    });

    this.#emit(events);
    return project;
  }

  updateProject(id: string, patch: { name?: string; description?: string }, actor: Actor): Project {
    requireActor(actor);
    return this.#store.mutate(() => {
      const before = this.getProject(this.resolveProject(id).id);
      const updated: Project = {
        ...before,
        name: patch.name === undefined ? before.name : requireText(patch.name, 'project name', 60),
        description:
          patch.description === undefined
            ? before.description
            : optionalText(patch.description, 'description', 2000),
        updatedAt: new Date().toISOString(),
      };
      this.#store.saveProject(updated);
      return updated;
    });
  }

  /* ----------------------------------------------------------------- boards */

  createBoard(input: CreateBoardInput, actor: Actor): Board {
    const author = requireActor(actor);
    const name = requireText(input.name, 'board name', 60);
    const description = optionalText(input.description, 'description', 2000);
    const columns = (input.columns && input.columns.length ? input.columns : DEFAULT_COLUMNS).map(
      (column, index) => normalizeColumnInput(column, index)
    );
    if (columns.length === 0) throw invalidInput('A board needs at least one column.');
    if (columns.length > 20) throw invalidInput('Use 20 columns or fewer on one board.');

    const { board, events } = this.#store.mutate((snapshot) => {
      const projectId = input.projectId
        ? this.resolveProject(input.projectId).id
        : DEFAULT_PROJECT_ID;
      if (!snapshot.projects.has(projectId)) throw notFound('project', projectId);

      const siblings = [...snapshot.boards.values()].filter((b) => b.projectId === projectId);
      const slug = uniqueSlug(slugify(name), (candidate) =>
        siblings.some((b) => b.slug === candidate)
      );
      const prefix = uniquePrefix(input.cardPrefix ?? name, (candidate) =>
        [...snapshot.boards.values()].some((b) => b.cardPrefix === candidate)
      );

      const now = new Date().toISOString();
      const created: Board = {
        id: newId('bd'),
        projectId,
        name,
        slug,
        description,
        cardPrefix: prefix,
        columns: assignColumnIds(columns),
        cardSeq: 0,
        createdAt: now,
        updatedAt: now,
        createdBy: author,
      };
      this.#store.saveBoard(created);

      const activity = this.#store.appendActivity(created.id, {
        id: newId('act'),
        boardId: created.id,
        cardId: null,
        action: 'board.created',
        actor: author,
        changes: {
          name: { from: null, to: name },
          columns: { from: null, to: created.columns.map((column) => column.name) },
        },
        createdAt: now,
      });

      return {
        board: created,
        events: [
          {
            type: 'board.created' as ActivityAction,
            actor: author,
            boardId: created.id,
            board: created,
            project: snapshot.projects.get(projectId),
            activity,
            at: now,
          },
        ],
      };
    });

    this.#emit(events);
    return board;
  }

  updateBoard(
    id: string,
    patch: { name?: string; description?: string },
    actor: Actor
  ): Board {
    const author = requireActor(actor);

    const { board, events } = this.#store.mutate(() => {
      const before = this.resolveBoard(id);
      const changes: Record<string, FieldChange> = {};
      const name = patch.name === undefined ? before.name : requireText(patch.name, 'board name', 60);
      const description =
        patch.description === undefined
          ? before.description
          : optionalText(patch.description, 'description', 2000);

      if (name !== before.name) changes.name = { from: before.name, to: name };
      if (description !== before.description) {
        changes.description = { from: before.description, to: description };
      }
      if (Object.keys(changes).length === 0) return { board: before, events: [] as BoardEvent[] };

      const now = new Date().toISOString();
      const updated: Board = { ...before, name, description, updatedAt: now };
      this.#store.saveBoard(updated);
      const activity = this.#store.appendActivity(updated.id, {
        id: newId('act'),
        boardId: updated.id,
        cardId: null,
        action: 'board.updated',
        actor: author,
        changes,
        createdAt: now,
      });

      return {
        board: updated,
        events: [
          {
            type: 'board.updated' as ActivityAction,
            actor: author,
            boardId: updated.id,
            board: updated,
            activity,
            at: now,
          },
        ],
      };
    });

    this.#emit(events);
    return board;
  }

  deleteBoard(id: string, actor: Actor): { id: string } {
    const author = requireActor(actor);

    const { removed, events } = this.#store.mutate((snapshot) => {
      const board = this.resolveBoard(id);
      if (snapshot.boards.size === 1) {
        throw invalidInput('This is the only board in the workspace; create another one first.');
      }
      const now = new Date().toISOString();
      const activity = this.#store.appendActivity(board.id, {
        id: newId('act'),
        boardId: board.id,
        cardId: null,
        action: 'board.deleted',
        actor: author,
        changes: { name: { from: board.name, to: null } },
        createdAt: now,
      });
      const event: BoardEvent = {
        type: 'board.deleted',
        actor: author,
        boardId: board.id,
        board,
        activity,
        at: now,
      };
      this.#store.removeBoard(board);
      return { removed: { id: board.id }, events: [event] };
    });

    this.#emit(events);
    return removed;
  }

  /* ---------------------------------------------------------------- columns */

  addColumn(
    boardId: string,
    input: ColumnInput & { position?: number },
    actor: Actor
  ): Board {
    const author = requireActor(actor);

    const { board, events } = this.#store.mutate(() => {
      const before = this.resolveBoard(boardId);
      if (before.columns.length >= 20) {
        throw invalidInput('Use 20 columns or fewer on one board.');
      }
      const normalized = normalizeColumnInput(input, before.columns.length);
      const id = uniqueSlug(slugify(normalized.name), (candidate) =>
        before.columns.some((column) => column.id === candidate)
      );

      const columns = [...before.columns];
      const at =
        input.position === undefined
          ? columns.length
          : Math.max(0, Math.min(Math.floor(input.position), columns.length));
      columns.splice(at, 0, {
        id,
        name: normalized.name,
        color: normalized.color,
        terminal: normalized.terminal,
        position: 0,
      });

      const now = new Date().toISOString();
      const updated: Board = { ...before, columns: renumber(columns), updatedAt: now };
      this.#store.saveBoard(updated);
      const activity = this.#store.appendActivity(updated.id, {
        id: newId('act'),
        boardId: updated.id,
        cardId: null,
        action: 'column.added',
        actor: author,
        changes: { column: { from: null, to: normalized.name } },
        createdAt: now,
      });

      return {
        board: updated,
        events: [
          {
            type: 'column.added' as ActivityAction,
            actor: author,
            boardId: updated.id,
            board: updated,
            activity,
            at: now,
          },
        ],
      };
    });

    this.#emit(events);
    return board;
  }

  updateColumn(
    boardId: string,
    columnId: string,
    patch: { name?: string; color?: ColumnColor; terminal?: boolean; position?: number },
    actor: Actor
  ): Board {
    const author = requireActor(actor);

    const { board, events } = this.#store.mutate(() => {
      const before = this.resolveBoard(boardId);
      const existing = before.columns.find((column) => column.id === columnId);
      if (!existing) throw invalidStatus(columnId, before.columns.map((column) => column.id));

      const changes: Record<string, FieldChange> = {};
      const next: Column = { ...existing };
      if (patch.name !== undefined) {
        next.name = requireText(patch.name, 'column name', 40);
        if (next.name !== existing.name) changes.name = { from: existing.name, to: next.name };
      }
      if (patch.color !== undefined) {
        next.color = requireColumnColor(patch.color);
        if (next.color !== existing.color) changes.color = { from: existing.color, to: next.color };
      }
      if (patch.terminal !== undefined) {
        next.terminal = Boolean(patch.terminal);
        if (next.terminal !== existing.terminal) {
          changes.terminal = { from: existing.terminal, to: next.terminal };
        }
      }

      let columns = before.columns.map((column) => (column.id === columnId ? next : column));
      if (patch.position !== undefined) {
        const from = columns.findIndex((column) => column.id === columnId);
        const to = Math.max(0, Math.min(Math.floor(patch.position), columns.length - 1));
        if (from !== to) {
          const [moved] = columns.splice(from, 1);
          columns.splice(to, 0, moved!);
          changes.position = { from, to };
        }
      }
      if (Object.keys(changes).length === 0) return { board: before, events: [] as BoardEvent[] };

      const now = new Date().toISOString();
      columns = renumber(columns);
      const updated: Board = { ...before, columns, updatedAt: now };
      this.#store.saveBoard(updated);
      const activity = this.#store.appendActivity(updated.id, {
        id: newId('act'),
        boardId: updated.id,
        cardId: null,
        action: 'column.updated',
        actor: author,
        changes,
        createdAt: now,
      });

      return {
        board: updated,
        events: [
          {
            type: 'column.updated' as ActivityAction,
            actor: author,
            boardId: updated.id,
            board: updated,
            activity,
            at: now,
          },
        ],
      };
    });

    this.#emit(events);
    return board;
  }

  /**
   * Removes a column and moves whatever was in it somewhere else. Cards are
   * never deleted as a side effect of a layout change.
   */
  removeColumn(
    boardId: string,
    columnId: string,
    actor: Actor,
    options: { moveCardsTo?: string } = {}
  ): Board {
    const author = requireActor(actor);

    const { board, events } = this.#store.mutate((snapshot) => {
      const before = this.resolveBoard(boardId);
      const column = before.columns.find((entry) => entry.id === columnId);
      if (!column) throw invalidStatus(columnId, before.columns.map((entry) => entry.id));
      if (before.columns.length === 1) {
        throw invalidInput('A board needs at least one column, so this one cannot be removed.');
      }

      const remaining = before.columns.filter((entry) => entry.id !== columnId);
      const destination = options.moveCardsTo
        ? remaining.find((entry) => entry.id === options.moveCardsTo)
        : remaining[0];
      if (!destination) {
        throw invalidStatus(options.moveCardsTo ?? '', remaining.map((entry) => entry.id));
      }

      const now = new Date().toISOString();
      const stranded = (snapshot.cardsByBoard.get(before.id) ?? [])
        .map((id) => snapshot.cards.get(id)!)
        .filter((card) => card.status === columnId);

      let nextPosition =
        Math.max(
          0,
          ...(snapshot.cardsByBoard.get(before.id) ?? [])
            .map((id) => snapshot.cards.get(id)!)
            .filter((card) => card.status === destination.id)
            .map((card) => card.position)
        ) + 1000;

      const moved: CardSummary[] = [];
      for (const card of stranded) {
        const updatedCard: Card = {
          ...card,
          status: destination.id,
          position: nextPosition,
          revision: card.revision + 1,
          updatedAt: now,
          lastActor: author,
        };
        nextPosition += 1000;
        this.#store.saveCard(updatedCard);
        moved.push(summarize(updatedCard));
      }

      const updated: Board = { ...before, columns: renumber(remaining), updatedAt: now };
      this.#store.saveBoard(updated);
      const activity = this.#store.appendActivity(updated.id, {
        id: newId('act'),
        boardId: updated.id,
        cardId: null,
        action: 'column.removed',
        actor: author,
        changes: {
          column: { from: column.name, to: null },
          movedCards: { from: stranded.length, to: destination.name },
        },
        createdAt: now,
      });

      const events: BoardEvent[] = [
        {
          type: 'column.removed',
          actor: author,
          boardId: updated.id,
          board: updated,
          activity,
          at: now,
        },
        ...moved.map<BoardEvent>((card) => ({
          type: 'card.moved',
          actor: author,
          boardId: updated.id,
          card,
          previousStatus: columnId,
          activity,
          at: now,
        })),
      ];
      return { board: updated, events };
    });

    this.#emit(events);
    return board;
  }

  /* ------------------------------------------------------------------ cards */

  createCard(input: CreateCardInput, actor: Actor): CardSummary {
    const author = requireActor(actor);
    const title = requireText(input.title, 'title', 200);
    const description = optionalText(input.description, 'description', 20_000);
    const acceptanceCriteria = optionalText(input.acceptanceCriteria, 'acceptance criteria', 20_000);
    const priority = requirePriority(input.priority ?? 'medium');
    const labels = requireLabels(input.labels ?? []);
    const assignee = input.assignee == null ? null : requireActor(input.assignee);

    const { card, events } = this.#store.mutate(() => {
      const board = this.#boardOr(input.boardId);
      const status = input.status
        ? requireColumn(board, input.status).id
        : board.columns[0]!.id;

      const sequence = board.cardSeq + 1;
      const id = `${board.cardPrefix}-${sequence}`;
      const now = new Date().toISOString();
      const { position, reordered } = this.#allocatePosition(board.id, status, input.position, null);

      const created: Card = {
        id,
        boardId: board.id,
        title,
        description,
        acceptanceCriteria,
        status,
        position,
        priority,
        labels,
        assignee,
        creator: author,
        lastActor: author,
        archived: false,
        revision: 1,
        comments: [],
        createdAt: now,
        updatedAt: now,
      };
      this.#store.saveCard(created);
      this.#store.saveBoard({ ...board, cardSeq: sequence, updatedAt: now });

      const activity = this.#store.appendActivity(board.id, {
        id: newId('act'),
        boardId: board.id,
        cardId: id,
        action: 'card.created',
        actor: author,
        changes: { title: { from: null, to: title }, status: { from: null, to: status } },
        createdAt: now,
      });

      const summary = summarize(created);
      return {
        card: summary,
        events: [
          {
            type: 'card.created' as ActivityAction,
            actor: author,
            boardId: board.id,
            card: summary,
            activity,
            at: now,
            ...(reordered.length ? { reordered } : {}),
          },
        ],
      };
    });

    this.#emit(events);
    return card;
  }

  updateCard(
    id: string,
    input: UpdateCardInput,
    actor: Actor,
    expectedRevision?: number
  ): CardSummary {
    const author = requireActor(actor);

    const { card, events } = this.#store.mutate(() => {
      const before = this.#lockCard(id, expectedRevision);
      const changes: Record<string, FieldChange> = {};
      const next: Card = { ...before };

      if (input.title !== undefined) {
        const title = requireText(input.title, 'title', 200);
        if (title !== before.title) {
          changes.title = { from: before.title, to: title };
          next.title = title;
        }
      }
      if (input.description !== undefined) {
        const description = optionalText(input.description, 'description', 20_000);
        if (description !== before.description) {
          changes.description = { from: before.description, to: description };
          next.description = description;
        }
      }
      if (input.acceptanceCriteria !== undefined) {
        const value = optionalText(input.acceptanceCriteria, 'acceptance criteria', 20_000);
        if (value !== before.acceptanceCriteria) {
          changes.acceptanceCriteria = { from: before.acceptanceCriteria, to: value };
          next.acceptanceCriteria = value;
        }
      }
      if (input.priority !== undefined) {
        const priority = requirePriority(input.priority);
        if (priority !== before.priority) {
          changes.priority = { from: before.priority, to: priority };
          next.priority = priority;
        }
      }
      if (input.labels !== undefined) {
        const labels = requireLabels(input.labels);
        if (JSON.stringify(labels) !== JSON.stringify(before.labels)) {
          changes.labels = { from: before.labels, to: labels };
          next.labels = labels;
        }
      }
      if (input.assignee !== undefined) {
        const assignee = input.assignee === null ? null : requireActor(input.assignee);
        if ((assignee?.id ?? null) !== (before.assignee?.id ?? null)) {
          changes.assignee = { from: before.assignee, to: assignee };
          next.assignee = assignee;
        }
      }

      if (Object.keys(changes).length === 0) {
        return { card: summarize(before), events: [] as BoardEvent[] };
      }

      const now = new Date().toISOString();
      next.revision = before.revision + 1;
      next.updatedAt = now;
      next.lastActor = author;
      this.#store.saveCard(next);

      const action: ActivityAction = changes.assignee
        ? changes.assignee.to
          ? 'card.assigned'
          : 'card.unassigned'
        : 'card.updated';
      const activity = this.#store.appendActivity(next.boardId, {
        id: newId('act'),
        boardId: next.boardId,
        cardId: next.id,
        action,
        actor: author,
        changes,
        createdAt: now,
      });

      const summary = summarize(next);
      return {
        card: summary,
        events: [{ type: action, actor: author, boardId: next.boardId, card: summary, activity, at: now }],
      };
    });

    this.#emit(events);
    return card;
  }

  moveCard(
    id: string,
    input: MoveCardInput,
    actor: Actor,
    expectedRevision?: number
  ): CardSummary {
    const author = requireActor(actor);

    const { card, events } = this.#store.mutate(() => {
      const before = this.#lockCard(id, expectedRevision);
      const board = this.getBoard(before.boardId);
      const target = requireColumn(board, input.status);
      const { position, reordered } = this.#allocatePosition(
        board.id,
        target.id,
        input.position,
        before.id
      );

      const unchanged =
        before.status === target.id &&
        Math.abs(before.position - position) < Number.EPSILON &&
        reordered.length === 0;
      if (unchanged) return { card: summarize(before), events: [] as BoardEvent[] };

      const now = new Date().toISOString();
      const next: Card = {
        ...before,
        status: target.id,
        position,
        revision: before.revision + 1,
        updatedAt: now,
        lastActor: author,
      };
      this.#store.saveCard(next);

      const changes: Record<string, FieldChange> = {};
      if (before.status !== target.id) changes.status = { from: before.status, to: target.id };
      changes.position = { from: before.position, to: position };

      const activity = this.#store.appendActivity(board.id, {
        id: newId('act'),
        boardId: board.id,
        cardId: next.id,
        action: 'card.moved',
        actor: author,
        changes,
        createdAt: now,
      });

      const summary = summarize(next);
      return {
        card: summary,
        events: [
          {
            type: 'card.moved' as ActivityAction,
            actor: author,
            boardId: board.id,
            card: summary,
            previousStatus: before.status,
            activity,
            at: now,
            ...(reordered.length ? { reordered } : {}),
          },
        ],
      };
    });

    this.#emit(events);
    return card;
  }

  /** Assigns the card to the calling agent (or person) and records the claim. */
  claimCard(id: string, actor: Actor, expectedRevision?: number): CardSummary {
    const claimant = requireActor(actor);

    const { card, events } = this.#store.mutate(() => {
      const before = this.#lockCard(id, expectedRevision);
      if (before.assignee && before.assignee.id !== claimant.id) {
        throw new TrellaError(
          'conflict',
          `Card ${before.id} is already claimed by ${before.assignee.name}. ` +
            `Unassign it first if the handoff is intentional.`,
          { details: { cardId: before.id, assignee: before.assignee, current: summarize(before) } }
        );
      }
      if (before.assignee && before.assignee.id === claimant.id) {
        return { card: summarize(before), events: [] as BoardEvent[] };
      }

      const now = new Date().toISOString();
      const next: Card = {
        ...before,
        assignee: claimant,
        revision: before.revision + 1,
        updatedAt: now,
        lastActor: claimant,
      };
      this.#store.saveCard(next);

      const activity = this.#store.appendActivity(next.boardId, {
        id: newId('act'),
        boardId: next.boardId,
        cardId: next.id,
        action: 'card.claimed',
        actor: claimant,
        changes: { assignee: { from: before.assignee, to: claimant } },
        createdAt: now,
      });

      const summary = summarize(next);
      return {
        card: summary,
        events: [
          { type: 'card.claimed' as ActivityAction, actor: claimant, boardId: next.boardId, card: summary, activity, at: now },
        ],
      };
    });

    this.#emit(events);
    return card;
  }

  setArchived(
    id: string,
    archived: boolean,
    actor: Actor,
    expectedRevision?: number
  ): CardSummary {
    const author = requireActor(actor);

    const { card, events } = this.#store.mutate(() => {
      const before = this.#lockCard(id, expectedRevision);
      if (before.archived === archived) return { card: summarize(before), events: [] as BoardEvent[] };

      const now = new Date().toISOString();
      const next: Card = {
        ...before,
        archived,
        revision: before.revision + 1,
        updatedAt: now,
        lastActor: author,
      };
      this.#store.saveCard(next);

      const action: ActivityAction = archived ? 'card.archived' : 'card.restored';
      const activity = this.#store.appendActivity(next.boardId, {
        id: newId('act'),
        boardId: next.boardId,
        cardId: next.id,
        action,
        actor: author,
        changes: { archived: { from: before.archived, to: archived } },
        createdAt: now,
      });

      const summary = summarize(next);
      return {
        card: summary,
        events: [{ type: action, actor: author, boardId: next.boardId, card: summary, activity, at: now }],
      };
    });

    this.#emit(events);
    return card;
  }

  addComment(id: string, body: string, actor: Actor): Comment {
    const author = requireActor(actor);
    const text = requireText(body, 'comment', 10_000);

    const { comment, events } = this.#store.mutate(() => {
      const before = this.getCard(id);
      const now = new Date().toISOString();
      const created: Comment = { id: newId('cmt'), body: text, actor: author, createdAt: now };

      // A comment touches the card's activity and last actor, but does not bump
      // its revision: an in-flight text edit should not be invalidated by a note.
      const next: Card = {
        ...before,
        comments: [...before.comments, created],
        updatedAt: now,
        lastActor: author,
      };
      this.#store.saveCard(next);

      const activity = this.#store.appendActivity(next.boardId, {
        id: newId('act'),
        boardId: next.boardId,
        cardId: next.id,
        action: 'card.commented',
        actor: author,
        changes: { comment: { from: null, to: text.slice(0, 280) } },
        createdAt: now,
      });

      return {
        comment: created,
        events: [
          {
            type: 'card.commented' as ActivityAction,
            actor: author,
            boardId: next.boardId,
            card: summarize(next),
            comment: created,
            activity,
            at: now,
          },
        ],
      };
    });

    this.#emit(events);
    return comment;
  }

  /* --------------------------------------------------------------- helpers */

  #lockCard(id: string, expectedRevision?: number): Card {
    const card = this.getCard(id);
    if (expectedRevision !== undefined && expectedRevision !== null) {
      if (!Number.isInteger(expectedRevision)) {
        throw invalidInput('expectedRevision must be an integer.', { expectedRevision });
      }
      if (card.revision !== expectedRevision) throw conflict(summarize(card), expectedRevision);
    }
    return card;
  }

  /**
   * Works out the sort key for a card landing at `index` in a column, ignoring
   * the card being moved. Splits the gap between neighbours; renumbers the whole
   * column only when floating point runs out of room, and reports which other
   * cards moved so clients can apply the same result.
   */
  #allocatePosition(
    boardId: string,
    status: string,
    index: number | undefined,
    movingCardId: string | null
  ): { position: number; reordered: Array<{ id: string; position: number }> } {
    const snapshot = this.#store.snapshot();
    const siblings = (snapshot.cardsByBoard.get(boardId) ?? [])
      .map((id) => snapshot.cards.get(id)!)
      .filter((card) => card.status === status && card.id !== movingCardId)
      .sort((a, b) => a.position - b.position);

    if (index === undefined || index === null) {
      const last = siblings[siblings.length - 1];
      return { position: last ? last.position + 1000 : 1000, reordered: [] };
    }
    if (!Number.isInteger(index) || index < 0) {
      throw invalidInput('position must be a non-negative integer index.', { position: index });
    }

    const target = Math.min(index, siblings.length);
    const before = target > 0 ? siblings[target - 1]! : null;
    const after = target < siblings.length ? siblings[target]! : null;

    if (!before && !after) return { position: 1000, reordered: [] };
    if (!before) return { position: after!.position - 1000, reordered: [] };
    if (!after) return { position: before.position + 1000, reordered: [] };

    const gap = after.position - before.position;
    if (gap > MIN_POSITION_GAP) return { position: before.position + gap / 2, reordered: [] };

    const reordered: Array<{ id: string; position: number }> = [];
    siblings.forEach((card, i) => {
      const slot = i >= target ? i + 1 : i;
      const position = (slot + 1) * 1000;
      if (position !== card.position) {
        this.#store.saveCard({ ...card, position });
        reordered.push({ id: card.id, position });
      }
    });
    return { position: (target + 1) * 1000, reordered };
  }
}

/* ---------------------------------------------------------------- mapping */

function summarize(card: Card): CardSummary {
  const { comments, ...rest } = card;
  return { ...rest, commentCount: comments.length };
}

function renumber(columns: Column[]): Column[] {
  return columns.map((column, index) => ({ ...column, position: (index + 1) * 1000 }));
}

function assignColumnIds(columns: Array<Required<ColumnInput>>): Column[] {
  const used = new Set<string>();
  return columns.map((column, index) => {
    const id = uniqueSlug(slugify(column.name), (candidate) => used.has(candidate));
    used.add(id);
    return {
      id,
      name: column.name,
      color: column.color,
      terminal: column.terminal,
      position: (index + 1) * 1000,
    };
  });
}

function normalizeColumnInput(input: ColumnInput, index: number): Required<ColumnInput> {
  const fallback = COLUMN_COLORS[index % COLUMN_COLORS.length]!;
  return {
    name: requireText(input.name, 'column name', 40),
    color: input.color === undefined ? fallback : requireColumnColor(input.color),
    terminal: Boolean(input.terminal),
  };
}

function requireColumn(board: Board, status: string): Column {
  const column = board.columns.find((entry) => entry.id === status || entry.name === status);
  if (!column) throw invalidStatus(status, board.columns.map((entry) => entry.id));
  return column;
}

function uniqueSlug(base: string, taken: (candidate: string) => boolean): string {
  if (!taken(base)) return base;
  for (let i = 2; i < 500; i += 1) {
    const candidate = `${base}-${i}`;
    if (!taken(candidate)) return candidate;
  }
  return `${base}-${newId('x').slice(2, 8)}`;
}

/** `Sprint one` -> `SPR`, made unique across the workspace. */
function uniquePrefix(source: string, taken: (candidate: string) => boolean): string {
  const letters = source.toUpperCase().replace(/[^A-Z]/g, '');
  const base = (letters.slice(0, 3) || 'BRD').padEnd(3, 'X');
  if (!taken(base)) return base;
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${base}${i}`;
    if (!taken(candidate)) return candidate;
  }
  return `${base}${Date.now().toString(36).toUpperCase().slice(-3)}`;
}

/* ------------------------------------------------------------- validation */

function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw invalidInput(`${field} must be text.`, { field });
  const trimmed = value.trim();
  if (!trimmed) throw invalidInput(`Add a ${field}; it cannot be empty.`, { field });
  if (trimmed.length > max) {
    throw invalidInput(`Shorten the ${field} to ${max} characters or fewer.`, {
      field,
      max,
      length: trimmed.length,
    });
  }
  return trimmed;
}

function optionalText(value: unknown, field: string, max: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw invalidInput(`${field} must be text.`, { field });
  if (value.length > max) {
    throw invalidInput(`Shorten the ${field} to ${max} characters or fewer.`, {
      field,
      max,
      length: value.length,
    });
  }
  return value;
}

function requirePriority(value: unknown): Priority {
  if (typeof value === 'string' && (PRIORITIES as readonly string[]).includes(value)) {
    return value as Priority;
  }
  throw invalidInput(`Use one of: ${PRIORITIES.join(', ')}.`, { field: 'priority', value });
}

function requireColumnColor(value: unknown): ColumnColor {
  if (typeof value === 'string' && (COLUMN_COLORS as readonly string[]).includes(value)) {
    return value as ColumnColor;
  }
  throw invalidInput(`Use one of: ${COLUMN_COLORS.join(', ')}.`, { field: 'color', value });
}

function requireLabels(value: unknown): string[] {
  if (!Array.isArray(value)) throw invalidInput('labels must be an array of text.', { field: 'labels' });
  if (value.length > 12) throw invalidInput('Use 12 labels or fewer on one card.', { field: 'labels' });
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw invalidInput('Each label must be text.', { field: 'labels', value: entry });
    }
    const label = entry.trim();
    if (!label) continue;
    if (label.length > 32) {
      throw invalidInput('Shorten each label to 32 characters or fewer.', {
        field: 'labels',
        value: label,
      });
    }
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push(label);
  }
  return labels;
}

export function requireActor(value: unknown): Actor {
  if (!value || typeof value !== 'object') {
    throw invalidInput('An actor is required: { type, id, name }.', { field: 'actor' });
  }
  const actor = value as Partial<Actor>;
  if (actor.type !== 'human' && actor.type !== 'agent') {
    throw invalidInput('actor.type must be "human" or "agent".', { field: 'actor.type' });
  }
  const id = requireText(actor.id, 'actor id', 64);
  const name = requireText(actor.name ?? actor.id, 'actor name', 64);
  return { type: actor.type, id, name };
}
