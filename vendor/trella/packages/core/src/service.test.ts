import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from './service.js';
import { isTrellaError } from './errors.js';
import type { Actor, BoardEvent } from './types.js';

const human: Actor = { type: 'human', id: 'local-human', name: 'Ada' };
const agent: Actor = { type: 'agent', id: 'agent:codex', name: 'Codex' };
const reviewer: Actor = { type: 'agent', id: 'agent:reviewer', name: 'Reviewer' };

let root: string;
let board: BoardService;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'trella-core-'));
  board = new BoardService({ data: join(root, '.agentboard'), workspaceName: 'Test' });
});

afterEach(() => {
  board.close();
  rmSync(root, { recursive: true, force: true });
});

const data = () => join(root, '.agentboard');
const order = (status: string, boardId?: string) =>
  board
    .listCards({ boardId: boardId ?? board.defaultBoard().id, status })
    .sort((a, b) => a.position - b.position)
    .map((card) => card.title);

describe('workspace bootstrap', () => {
  it('creates a general project and one board with the default workflow', () => {
    expect(board.listProjects().map((project) => project.id)).toEqual(['general']);
    const first = board.defaultBoard();
    expect(first.projectId).toBe('general');
    expect(first.columns.map((column) => column.id)).toEqual([
      'backlog',
      'to-do',
      'in-progress',
      'review',
      'done',
      'failed',
    ]);
    expect(first.columns.filter((column) => column.terminal).map((column) => column.name)).toEqual([
      'Done',
      'Failed',
    ]);
  });

  it('stores everything as readable JSON on disk', () => {
    const created = board.createCard({ title: 'Readable on disk' }, human);
    const boardId = board.defaultBoard().id;

    const boardFile = join(data(), 'projects/general/boards', boardId, 'board.json');
    const cardFile = join(data(), 'projects/general/boards', boardId, 'cards', `${created.id}.json`);
    expect(existsSync(boardFile)).toBe(true);
    expect(existsSync(cardFile)).toBe(true);

    const parsed = JSON.parse(readFileSync(cardFile, 'utf8'));
    expect(parsed.title).toBe('Readable on disk');
    expect(parsed.creator.name).toBe('Ada');

    const log = readFileSync(
      join(data(), 'projects/general/boards', boardId, 'activity.jsonl'),
      'utf8'
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(log.at(-1).action).toBe('card.created');
  });

  it('reloads a change another process wrote to the same folder', () => {
    const other = new BoardService({ data: data(), workspaceName: 'Test' });
    other.createCard({ title: 'From the other process' }, agent);
    other.close();

    expect(board.listCards({}).map((card) => card.title)).toEqual(['From the other process']);
  });
});

describe('projects and boards', () => {
  it('creates a project and a board inside it', () => {
    const project = board.createProject({ name: 'Platform work' }, human);
    expect(project.id).toBe('platform-work');

    const created = board.createBoard({ name: 'Sprint 1', projectId: 'platform-work' }, human);
    expect(created.projectId).toBe('platform-work');
    expect(created.slug).toBe('sprint-1');
    expect(created.cardPrefix).toBe('SPR');
    expect(created.id).toMatch(/^bd_/);
  });

  it('puts a board in general when no project is named', () => {
    expect(board.createBoard({ name: 'Loose ends' }, agent).projectId).toBe('general');
  });

  it('accepts custom columns and remembers the ones it was given', () => {
    const created = board.createBoard(
      {
        name: 'Research',
        columns: [{ name: 'Questions' }, { name: 'Reading' }, { name: 'Answered', terminal: true }],
      },
      human
    );
    expect(created.columns.map((column) => column.id)).toEqual([
      'questions',
      'reading',
      'answered',
    ]);
    expect(created.columns.at(-1)?.terminal).toBe(true);
  });

  it('gives every board its own card prefix so ids never collide', () => {
    const a = board.createBoard({ name: 'Alpha' }, human);
    const b = board.createBoard({ name: 'Alpha' }, human);
    expect(a.cardPrefix).not.toBe(b.cardPrefix);

    const first = board.createCard({ boardId: a.id, title: 'One' }, human);
    const second = board.createCard({ boardId: b.id, title: 'One' }, human);
    expect(first.id).not.toBe(second.id);
    expect(board.getCard(first.id).boardId).toBe(a.id);
    expect(board.getCard(second.id).boardId).toBe(b.id);
  });

  it('finds a board by id, slug, name or project/slug', () => {
    const created = board.createBoard({ name: 'Sprint 1', projectId: 'general' }, human);
    expect(board.resolveBoard(created.id).id).toBe(created.id);
    expect(board.resolveBoard('sprint-1').id).toBe(created.id);
    expect(board.resolveBoard('Sprint 1').id).toBe(created.id);
    expect(board.resolveBoard('general/sprint-1').id).toBe(created.id);
  });

  it('refuses to guess between two boards with the same name', () => {
    board.createProject({ name: 'Alpha' }, human);
    board.createBoard({ name: 'Sprint', projectId: 'general' }, human);
    board.createBoard({ name: 'Sprint', projectId: 'alpha' }, human);
    try {
      board.resolveBoard('Sprint');
      expect.unreachable('should have refused');
    } catch (error) {
      expect(isTrellaError(error)).toBe(true);
      if (!isTrellaError(error)) return;
      expect(error.message).toContain('matches more than one board');
    }
  });

  it('renames a board and edits its description', () => {
    const created = board.createBoard({ name: 'Sprint 1' }, human);
    const updated = board.updateBoard(
      created.id,
      { name: 'Sprint one', description: 'The first two weeks.' },
      agent
    );
    expect(updated.name).toBe('Sprint one');
    expect(updated.description).toBe('The first two weeks.');
    // The id and slug are stable, so an agent holding the id keeps working.
    expect(updated.id).toBe(created.id);
    expect(updated.slug).toBe(created.slug);
  });

  it('deletes a board and its cards, but never the last one', () => {
    const created = board.createBoard({ name: 'Temporary' }, human);
    board.createCard({ boardId: created.id, title: 'Goes away' }, human);
    board.deleteBoard(created.id, human);
    expect(board.listBoards().some((entry) => entry.id === created.id)).toBe(false);

    const last = board.defaultBoard();
    expect(() => board.deleteBoard(last.id, human)).toThrow(/only board/);
  });
});

describe('columns', () => {
  it('adds a column at the end or at a chosen position', () => {
    const id = board.defaultBoard().id;
    expect(board.addColumn(id, { name: 'Blocked' }, human).columns.at(-1)?.name).toBe('Blocked');
    expect(board.addColumn(id, { name: 'Triage', position: 0 }, human).columns[0]?.name).toBe(
      'Triage'
    );
  });

  it('renames, recolours and reorders a column', () => {
    const id = board.defaultBoard().id;
    const updated = board.updateColumn(
      id,
      'to-do',
      { name: 'Ready', color: 'sky', position: 0 },
      human
    );
    expect(updated.columns[0]?.name).toBe('Ready');
    expect(updated.columns[0]?.color).toBe('sky');
    // The id stays put, so cards keep their status.
    expect(updated.columns[0]?.id).toBe('to-do');
  });

  it('moves cards out of a column it removes instead of deleting them', () => {
    const id = board.defaultBoard().id;
    board.createCard({ title: 'Still needed', status: 'review' }, human);
    board.createCard({ title: 'Also needed', status: 'review' }, human);

    const updated = board.removeColumn(id, 'review', human, { moveCardsTo: 'in-progress' });
    expect(updated.columns.some((column) => column.id === 'review')).toBe(false);
    expect(order('in-progress')).toEqual(['Still needed', 'Also needed']);
  });

  it('defaults the rescue column to the first one', () => {
    const id = board.defaultBoard().id;
    board.createCard({ title: 'Rescued', status: 'done' }, human);
    board.removeColumn(id, 'done', human);
    expect(order('backlog')).toEqual(['Rescued']);
  });

  it('refuses to remove the last column', () => {
    const created = board.createBoard({ name: 'Single', columns: [{ name: 'Only' }] }, human);
    expect(() => board.removeColumn(created.id, 'only', human)).toThrow(/at least one column/);
  });

  it('rejects a status that is not a column on that board', () => {
    try {
      board.createCard({ title: 'Nope', status: 'shipped' }, human);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isTrellaError(error)).toBe(true);
      if (!isTrellaError(error)) return;
      expect(error.code).toBe('invalid_status');
      expect(error.details.available).toContain('in-progress');
    }
  });
});

describe('cards', () => {
  it('creates a card on the default board with full attribution', () => {
    const card = board.createCard({ title: 'Wire up the event stream' }, human);
    expect(card.id).toBe('TES-1');
    expect(card.boardId).toBe(board.defaultBoard().id);
    expect(card.status).toBe('backlog');
    expect(card.revision).toBe(1);
    expect(card.creator).toEqual(human);
  });

  it('creates a card on a named board', () => {
    const target = board.createBoard({ name: 'Sprint 1' }, human);
    const card = board.createCard({ boardId: 'sprint-1', title: 'Scoped' }, agent);
    expect(card.boardId).toBe(target.id);
    expect(card.id.startsWith('SPR-')).toBe(true);
  });

  it('bumps the revision on every change and records the new actor', () => {
    const card = board.createCard({ title: 'Draft' }, human);
    const updated = board.updateCard(card.id, { title: 'Final' }, agent);
    expect(updated.revision).toBe(2);
    expect(updated.lastActor).toEqual(agent);
    expect(updated.creator).toEqual(human);
  });

  it('does not bump the revision when nothing actually changed', () => {
    const card = board.createCard({ title: 'Same' }, human);
    expect(board.updateCard(card.id, { title: 'Same' }, agent).revision).toBe(1);
  });

  it('deduplicates labels and keeps their original casing', () => {
    const card = board.createCard({ title: 'Labelled', labels: ['API', 'api', ' ui '] }, human);
    expect(card.labels).toEqual(['API', 'ui']);
  });
});

describe('optimistic concurrency', () => {
  it('rejects a stale write and returns the current card to recover from', () => {
    const card = board.createCard({ title: 'Contested' }, human);
    board.updateCard(card.id, { description: 'From the agent' }, agent);

    try {
      board.updateCard(card.id, { title: 'From the human' }, human, card.revision);
      expect.unreachable('stale write should have been rejected');
    } catch (error) {
      expect(isTrellaError(error)).toBe(true);
      if (!isTrellaError(error)) return;
      expect(error.code).toBe('conflict');
      expect(error.status).toBe(409);
      expect(error.details.currentRevision).toBe(2);
      expect((error.details.current as { description: string }).description).toBe('From the agent');
      expect(error.message).toContain('Codex');
    }

    expect(board.getCard(card.id).title).toBe('Contested');
  });

  it('accepts the write once the caller has caught up', () => {
    const card = board.createCard({ title: 'Contested' }, human);
    board.updateCard(card.id, { description: 'From the agent' }, agent);
    const merged = board.updateCard(card.id, { title: 'Agreed' }, human, 2);
    expect(merged.title).toBe('Agreed');
    expect(merged.revision).toBe(3);
  });

  it('applies the same check to moves', () => {
    const card = board.createCard({ title: 'Racing' }, human);
    board.moveCard(card.id, { status: 'to-do' }, agent);
    expect(() => board.moveCard(card.id, { status: 'done' }, human, 1)).toThrow(/revision/);
  });
});

describe('ordering', () => {
  it('appends by default and keeps insertion order', () => {
    ['a', 'b', 'c'].forEach((title) => board.createCard({ title }, human));
    expect(order('backlog')).toEqual(['a', 'b', 'c']);
  });

  it('inserts at an explicit index and reorders within a column', () => {
    ['a', 'b', 'c', 'd'].forEach((title) => board.createCard({ title }, human));
    board.createCard({ title: 'wedge', position: 1 }, human);
    expect(order('backlog')).toEqual(['a', 'wedge', 'b', 'c', 'd']);

    const c = board.listCards({ status: 'backlog' }).find((card) => card.title === 'c')!;
    board.moveCard(c.id, { status: 'backlog', position: 0 }, human);
    expect(order('backlog')[0]).toBe('c');
  });

  it('clamps an out-of-range index instead of failing', () => {
    ['a', 'b'].forEach((title) => board.createCard({ title }, human));
    const card = board.createCard({ title: 'z', status: 'to-do' }, human);
    board.moveCard(card.id, { status: 'backlog', position: 99 }, human);
    expect(order('backlog')).toEqual(['a', 'b', 'z']);
  });

  it('lets a client that only applies events converge on the server order', () => {
    const client = new Map<string, { position: number; status: string; title: string }>();
    let sawRenumbering = false;

    board.subscribe((event) => {
      if (event.card) {
        client.set(event.card.id, {
          position: event.card.position,
          status: event.card.status,
          title: event.card.title,
        });
      }
      for (const entry of event.reordered ?? []) {
        sawRenumbering = true;
        const existing = client.get(entry.id);
        if (existing) existing.position = entry.position;
      }
    });

    board.createCard({ title: 'first' }, human);
    board.createCard({ title: 'last' }, human);
    for (let i = 0; i < 120; i += 1) board.createCard({ title: `wedge-${i}`, position: 1 }, human);

    expect(sawRenumbering).toBe(true);
    const clientOrder = [...client.values()]
      .filter((card) => card.status === 'backlog')
      .sort((a, b) => a.position - b.position)
      .map((card) => card.title);
    expect(clientOrder).toEqual(order('backlog'));
    expect(clientOrder[0]).toBe('first');
    expect(clientOrder.at(-1)).toBe('last');
  });
});

describe('claiming', () => {
  it('assigns the card to the caller and is idempotent', () => {
    const card = board.createCard({ title: 'Unclaimed' }, human);
    const first = board.claimCard(card.id, agent);
    expect(first.assignee).toEqual(agent);
    expect(board.claimCard(card.id, agent).revision).toBe(first.revision);
  });

  it('refuses to steal a card another agent already holds', () => {
    const card = board.createCard({ title: 'Contested' }, human);
    board.claimCard(card.id, agent);
    try {
      board.claimCard(card.id, reviewer);
      expect.unreachable('should have refused');
    } catch (error) {
      expect(isTrellaError(error)).toBe(true);
      if (!isTrellaError(error)) return;
      expect(error.code).toBe('conflict');
      expect(error.message).toContain('Codex');
    }
  });
});

describe('activity and events', () => {
  it('records an entry for every mutation with before and after values', () => {
    const card = board.createCard({ title: 'Traced' }, human);
    board.updateCard(card.id, { priority: 'high' }, agent);
    board.moveCard(card.id, { status: 'in-progress' }, agent);
    board.addComment(card.id, 'Working on it now.', agent);
    board.setArchived(card.id, true, human);

    const activity = board.getActivity({ cardId: card.id });
    expect(activity.map((entry) => entry.action)).toEqual([
      'card.created',
      'card.updated',
      'card.moved',
      'card.commented',
      'card.archived',
    ]);
    expect(activity[1]!.changes.priority).toEqual({ from: 'medium', to: 'high' });
    expect(activity[2]!.changes.status).toEqual({ from: 'backlog', to: 'in-progress' });
  });

  it('never attributes an agent change to the human', () => {
    const card = board.createCard({ title: 'Attribution' }, human);
    board.moveCard(card.id, { status: 'review' }, agent);
    expect(board.getActivity({ cardId: card.id }).map((e) => e.actor.type)).toEqual([
      'human',
      'agent',
    ]);
    expect(board.getCard(card.id).lastActor).toEqual(agent);
  });

  it('emits one event per committed mutation, carrying its board id', () => {
    const events: BoardEvent[] = [];
    const stop = board.subscribe((event) => events.push(event));

    const card = board.createCard({ title: 'Watched' }, human);
    board.moveCard(card.id, { status: 'to-do' }, agent);
    stop();
    board.updateCard(card.id, { title: 'Unwatched' }, human);

    expect(events.map((event) => event.type)).toEqual(['card.created', 'card.moved']);
    expect(events[1]!.previousStatus).toBe('backlog');
    expect(events[1]!.boardId).toBe(board.defaultBoard().id);
    expect(events[1]!.actor).toEqual(agent);
  });

  it('replays activity after a cursor so a dropped client can catch up', () => {
    const card = board.createCard({ title: 'Resumable' }, human);
    const cursor = board.cursor();
    board.updateCard(card.id, { priority: 'urgent' }, agent);
    board.addComment(card.id, 'Note', agent);

    const missed = board.activitySince(cursor);
    expect(missed.map((entry) => entry.action)).toEqual(['card.updated', 'card.commented']);
    expect(missed.every((entry) => entry.seq > cursor)).toBe(true);
  });

  it('keeps a workspace-wide sequence across boards', () => {
    const other = board.createBoard({ name: 'Other' }, human);
    board.createCard({ title: 'On the default board' }, human);
    board.createCard({ boardId: other.id, title: 'On the other board' }, human);
    const all = board.getActivity({});
    const seqs = all.map((entry) => entry.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});

describe('comments', () => {
  it('keeps a comment from invalidating an in-flight edit', () => {
    const card = board.createCard({ title: 'Discussed' }, human);
    board.addComment(card.id, 'Looks good.', agent);
    const after = board.getCard(card.id);
    expect(after.revision).toBe(card.revision);
    expect(after.comments).toHaveLength(1);
    expect(after.lastActor).toEqual(agent);
  });

  it('rejects an empty comment', () => {
    const card = board.createCard({ title: 'Discussed' }, human);
    expect(() => board.addComment(card.id, '  ', agent)).toThrow(/cannot be empty/);
  });
});

describe('filters', () => {
  beforeEach(() => {
    board.createCard({ title: 'Fix reconnect backoff', labels: ['api'], priority: 'urgent' }, human);
    board.createCard({ title: 'Polish empty state', labels: ['UI'], status: 'to-do' }, human);
    const claimed = board.createCard({ title: 'Write the migration' }, human);
    board.claimCard(claimed.id, agent);
  });

  it('filters by status, label, priority and assignee', () => {
    expect(board.listCards({ status: 'to-do' }).map((c) => c.title)).toEqual(['Polish empty state']);
    expect(board.listCards({ label: 'ui' }).map((c) => c.title)).toEqual(['Polish empty state']);
    expect(board.listCards({ priority: 'urgent' }).map((c) => c.title)).toEqual([
      'Fix reconnect backoff',
    ]);
    expect(board.listCards({ assignee: agent.id }).map((c) => c.title)).toEqual([
      'Write the migration',
    ]);
  });

  it('scopes a listing to one board', () => {
    const other = board.createBoard({ name: 'Other' }, human);
    board.createCard({ boardId: other.id, title: 'Elsewhere' }, human);
    expect(board.listCards({ boardId: other.id }).map((c) => c.title)).toEqual(['Elsewhere']);
    expect(board.listCards({}).length).toBe(4);
  });

  it('hides archived cards unless asked for them', () => {
    const card = board.listCards({ status: 'to-do' })[0]!;
    board.setArchived(card.id, true, human);
    expect(board.listCards({ status: 'to-do' })).toHaveLength(0);
    expect(board.listCards({ archived: true }).map((c) => c.title)).toEqual(['Polish empty state']);
    board.setArchived(card.id, false, human);
    expect(board.listCards({ status: 'to-do' })).toHaveLength(1);
  });
});

describe('durability', () => {
  it('keeps everything across a reopen', () => {
    const custom = board.createBoard(
      { name: 'Research', columns: [{ name: 'Questions' }, { name: 'Answered', terminal: true }] },
      human
    );
    const card = board.createCard({ boardId: custom.id, title: 'Persisted', priority: 'high' }, human);
    board.moveCard(card.id, { status: 'answered' }, agent);
    board.addComment(card.id, 'Kept too.', agent);
    board.close();

    const reopened = new BoardService({ data: data(), workspaceName: 'Test' });
    const reloaded = reopened.getCard(card.id);
    expect(reloaded.title).toBe('Persisted');
    expect(reloaded.status).toBe('answered');
    expect(reloaded.comments).toHaveLength(1);
    expect(reopened.getBoard(custom.id).columns.map((c) => c.id)).toEqual([
      'questions',
      'answered',
    ]);
    expect(reopened.getActivity({ cardId: card.id })).toHaveLength(3);
    expect(reopened.createCard({ boardId: custom.id, title: 'Next' }, human).id).toBe('RES-2');
    reopened.close();
  });

  it('never leaves a temporary file behind', () => {
    board.createCard({ title: 'Atomic' }, human);
    const boardId = board.defaultBoard().id;
    const cards = readdirSync(join(data(), 'projects/general/boards', boardId, 'cards'));
    expect(cards.every((name) => name.endsWith('.json'))).toBe(true);
    expect(existsSync(join(data(), '.lock'))).toBe(false);
  });
});

describe('the default board', () => {
  it('stays the first board created, whatever anyone calls the next one', () => {
    // Alphabetical ordering here would silently move every unscoped write onto
    // a board the caller never asked for.
    const first = board.defaultBoard();
    board.createBoard({ name: 'Aaa first alphabetically' }, human);
    expect(board.defaultBoard().id).toBe(first.id);
    expect(board.createCard({ title: 'Unscoped' }, human).boardId).toBe(first.id);
  });
});
