import type {
  ActivityEvent,
  ApiErrorBody,
  Board,
  BoardSnapshot,
  Card,
  CardDetail,
  ColumnColor,
  Comment,
  Priority,
  Project,
  WorkspaceSummary,
} from './types';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly body: ApiErrorBody;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = 'ApiError';
    this.code = body.code;
    this.status = status;
    this.body = body;
  }

  get isConflict(): boolean {
    return this.code === 'conflict';
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
  } catch {
    throw new ApiError(0, {
      code: 'service_unavailable',
      message: 'Not connected to the local Trella service.',
    });
  }

  const text = await response.text();
  const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!response.ok) {
    throw new ApiError(
      response.status,
      (payload.error ?? {
        code: 'internal',
        message: `Request failed with ${response.status}.`,
      }) as ApiErrorBody
    );
  }
  return payload as T;
}

export interface Config {
  version: string;
  workspace: { name: string };
  identity: { type: 'human' | 'agent'; id: string; name: string };
  fileAdapter: { enabled: boolean; inbox: string };
}

export const api = {
  config: () => call<Config>('/api/config'),

  workspace: () => call<WorkspaceSummary>('/api/workspace'),

  board: (boardId?: string) =>
    call<BoardSnapshot>(`/api/board${boardId ? `?board=${encodeURIComponent(boardId)}` : ''}`),

  createProject: (input: { name: string; description?: string }) =>
    call<{ project: Project }>('/api/projects', { method: 'POST', body: JSON.stringify(input) }),

  createBoard: (input: {
    name: string;
    description?: string;
    projectId?: string;
    columns?: Array<{ name: string; color?: ColumnColor; terminal?: boolean }>;
  }) => call<{ board: Board }>('/api/boards', { method: 'POST', body: JSON.stringify(input) }),

  updateBoard: (boardId: string, patch: { name?: string; description?: string }) =>
    call<{ board: Board }>(`/api/boards/${encodeURIComponent(boardId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deleteBoard: (boardId: string) =>
    call<{ id: string }>(`/api/boards/${encodeURIComponent(boardId)}/delete`, {
      method: 'POST',
      body: '{}',
    }),

  addColumn: (
    boardId: string,
    input: { name: string; color?: ColumnColor; terminal?: boolean; position?: number }
  ) =>
    call<{ board: Board }>(`/api/boards/${encodeURIComponent(boardId)}/columns`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updateColumn: (
    boardId: string,
    columnId: string,
    patch: { name?: string; color?: ColumnColor; terminal?: boolean; position?: number }
  ) =>
    call<{ board: Board }>(
      `/api/boards/${encodeURIComponent(boardId)}/columns/${encodeURIComponent(columnId)}`,
      { method: 'PATCH', body: JSON.stringify(patch) }
    ),

  removeColumn: (boardId: string, columnId: string, moveCardsTo?: string) =>
    call<{ board: Board }>(
      `/api/boards/${encodeURIComponent(boardId)}/columns/${encodeURIComponent(columnId)}/delete`,
      { method: 'POST', body: JSON.stringify({ moveCardsTo }) }
    ),

  card: (id: string) =>
    call<{ card: CardDetail; activity: ActivityEvent[] }>(`/api/cards/${encodeURIComponent(id)}`),

  createCard: (input: {
    boardId?: string;
    title: string;
    status?: string;
    description?: string;
    acceptanceCriteria?: string;
    priority?: Priority;
    labels?: string[];
    position?: number;
  }) => call<{ card: Card }>('/api/cards', { method: 'POST', body: JSON.stringify(input) }),

  updateCard: (
    id: string,
    patch: Partial<{
      title: string;
      description: string;
      acceptanceCriteria: string;
      priority: Priority;
      labels: string[];
      assignee: { type: 'human' | 'agent'; id: string; name: string } | null;
    }>,
    expectedRevision?: number
  ) =>
    call<{ card: Card }>(`/api/cards/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ ...patch, expectedRevision }),
    }),

  moveCard: (id: string, status: string, position?: number, expectedRevision?: number) =>
    call<{ card: Card }>(`/api/cards/${encodeURIComponent(id)}/move`, {
      method: 'POST',
      body: JSON.stringify({ status, position, expectedRevision }),
    }),

  claimCard: (id: string, expectedRevision?: number) =>
    call<{ card: Card }>(`/api/cards/${encodeURIComponent(id)}/claim`, {
      method: 'POST',
      body: JSON.stringify({ expectedRevision }),
    }),

  setArchived: (id: string, archived: boolean, expectedRevision?: number) =>
    call<{ card: Card }>(`/api/cards/${encodeURIComponent(id)}/archive`, {
      method: 'POST',
      body: JSON.stringify({ archived, expectedRevision }),
    }),

  addComment: (id: string, body: string) =>
    call<{ comment: Comment; card: CardDetail }>(
      `/api/cards/${encodeURIComponent(id)}/comments`,
      { method: 'POST', body: JSON.stringify({ body }) }
    ),
};
