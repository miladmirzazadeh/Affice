import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import { ApiError, api, type Config } from './api';
import { readAddress } from './address';
import type {
  Actor,
  Board,
  BoardEvent,
  BoardSnapshot,
  Card,
  ColumnColor,
  Priority,
  Project,
  WorkspaceSummary,
} from './types';

export type Connection = 'connecting' | 'live' | 'offline';

const LAST_BOARD_KEY = 'trella:board';

interface State {
  phase: 'loading' | 'ready' | 'error';
  error: string | null;
  connection: Connection;
  workspaceName: string;
  identity: Actor | null;
  projects: Project[];
  boards: WorkspaceSummary['boards'];
  /** The board on screen. Everything below belongs to it. */
  board: Board | null;
  project: Project | null;
  cards: Record<string, Card>;
  cursor: number;
  /** Cards changed by another actor while on screen, with the time it happened. */
  touched: Record<string, number>;
  /** Cards with an in-flight optimistic change. */
  pending: Record<string, true>;
}

const initialState: State = {
  phase: 'loading',
  error: null,
  connection: 'connecting',
  workspaceName: 'Trella',
  identity: null,
  projects: [],
  boards: [],
  board: null,
  project: null,
  cards: {},
  cursor: 0,
  touched: {},
  pending: {},
};

type Action =
  | { type: 'loaded'; snapshot: BoardSnapshot; workspace: WorkspaceSummary; config: Config }
  | { type: 'load-failed'; message: string }
  | { type: 'board'; snapshot: BoardSnapshot; workspace: WorkspaceSummary }
  | { type: 'workspace'; workspace: WorkspaceSummary }
  | { type: 'connection'; connection: Connection }
  | { type: 'remote'; event: BoardEvent }
  | { type: 'apply'; cards: Card[] }
  | { type: 'positions'; entries: Array<{ id: string; position: number }> }
  | { type: 'set-board'; board: Board }
  | { type: 'pending'; id: string; value: boolean }
  | { type: 'untouch'; id: string };

function indexCards(cards: Card[]): Record<string, Card> {
  const map: Record<string, Card> = {};
  for (const card of cards) map[card.id] = card;
  return map;
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'loaded':
      return {
        ...state,
        phase: 'ready',
        error: null,
        workspaceName: action.config.workspace.name,
        identity: action.config.identity,
        projects: action.workspace.projects,
        boards: action.workspace.boards,
        board: action.snapshot.board,
        project: action.snapshot.project,
        cards: indexCards(action.snapshot.cards),
        cursor: action.snapshot.cursor,
        touched: {},
      };
    case 'load-failed':
      return { ...state, phase: 'error', error: action.message };
    case 'board':
      return {
        ...state,
        phase: 'ready',
        error: null,
        projects: action.workspace.projects,
        boards: action.workspace.boards,
        board: action.snapshot.board,
        project: action.snapshot.project,
        cards: indexCards(action.snapshot.cards),
        cursor: action.snapshot.cursor,
        touched: {},
      };
    case 'workspace':
      return { ...state, projects: action.workspace.projects, boards: action.workspace.boards };
    case 'connection':
      return { ...state, connection: action.connection };
    case 'set-board':
      return {
        ...state,
        board: action.board,
        boards: state.boards.map((board) =>
          board.id === action.board.id ? { ...board, ...action.board } : board
        ),
      };
    case 'remote': {
      const { event } = action;
      // Events arrive for the whole workspace; only the open board matters here.
      if (state.board && event.boardId !== state.board.id) {
        return { ...state, cursor: Math.max(state.cursor, event.activity?.seq ?? state.cursor) };
      }

      const cards = { ...state.cards };
      const touched = { ...state.touched };
      const mine = event.actor.id === state.identity?.id;

      if (event.card) {
        if (event.card.archived) delete cards[event.card.id];
        else cards[event.card.id] = event.card;
        if (!mine) touched[event.card.id] = Date.now();
      }
      for (const entry of event.reordered ?? []) {
        const existing = cards[entry.id];
        if (existing) cards[entry.id] = { ...existing, position: entry.position };
      }

      return {
        ...state,
        cards,
        board: event.board && event.board.id === state.board?.id ? event.board : state.board,
        touched,
        cursor: Math.max(state.cursor, event.activity?.seq ?? state.cursor),
      };
    }
    case 'apply': {
      const cards = { ...state.cards };
      for (const card of action.cards) {
        if (card.boardId !== state.board?.id) continue;
        if (card.archived) delete cards[card.id];
        else cards[card.id] = card;
      }
      return { ...state, cards };
    }
    case 'positions': {
      const cards = { ...state.cards };
      for (const entry of action.entries) {
        const existing = cards[entry.id];
        if (existing) cards[entry.id] = { ...existing, position: entry.position };
      }
      return { ...state, cards };
    }
    case 'pending': {
      const pending = { ...state.pending };
      if (action.value) pending[action.id] = true;
      else delete pending[action.id];
      return { ...state, pending };
    }
    case 'untouch': {
      if (!(action.id in state.touched)) return state;
      const touched = { ...state.touched };
      delete touched[action.id];
      return { ...state, touched };
    }
    default:
      return state;
  }
}

export interface BoardApi {
  state: State;
  /** Cards grouped by column and sorted, recomputed only when cards change. */
  byColumn: Record<string, Card[]>;
  reload: () => Promise<void>;
  openBoard: (boardId: string) => Promise<void>;
  createProject: (input: { name: string; description?: string }) => Promise<Project>;
  createBoard: (input: {
    name: string;
    description?: string;
    projectId?: string;
    columns?: Array<{ name: string; color?: ColumnColor; terminal?: boolean }>;
  }) => Promise<Board>;
  updateBoard: (patch: { name?: string; description?: string }) => Promise<void>;
  deleteBoard: (boardId: string) => Promise<void>;
  addColumn: (input: { name: string; color?: ColumnColor; position?: number }) => Promise<void>;
  updateColumn: (
    columnId: string,
    patch: { name?: string; color?: ColumnColor; terminal?: boolean; position?: number }
  ) => Promise<void>;
  removeColumn: (columnId: string, moveCardsTo?: string) => Promise<void>;
  createCard: (input: {
    title: string;
    status?: string;
    priority?: Priority;
    labels?: string[];
    position?: number;
  }) => Promise<Card>;
  updateCard: (
    id: string,
    patch: Parameters<typeof api.updateCard>[1],
    expectedRevision?: number
  ) => Promise<Card>;
  moveCard: (id: string, status: string, index: number) => Promise<void>;
  claimCard: (id: string) => Promise<Card>;
  setArchived: (id: string, archived: boolean) => Promise<Card>;
  addComment: (id: string, body: string) => Promise<void>;
  announce: (message: string) => void;
  announcement: string;
  toast: (message: string, tone?: 'info' | 'error') => void;
  toasts: Array<{ id: number; message: string; tone: 'info' | 'error' }>;
  dismissToast: (id: number) => void;
}

const BoardContext = createContext<BoardApi | null>(null);

/**
 * Places a card at `index` in `column` on the client, using the same midpoint
 * rule the server uses. The server's reply is still authoritative; this only
 * keeps the drag from snapping back for one frame.
 */
function positionFor(cards: Card[], index: number, movingId: string): number {
  const siblings = cards
    .filter((card) => card.id !== movingId)
    .sort((a, b) => a.position - b.position);
  const target = Math.max(0, Math.min(index, siblings.length));
  const before = target > 0 ? siblings[target - 1] : undefined;
  const after = target < siblings.length ? siblings[target] : undefined;
  if (!before && !after) return 1000;
  if (!before) return after!.position - 1000;
  if (!after) return before.position + 1000;
  return before.position + (after.position - before.position) / 2;
}

/**
 * The board the address names, when the service knows it. The service resolves
 * the reference exactly as it does for agents (an id, a slug or `project/slug`),
 * so the page does not repeat those rules. A card key alone also works: keys are
 * unique across the workspace, so the card says which board it is on. Anything
 * unknown is ignored and the caller falls back to its usual choice.
 */
async function boardFromAddress(): Promise<BoardSnapshot | null> {
  const { board, card } = readAddress();
  if (board) {
    const snapshot = await api.board(board).catch(() => null);
    if (snapshot) return snapshot;
  }
  if (card) {
    const found = await api.card(card).catch(() => null);
    if (found) return api.board(found.card.boardId).catch(() => null);
  }
  return null;
}

export function BoardProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [announcement, setAnnouncement] = useReducer((_: string, next: string) => next, '');
  const [toasts, toastDispatch] = useReducer(
    (
      current: BoardApi['toasts'],
      action:
        | { type: 'add'; message: string; tone: 'info' | 'error' }
        | { type: 'remove'; id: number }
    ) =>
      action.type === 'add'
        ? [...current, { id: Date.now() + Math.random(), message: action.message, tone: action.tone }]
        : current.filter((entry) => entry.id !== action.id),
    []
  );

  const cursorRef = useRef(0);
  cursorRef.current = state.cursor;
  const boardIdRef = useRef<string | null>(null);
  boardIdRef.current = state.board?.id ?? null;

  const load = useCallback(async (boardId?: string) => {
    try {
      const [workspace, config] = await Promise.all([api.workspace(), api.config()]);
      // The address picks the first board only; a reload keeps the board on screen.
      let snapshot = boardId ? null : await boardFromAddress();
      if (!snapshot) {
        const wanted = boardId ?? localStorage.getItem(LAST_BOARD_KEY) ?? undefined;
        // A remembered board that has since been deleted must not wedge the app.
        const exists = wanted && workspace.boards.some((board) => board.id === wanted);
        snapshot = await api.board(exists ? wanted : undefined);
      }
      localStorage.setItem(LAST_BOARD_KEY, snapshot.board.id);
      dispatch({ type: 'loaded', snapshot, workspace, config });
    } catch (error) {
      dispatch({
        type: 'load-failed',
        message:
          error instanceof ApiError && error.code === 'service_unavailable'
            ? 'Not connected to the local Trella service.'
            : error instanceof Error
              ? error.message
              : 'Unable to load the board.',
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Live updates. On reconnect the current cursor goes with the request, so the
  // server can tell us whether we fell behind.
  useEffect(() => {
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let attempt = 0;

    const connect = () => {
      if (closed) return;
      dispatch({ type: 'connection', connection: 'connecting' });
      source = new EventSource(`/api/events?cursor=${cursorRef.current}`);

      source.addEventListener('ready', () => {
        attempt = 0;
        dispatch({ type: 'connection', connection: 'live' });
      });

      source.addEventListener('resync', () => {
        attempt = 0;
        dispatch({ type: 'connection', connection: 'live' });
        void load(boardIdRef.current ?? undefined);
      });

      for (const type of [
        'card.created',
        'card.updated',
        'card.moved',
        'card.assigned',
        'card.unassigned',
        'card.claimed',
        'card.archived',
        'card.restored',
        'card.commented',
        'board.created',
        'board.updated',
        'board.deleted',
        'column.added',
        'column.updated',
        'column.removed',
        'project.created',
        'project.updated',
      ]) {
        source.addEventListener(type, (message) => {
          const event = JSON.parse((message as MessageEvent).data) as BoardEvent;
          dispatch({ type: 'remote', event });
          // A board or project appearing, changing or going away changes the
          // switcher, which the card stream cannot express.
          if (type.startsWith('board.') || type.startsWith('project.')) {
            void api.workspace().then((workspace) => dispatch({ type: 'workspace', workspace }));
          }
        });
      }

      source.onerror = () => {
        source?.close();
        source = null;
        if (closed) return;
        dispatch({ type: 'connection', connection: 'offline' });
        attempt += 1;
        retry = setTimeout(connect, Math.min(1000 * 2 ** (attempt - 1), 10_000));
      };
    };

    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      source?.close();
    };
  }, [load]);

  // Clear the "someone else changed this" edge once its animation has run.
  useEffect(() => {
    const ids = Object.keys(state.touched);
    if (ids.length === 0) return;
    const timers = ids.map((id) => setTimeout(() => dispatch({ type: 'untouch', id }), 1400));
    return () => timers.forEach(clearTimeout);
  }, [state.touched]);

  const byColumn = useMemo(() => {
    const grouped: Record<string, Card[]> = {};
    for (const column of state.board?.columns ?? []) grouped[column.id] = [];
    for (const card of Object.values(state.cards)) (grouped[card.status] ??= []).push(card);
    for (const list of Object.values(grouped)) list.sort((a, b) => a.position - b.position);
    return grouped;
  }, [state.cards, state.board]);

  const toast = useCallback((message: string, tone: 'info' | 'error' = 'info') => {
    toastDispatch({ type: 'add', message, tone });
  }, []);

  const value = useMemo<BoardApi>(() => {
    const describe = (error: unknown) =>
      error instanceof ApiError ? error.message : 'Something went wrong. Try again.';
    const boardId = () => state.board?.id ?? '';
    const refreshWorkspace = async () => {
      const workspace = await api.workspace();
      dispatch({ type: 'workspace', workspace });
    };

    // Declared as a local, not reached through `this`. Callers destructure these
    // methods off the object, which detaches them from their receiver, so `this`
    // is undefined by the time one runs.
    const openBoard = async (id: string) => {
      localStorage.setItem(LAST_BOARD_KEY, id);
      const [snapshot, workspace] = await Promise.all([api.board(id), api.workspace()]);
      dispatch({ type: 'board', snapshot, workspace });
    };

    return {
      state,
      byColumn,
      announcement,
      toasts,
      announce: setAnnouncement,
      toast,
      dismissToast: (id) => toastDispatch({ type: 'remove', id }),
      reload: () => load(state.board?.id),

      openBoard,

      async createProject(input) {
        const { project } = await api.createProject(input);
        await refreshWorkspace();
        return project;
      },

      async createBoard(input) {
        const { board } = await api.createBoard(input);
        await openBoard(board.id);
        return board;
      },

      async updateBoard(patch) {
        const { board } = await api.updateBoard(boardId(), patch);
        dispatch({ type: 'set-board', board });
      },

      async deleteBoard(id) {
        await api.deleteBoard(id);
        const workspace = await api.workspace();
        dispatch({ type: 'workspace', workspace });
        if (id === state.board?.id) {
          const next = workspace.boards[0];
          if (next) await openBoard(next.id);
        }
      },

      async addColumn(input) {
        const { board } = await api.addColumn(boardId(), input);
        dispatch({ type: 'set-board', board });
      },

      async updateColumn(columnId, patch) {
        const { board } = await api.updateColumn(boardId(), columnId, patch);
        dispatch({ type: 'set-board', board });
      },

      async removeColumn(columnId, moveCardsTo) {
        const { board } = await api.removeColumn(boardId(), columnId, moveCardsTo);
        dispatch({ type: 'set-board', board });
        await load(board.id);
      },

      async createCard(input) {
        const { card } = await api.createCard({ ...input, boardId: boardId() });
        dispatch({ type: 'apply', cards: [card] });
        return card;
      },

      async updateCard(id, patch, expectedRevision) {
        const { card } = await api.updateCard(id, patch, expectedRevision);
        dispatch({ type: 'apply', cards: [card] });
        return card;
      },

      async moveCard(id, status, index) {
        const card = state.cards[id];
        if (!card) return;
        const destination = byColumn[status] ?? [];
        const optimistic: Card = { ...card, status, position: positionFor(destination, index, id) };

        dispatch({ type: 'apply', cards: [optimistic] });
        dispatch({ type: 'pending', id, value: true });
        try {
          const { card: settled } = await api.moveCard(id, status, index, card.revision);
          dispatch({ type: 'apply', cards: [settled] });
        } catch (error) {
          dispatch({ type: 'apply', cards: [card] });
          if (error instanceof ApiError && error.isConflict && error.body.current) {
            dispatch({ type: 'apply', cards: [error.body.current] });
            toast(`${card.id} moved somewhere else first — showing the current position.`, 'error');
          } else {
            toast(describe(error), 'error');
          }
        } finally {
          dispatch({ type: 'pending', id, value: false });
        }
      },

      async claimCard(id) {
        const { card } = await api.claimCard(id, state.cards[id]?.revision);
        dispatch({ type: 'apply', cards: [card] });
        return card;
      },

      async setArchived(id, archived) {
        const { card } = await api.setArchived(id, archived, state.cards[id]?.revision);
        dispatch({ type: 'apply', cards: [card] });
        return card;
      },

      async addComment(id, body) {
        const { card } = await api.addComment(id, body);
        const { comments, ...rest } = card;
        dispatch({ type: 'apply', cards: [{ ...rest, commentCount: comments.length }] });
      },
    };
  }, [state, byColumn, announcement, toasts, load, toast]);

  return <BoardContext.Provider value={value}>{children}</BoardContext.Provider>;
}

export function useBoard(): BoardApi {
  const value = useContext(BoardContext);
  if (!value) throw new Error('useBoard must be used inside a BoardProvider.');
  return value;
}
