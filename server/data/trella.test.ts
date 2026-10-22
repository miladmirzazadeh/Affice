// trella.ts on a small copy of a Trella projects tree: which cards count as decisions, which are
// left out, the card link, and a workspace that is not there.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { readDecisions, TrellaMissing, trellaCardUrl } from './trella';

const COLUMNS = [
  { id: 'backlog', terminal: false },
  { id: 'review', terminal: false },
  { id: 'done', terminal: true },
];

describe('decisions from Trella', () => {
  let root = '';

  const board = (project: string, folder: string, id: string, name: string, columns = COLUMNS, createdAt = '2026-10-17T12:00:00.000Z') => {
    const dir = join(root, '.agentboard', 'projects', project, 'boards', folder);
    mkdirSync(join(dir, 'cards'), { recursive: true });
    writeFileSync(join(dir, 'board.json'), JSON.stringify({ id, name, columns, createdAt }));
    return (key: string, status: string, labels: string[], extra: Record<string, unknown> = {}) =>
      writeFileSync(
        join(dir, 'cards', `${key}.json`),
        JSON.stringify({ id: key, boardId: id, title: `Card ${key}`, status, labels, archived: false, updatedAt: '2026-10-17T13:00:00.000Z', ...extra }),
      );
  };

  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'office-trella-')));
    const dev = board('development', 'bd_dev', 'bd_dev', 'Engineering');
    dev('ENG-10', 'review', ['ats', 'decision']);
    dev('ENG-2', 'backlog', ['Decision']); // the label is matched without regard to case
    dev('ENG-3', 'done', ['decision']); // answered: in a terminal column
    dev('ENG-4', 'backlog', ['decision'], { archived: true });
    dev('ENG-5', 'backlog', ['ops']); // not a decision
    writeFileSync(join(root, '.agentboard', 'projects', 'development', 'boards', 'bd_dev', 'cards', 'broken.json'), '{ not json');

    // A second board, created later, with its own terminal column. No board name is special.
    const ops = board('general', 'bd_ops', 'bd_ops', 'Operations', [...COLUMNS, { id: 'failed', terminal: true }], '2026-10-18T12:00:00.000Z');
    ops('OPS-2', 'backlog', []); // not labelled decision: not listed, whatever the board is called
    ops('OPS-1', 'backlog', ['decision']);
    ops('OPS-3', 'failed', ['decision']); // terminal column
    // Older than the Development board, so it comes first when no board is the department's own.
    const mkt = board('marketing', 'bd_mkt', 'bd_mkt', 'Marketing', COLUMNS, '2026-10-17T11:00:00.000Z');
    mkt('MKT-1', 'backlog', ['decision']);
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  it('lists open decision cards on every board, the department board first, then the other boards in creation order', async () => {
    const view = await readDecisions(root, 'http://127.0.0.1:4174/', { trellaBoardId: 'bd_dev' });
    assert.deepEqual(
      view.cards.map((card) => card.key),
      ['ENG-2', 'ENG-10', 'MKT-1', 'OPS-1'],
    );
    const card = view.cards.find((candidate) => candidate.key === 'ENG-10')!;
    assert.deepEqual(
      { title: card.title, boardId: card.boardId, status: card.status, labels: card.labels, updatedAt: card.updatedAt },
      { title: 'Card ENG-10', boardId: 'bd_dev', status: 'review', labels: ['ats', 'decision'], updatedAt: '2026-10-17T13:00:00.000Z' },
    );
  });

  it("names the board of each card, for the group titles of the Decisions view", async () => {
    const view = await readDecisions(root, 'http://127.0.0.1:4174', { trellaBoardId: 'bd_dev' });
    assert.deepEqual(
      view.cards.map((card) => [card.key, card.boardName]),
      [
        ['ENG-2', 'Engineering'],
        ['ENG-10', 'Engineering'],
        ['MKT-1', 'Marketing'],
        ['OPS-1', 'Operations'],
      ],
    );
  });

  it('links each card into Trella with the board and the card', async () => {
    const view = await readDecisions(root, 'http://127.0.0.1:4174', { trellaBoardId: 'bd_dev' });
    assert.equal(view.cards[0]!.url, 'http://127.0.0.1:4174/?board=bd_dev&card=ENG-2');
    assert.equal(trellaCardUrl('http://x.test///', 'bd 1', 'OPS-1'), 'http://x.test/?board=bd%201&card=OPS-1');
  });

  it('lists the decisions of every board for a manager with no board of its own (the general manager)', async () => {
    const view = await readDecisions(root, 'http://127.0.0.1:4174', { trellaBoardId: null });
    assert.deepEqual(
      view.cards.map((card) => card.key),
      ['MKT-1', 'ENG-2', 'ENG-10', 'OPS-1'], // by the creation time of the boards
    );
  });

  it('says so when there is no Trella workspace', async () => {
    const empty = realpathSync(mkdtempSync(join(tmpdir(), 'office-trella-empty-')));
    try {
      await assert.rejects(readDecisions(empty, 'http://127.0.0.1:4174', { trellaBoardId: null }), TrellaMissing);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
