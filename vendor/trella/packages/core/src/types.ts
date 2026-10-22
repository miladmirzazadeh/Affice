/** The shared vocabulary. Every channel — UI, CLI, MCP, file adapter — speaks it. */

export type ActorType = 'human' | 'agent';

/** Who is making a change. Required on every mutation; never inferred. */
export interface Actor {
  type: ActorType;
  /** Stable identity, e.g. `local-human` or `agent:claude-code`. */
  id: string;
  /** Display name shown in the UI and activity log. */
  name: string;
}

export type Priority = 'low' | 'medium' | 'high' | 'urgent';

export const PRIORITIES: readonly Priority[] = ['low', 'medium', 'high', 'urgent'];

export type ColumnColor = 'stone' | 'amber' | 'moss' | 'sky' | 'indigo' | 'plum' | 'rose';

export const COLUMN_COLORS: readonly ColumnColor[] = [
  'stone',
  'amber',
  'moss',
  'sky',
  'indigo',
  'plum',
  'rose',
];

/**
 * A project groups boards. Every workspace has a `general` project, which is
 * where a board goes when nobody said where it belongs.
 */
export interface Project {
  /** Slug, stable for the life of the project. */
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  createdBy: Actor | null;
}

export const DEFAULT_PROJECT_ID = 'general';

export interface Column {
  /** Slug used as a card's `status`, unique within its board. */
  id: string;
  name: string;
  color: ColumnColor;
  position: number;
  /** Marks a column that means "no further work": Done and Failed by default. */
  terminal: boolean;
}

/**
 * A board is the unit an agent works against. It carries its own columns, so two
 * boards in the same project can model completely different workflows.
 */
export interface Board {
  /** Stable id, e.g. `bd_7fk3n2q1`. This is what an agent holds on to. */
  id: string;
  projectId: string;
  name: string;
  /** Readable handle, unique within the project: `sprint-1`. */
  slug: string;
  description: string;
  /** Card id prefix, unique across the workspace: `SPR` gives `SPR-1`. */
  cardPrefix: string;
  columns: Column[];
  cardSeq: number;
  createdAt: string;
  updatedAt: string;
  createdBy: Actor | null;
}

export interface Card {
  id: string;
  boardId: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  /** The column this card sits in. */
  status: string;
  /** Sort key within the column. Clients read it; only the server writes it. */
  position: number;
  priority: Priority;
  labels: string[];
  assignee: Actor | null;
  creator: Actor | null;
  /** Whoever last mutated the card. Never the human unless the human did it. */
  lastActor: Actor | null;
  archived: boolean;
  /** Bumped on every successful mutation. The unit of optimistic concurrency. */
  revision: number;
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
}

export interface Comment {
  id: string;
  body: string;
  actor: Actor;
  createdAt: string;
}

/**
 * A card without its comment thread, plus the count. Lists and events carry this
 * so a board with three hundred cards does not ship every comment with it.
 */
export type CardSummary = Omit<Card, 'comments'> & { commentCount: number };

export type ActivityAction =
  | 'card.created'
  | 'card.updated'
  | 'card.moved'
  | 'card.assigned'
  | 'card.unassigned'
  | 'card.claimed'
  | 'card.archived'
  | 'card.restored'
  | 'card.commented'
  | 'board.created'
  | 'board.updated'
  | 'board.deleted'
  | 'column.added'
  | 'column.updated'
  | 'column.removed'
  | 'project.created'
  | 'project.updated';

/** One field's before/after, as recorded in the activity log. */
export interface FieldChange {
  from: unknown;
  to: unknown;
}

export interface ActivityEvent {
  id: string;
  /** Monotonic across the whole workspace; useful for replay and cursors. */
  seq: number;
  boardId: string;
  cardId: string | null;
  action: ActivityAction;
  actor: Actor;
  changes: Record<string, FieldChange>;
  createdAt: string;
}

/** Emitted after every successful mutation, once it has been written to disk. */
export interface BoardEvent {
  type: ActivityAction;
  actor: Actor;
  boardId: string;
  card?: CardSummary;
  /** Present when the mutation moved a card out of another column. */
  previousStatus?: string;
  board?: Board;
  project?: Project;
  comment?: Comment;
  /**
   * Sort keys the server rewrote as a side effect, so a client applies exactly
   * the ordering the server settled on instead of guessing.
   */
  reordered?: Array<{ id: string; position: number }>;
  activity: ActivityEvent;
  at: string;
}

/** A board with its cards: what the interface renders. */
export interface BoardSnapshot {
  project: Project;
  board: Board;
  cards: CardSummary[];
  /** Highest activity `seq` at the time of the snapshot. */
  cursor: number;
}

/** Everything the workspace holds, without the cards. Used by switchers. */
export interface WorkspaceSummary {
  projects: Project[];
  boards: Array<Board & { cardCount: number; openCount: number }>;
  defaultBoardId: string | null;
  cursor: number;
}

export interface CardFilter {
  boardId?: string;
  status?: string;
  assignee?: string;
  label?: string;
  priority?: Priority;
  /** Defaults to false: archived cards stay out of the way unless asked for. */
  archived?: boolean;
  query?: string;
  limit?: number;
}

export interface CreateCardInput {
  boardId?: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string;
  status?: string;
  priority?: Priority;
  labels?: string[];
  assignee?: Actor | null;
  /** Insertion index within the column. Appends when omitted. */
  position?: number;
}

export interface UpdateCardInput {
  title?: string;
  description?: string;
  acceptanceCriteria?: string;
  priority?: Priority;
  labels?: string[];
  assignee?: Actor | null;
}

export interface MoveCardInput {
  status: string;
  /** Target index within the destination column. Appends when omitted. */
  position?: number;
}

export interface ColumnInput {
  name: string;
  color?: ColumnColor;
  terminal?: boolean;
}

export interface CreateBoardInput {
  name: string;
  description?: string;
  projectId?: string;
  /** Custom workflow. The six defaults are used when this is omitted. */
  columns?: ColumnInput[];
  cardPrefix?: string;
}

export interface CreateProjectInput {
  name: string;
  description?: string;
}

export interface ProjectConfig {
  version: number;
  workspace: { name: string };
  /** The local human identity used by the UI. */
  identity: Actor;
  /** Where the JSON lives, relative to the project root. */
  data: string;
  server: { port: number; host: string; open: boolean };
  fileAdapter: { enabled: boolean; inbox: string; outbox: string };
}

/**
 * The starting workflow. A board can be created with any columns at all; these
 * are what you get when nobody says otherwise.
 */
export const DEFAULT_COLUMNS: ColumnInput[] = [
  { name: 'Backlog', color: 'stone' },
  { name: 'To do', color: 'amber' },
  { name: 'In progress', color: 'indigo' },
  { name: 'Review', color: 'plum' },
  { name: 'Done', color: 'moss', terminal: true },
  { name: 'Failed', color: 'rose', terminal: true },
];
