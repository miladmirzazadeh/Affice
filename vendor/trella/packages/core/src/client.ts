import { BoardService } from './service.js';
import { TrellaError } from './errors.js';
import { dataPath, readRuntime, requireWorkspace, type Workspace } from './workspace.js';
import type {
  Actor,
  ActivityEvent,
  Board,
  BoardSnapshot,
  Card,
  CardFilter,
  CardSummary,
  ColumnColor,
  ColumnInput,
  Comment,
  CreateBoardInput,
  CreateProjectInput,
  Project,
  WorkspaceSummary,
} from './types.js';

/**
 * One interface, two transports.
 *
 * When the local service is running, every command goes through it so the open
 * board sees the change immediately. When it is not, the same domain service is
 * opened directly against the JSON files — same validation, same activity log,
 * no second implementation of any mutation.
 */
export interface BoardClient {
  readonly mode: 'service' | 'local';
  readonly url: string | null;

  workspace(): Promise<WorkspaceSummary>;
  board(boardId?: string): Promise<BoardSnapshot>;
  createProject(input: CreateProjectInput, actor: Actor): Promise<Project>;
  createBoard(input: CreateBoardInput, actor: Actor): Promise<Board>;
  updateBoard(
    boardId: string,
    patch: { name?: string; description?: string },
    actor: Actor
  ): Promise<Board>;
  deleteBoard(boardId: string, actor: Actor): Promise<{ id: string }>;
  addColumn(
    boardId: string,
    input: ColumnInput & { position?: number },
    actor: Actor
  ): Promise<Board>;
  updateColumn(
    boardId: string,
    columnId: string,
    patch: { name?: string; color?: ColumnColor; terminal?: boolean; position?: number },
    actor: Actor
  ): Promise<Board>;
  removeColumn(
    boardId: string,
    columnId: string,
    actor: Actor,
    options?: { moveCardsTo?: string }
  ): Promise<Board>;

  listCards(filter: CardFilter): Promise<CardSummary[]>;
  getCard(id: string): Promise<{ card: Card; activity: ActivityEvent[] }>;
  createCard(input: Record<string, unknown>, actor: Actor): Promise<CardSummary>;
  updateCard(
    id: string,
    patch: Record<string, unknown>,
    actor: Actor,
    expectedRevision?: number
  ): Promise<CardSummary>;
  moveCard(
    id: string,
    status: string,
    position: number | undefined,
    actor: Actor,
    expectedRevision?: number
  ): Promise<CardSummary>;
  claimCard(id: string, actor: Actor, expectedRevision?: number): Promise<CardSummary>;
  setArchived(
    id: string,
    archived: boolean,
    actor: Actor,
    expectedRevision?: number
  ): Promise<CardSummary>;
  addComment(id: string, body: string, actor: Actor): Promise<Comment>;
  getActivity(options: {
    cardId?: string;
    boardId?: string;
    limit?: number;
  }): Promise<ActivityEvent[]>;
  close(): void;
}

export function openClient(cwd = process.cwd()): { client: BoardClient; workspace: Workspace } {
  const workspace = requireWorkspace(cwd);
  const override = process.env.TRELLA_URL;
  const runtime = override ? { url: override.replace(/\/$/, '') } : readRuntime(workspace);
  const client = runtime ? new HttpClient(runtime.url) : new LocalClient(workspace);
  return { client, workspace };
}

/**
 * The actor as an HTTP header value. Header values are Latin-1, so a name in
 * another script would make `fetch` throw. JSON `\u` escapes keep the header ASCII
 * and the service's `JSON.parse` restores the name.
 */
function actorHeader(actor: Actor): string {
  return JSON.stringify(actor).replace(
    /[\u0080-\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}

class HttpClient implements BoardClient {
  readonly mode = 'service' as const;
  constructor(readonly url: string) {}

  async #call<T>(path: string, init: RequestInit & { actor?: Actor } = {}): Promise<T> {
    const { actor, ...rest } = init;
    let response: Response;
    try {
      response = await fetch(`${this.url}${path}`, {
        ...rest,
        headers: {
          'content-type': 'application/json',
          ...(actor ? { 'x-trella-actor': actorHeader(actor) } : {}),
          ...(rest.headers ?? {}),
        },
      });
    } catch (cause) {
      throw new TrellaError(
        'service_unavailable',
        `Cannot reach the Trella service at ${this.url}. Start it with \`trella start\`.`,
        { cause }
      );
    }

    const text = await response.text();
    const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!response.ok) {
      const error = (payload.error ?? {}) as { code?: string; message?: string } & Record<
        string,
        unknown
      >;
      throw new TrellaError(
        (error.code as TrellaError['code']) ?? 'invalid_input',
        error.message ?? `Request failed with ${response.status}.`,
        { status: response.status, details: error }
      );
    }
    return payload as T;
  }

  workspace() {
    return this.#call<WorkspaceSummary>('/api/workspace');
  }

  board(boardId?: string) {
    const suffix = boardId ? `?board=${encodeURIComponent(boardId)}` : '';
    return this.#call<BoardSnapshot>(`/api/board${suffix}`);
  }

  async createProject(input: CreateProjectInput, actor: Actor) {
    return (
      await this.#call<{ project: Project }>('/api/projects', {
        method: 'POST',
        body: JSON.stringify(input),
        actor,
      })
    ).project;
  }

  async createBoard(input: CreateBoardInput, actor: Actor) {
    return (
      await this.#call<{ board: Board }>('/api/boards', {
        method: 'POST',
        body: JSON.stringify(input),
        actor,
      })
    ).board;
  }

  async updateBoard(boardId: string, patch: { name?: string; description?: string }, actor: Actor) {
    return (
      await this.#call<{ board: Board }>(`/api/boards/${encodeURIComponent(boardId)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
        actor,
      })
    ).board;
  }

  deleteBoard(boardId: string, actor: Actor) {
    return this.#call<{ id: string }>(`/api/boards/${encodeURIComponent(boardId)}/delete`, {
      method: 'POST',
      body: '{}',
      actor,
    });
  }

  async addColumn(boardId: string, input: ColumnInput & { position?: number }, actor: Actor) {
    return (
      await this.#call<{ board: Board }>(`/api/boards/${encodeURIComponent(boardId)}/columns`, {
        method: 'POST',
        body: JSON.stringify(input),
        actor,
      })
    ).board;
  }

  async updateColumn(
    boardId: string,
    columnId: string,
    patch: { name?: string; color?: ColumnColor; terminal?: boolean; position?: number },
    actor: Actor
  ) {
    return (
      await this.#call<{ board: Board }>(
        `/api/boards/${encodeURIComponent(boardId)}/columns/${encodeURIComponent(columnId)}`,
        { method: 'PATCH', body: JSON.stringify(patch), actor }
      )
    ).board;
  }

  async removeColumn(
    boardId: string,
    columnId: string,
    actor: Actor,
    options: { moveCardsTo?: string } = {}
  ) {
    return (
      await this.#call<{ board: Board }>(
        `/api/boards/${encodeURIComponent(boardId)}/columns/${encodeURIComponent(columnId)}/delete`,
        { method: 'POST', body: JSON.stringify(options), actor }
      )
    ).board;
  }

  async listCards(filter: CardFilter) {
    const query = new URLSearchParams();
    if (filter.boardId) query.set('board', filter.boardId);
    if (filter.status) query.set('status', filter.status);
    if (filter.assignee) query.set('assignee', filter.assignee);
    if (filter.label) query.set('label', filter.label);
    if (filter.priority) query.set('priority', filter.priority);
    if (filter.query) query.set('q', filter.query);
    if (filter.limit) query.set('limit', String(filter.limit));
    if (filter.archived === true) query.set('archived', 'true');
    else if (filter.archived === undefined) query.set('archived', 'all');
    const suffix = query.toString() ? `?${query}` : '';
    return (await this.#call<{ cards: CardSummary[] }>(`/api/cards${suffix}`)).cards;
  }

  getCard(id: string) {
    return this.#call<{ card: Card; activity: ActivityEvent[] }>(
      `/api/cards/${encodeURIComponent(id)}`
    );
  }

  async createCard(input: Record<string, unknown>, actor: Actor) {
    return (
      await this.#call<{ card: CardSummary }>('/api/cards', {
        method: 'POST',
        body: JSON.stringify(input),
        actor,
      })
    ).card;
  }

  async updateCard(
    id: string,
    patch: Record<string, unknown>,
    actor: Actor,
    expectedRevision?: number
  ) {
    return (
      await this.#call<{ card: CardSummary }>(`/api/cards/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ ...patch, expectedRevision }),
        actor,
      })
    ).card;
  }

  async moveCard(
    id: string,
    status: string,
    position: number | undefined,
    actor: Actor,
    expectedRevision?: number
  ) {
    return (
      await this.#call<{ card: CardSummary }>(`/api/cards/${encodeURIComponent(id)}/move`, {
        method: 'POST',
        body: JSON.stringify({ status, position, expectedRevision }),
        actor,
      })
    ).card;
  }

  async claimCard(id: string, actor: Actor, expectedRevision?: number) {
    return (
      await this.#call<{ card: CardSummary }>(`/api/cards/${encodeURIComponent(id)}/claim`, {
        method: 'POST',
        body: JSON.stringify({ expectedRevision }),
        actor,
      })
    ).card;
  }

  async setArchived(id: string, archived: boolean, actor: Actor, expectedRevision?: number) {
    return (
      await this.#call<{ card: CardSummary }>(`/api/cards/${encodeURIComponent(id)}/archive`, {
        method: 'POST',
        body: JSON.stringify({ archived, expectedRevision }),
        actor,
      })
    ).card;
  }

  async addComment(id: string, body: string, actor: Actor) {
    return (
      await this.#call<{ comment: Comment }>(`/api/cards/${encodeURIComponent(id)}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body }),
        actor,
      })
    ).comment;
  }

  async getActivity(options: { cardId?: string; boardId?: string; limit?: number }) {
    const query = new URLSearchParams();
    if (options.boardId) query.set('board', options.boardId);
    if (options.limit) query.set('limit', String(options.limit));
    const path = options.cardId
      ? `/api/cards/${encodeURIComponent(options.cardId)}/activity?${query}`
      : `/api/activity?${query}`;
    return (await this.#call<{ activity: ActivityEvent[] }>(path)).activity;
  }

  close(): void {}
}

class LocalClient implements BoardClient {
  readonly mode = 'local' as const;
  readonly url = null;
  readonly #board: BoardService;

  constructor(workspace: Workspace) {
    this.#board = new BoardService({
      data: dataPath(workspace),
      workspaceName: workspace.config.workspace.name,
    });
  }

  async workspace() {
    return this.#board.workspace();
  }
  async board(boardId?: string) {
    return this.#board.boardSnapshot(boardId);
  }
  async createProject(input: CreateProjectInput, actor: Actor) {
    return this.#board.createProject(input, actor);
  }
  async createBoard(input: CreateBoardInput, actor: Actor) {
    return this.#board.createBoard(input, actor);
  }
  async updateBoard(boardId: string, patch: { name?: string; description?: string }, actor: Actor) {
    return this.#board.updateBoard(boardId, patch, actor);
  }
  async deleteBoard(boardId: string, actor: Actor) {
    return this.#board.deleteBoard(boardId, actor);
  }
  async addColumn(boardId: string, input: ColumnInput & { position?: number }, actor: Actor) {
    return this.#board.addColumn(boardId, input, actor);
  }
  async updateColumn(
    boardId: string,
    columnId: string,
    patch: { name?: string; color?: ColumnColor; terminal?: boolean; position?: number },
    actor: Actor
  ) {
    return this.#board.updateColumn(boardId, columnId, patch, actor);
  }
  async removeColumn(
    boardId: string,
    columnId: string,
    actor: Actor,
    options: { moveCardsTo?: string } = {}
  ) {
    return this.#board.removeColumn(boardId, columnId, actor, options);
  }
  async listCards(filter: CardFilter) {
    return this.#board.listCards(filter);
  }
  async getCard(id: string) {
    return { card: this.#board.getCard(id), activity: this.#board.getActivity({ cardId: id }) };
  }
  async createCard(input: Record<string, unknown>, actor: Actor) {
    return this.#board.createCard(input as never, actor);
  }
  async updateCard(
    id: string,
    patch: Record<string, unknown>,
    actor: Actor,
    expectedRevision?: number
  ) {
    return this.#board.updateCard(id, patch as never, actor, expectedRevision);
  }
  async moveCard(
    id: string,
    status: string,
    position: number | undefined,
    actor: Actor,
    expectedRevision?: number
  ) {
    return this.#board.moveCard(id, { status, position }, actor, expectedRevision);
  }
  async claimCard(id: string, actor: Actor, expectedRevision?: number) {
    return this.#board.claimCard(id, actor, expectedRevision);
  }
  async setArchived(id: string, archived: boolean, actor: Actor, expectedRevision?: number) {
    return this.#board.setArchived(id, archived, actor, expectedRevision);
  }
  async addComment(id: string, body: string, actor: Actor) {
    return this.#board.addComment(id, body, actor);
  }
  async getActivity(options: { cardId?: string; boardId?: string; limit?: number }) {
    return this.#board.getActivity(options);
  }
  close(): void {
    this.#board.close();
  }
}
