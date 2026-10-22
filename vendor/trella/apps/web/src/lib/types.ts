/**
 * The wire shapes served by the local Trella service.
 *
 * Declared here rather than imported from `@trella/core` so the browser bundle
 * never pulls in Node-only code. The API tests in `packages/server` are what keep
 * the two in step.
 */

export type ActorType = 'human' | 'agent';

export interface Actor {
  type: ActorType;
  id: string;
  name: string;
}

export type Priority = 'low' | 'medium' | 'high' | 'urgent';

export const PRIORITIES: Priority[] = ['low', 'medium', 'high', 'urgent'];

export type ColumnColor = 'stone' | 'amber' | 'moss' | 'sky' | 'indigo' | 'plum' | 'rose';

export const COLUMN_COLORS: ColumnColor[] = [
  'stone',
  'amber',
  'moss',
  'sky',
  'indigo',
  'plum',
  'rose',
];

export interface Project {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  createdBy: Actor | null;
}

export interface Column {
  id: string;
  name: string;
  color: ColumnColor;
  position: number;
  terminal: boolean;
}

export interface Board {
  id: string;
  projectId: string;
  name: string;
  slug: string;
  description: string;
  cardPrefix: string;
  columns: Column[];
  cardSeq: number;
  createdAt: string;
  updatedAt: string;
  createdBy: Actor | null;
}

export type BoardWithCounts = Board & { cardCount: number; openCount: number };

export interface Comment {
  id: string;
  body: string;
  actor: Actor;
  createdAt: string;
}

/** What lists and events carry: a card without its comment thread. */
export interface Card {
  id: string;
  boardId: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  status: string;
  position: number;
  priority: Priority;
  labels: string[];
  assignee: Actor | null;
  creator: Actor | null;
  lastActor: Actor | null;
  archived: boolean;
  revision: number;
  commentCount: number;
  createdAt: string;
  updatedAt: string;
}

/** What `GET /api/cards/:id` returns: the whole card, comments included. */
export type CardDetail = Omit<Card, 'commentCount'> & { comments: Comment[] };

export interface FieldChange {
  from: unknown;
  to: unknown;
}

export interface ActivityEvent {
  id: string;
  seq: number;
  boardId: string;
  cardId: string | null;
  action: string;
  actor: Actor;
  changes: Record<string, FieldChange>;
  createdAt: string;
}

export interface BoardSnapshot {
  project: Project;
  board: Board;
  cards: Card[];
  cursor: number;
}

export interface WorkspaceSummary {
  projects: Project[];
  boards: BoardWithCounts[];
  defaultBoardId: string | null;
  cursor: number;
}

export interface BoardEvent {
  type: string;
  actor: Actor;
  boardId: string;
  card?: Card;
  previousStatus?: string;
  board?: Board;
  project?: Project;
  comment?: Comment;
  reordered?: Array<{ id: string; position: number }>;
  activity: ActivityEvent;
  at: string;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  current?: Card;
  currentRevision?: number;
  expectedRevision?: number;
  available?: string[];
}
