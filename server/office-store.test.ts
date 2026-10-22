import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { DepartmentInput } from '../shared/types';
import { nextSlot, OfficeStore, readChatLine, slugify, uniqueId } from './office-store';

const fixture = join(import.meta.dirname, '../fixtures/office.json');
const dirs: string[] = [];
function fresh(): { store: OfficeStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'office-store-'));
  dirs.push(dir);
  return { store: OfficeStore.open({ dataDir: dir, fixture }), dir };
}
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const input = (name: string): DepartmentInput => ({
  name,
  color: 'rose',
  responsibility: 'Answers customer questions.',
  cwd: tmpdir(),
  model: 'claude-sonnet-5-5',
  permission: 'read-only',
});

test('a new department with no report folder gets reports; an explicit list is kept, also on update and on load', () => {
  const { store, dir } = fresh();
  const none = store.create(input('Support'), null);
  assert.deepEqual(none.reportDirs, ['reports'], 'left out: the default');
  assert.deepEqual(store.create({ ...input('Sales'), reportDirs: [] }, null).reportDirs, ['reports'], 'an empty list on a new department: the default');
  assert.deepEqual(store.create({ ...input('Care'), reportDirs: ['out/reports', 'docs'] }, null).reportDirs, ['out/reports', 'docs'], 'an explicit list stays as written');

  // Only new departments get the default: an edit that empties the list means none, and a file on disk is not rewritten.
  assert.deepEqual(store.update('support', { reportDirs: [] }).reportDirs, []);
  assert.deepEqual(store.update('support', { name: 'Support desk' }).reportDirs, [], 'an unrelated edit leaves it empty');
  const reopened = OfficeStore.open({ dataDir: dir, fixture });
  assert.deepEqual(reopened.byId('support')!.reportDirs, []);
  assert.deepEqual(reopened.byId('care')!.reportDirs, ['out/reports', 'docs']);
});

test('ids are slugs of the name, unique, at most 32 characters', () => {
  assert.equal(slugify('Customer Success!'), 'customer-success');
  assert.equal(slugify('Café Ops'), 'cafe-ops');
  assert.equal(uniqueId('Разработка', []), 'department');
  assert.equal(uniqueId('Marketing', ['marketing']), 'marketing-2');
  assert.equal(uniqueId('Marketing', ['marketing', 'marketing-2']), 'marketing-3');
  const long = uniqueId('A very long department name that goes on', ['a-very-long-department-name-that']);
  assert.ok(long.length <= 32 && /^[a-z0-9-]+-2$/.test(long), long);
});

test('slots fill the lowest free room', () => {
  assert.equal(nextSlot([]), 0);
  assert.equal(nextSlot([{ slot: 0 }, { slot: 1 }]), 2);
  assert.equal(nextSlot([{ slot: 0 }, { slot: 2 }]), 1);
});

test('the store seeds from the fixture, then creates, updates and removes departments', () => {
  const { store, dir } = fresh();
  assert.ok(existsSync(join(dir, 'office.json')), 'data/office.json is written on first run');
  assert.deepEqual(store.departments().map((d) => d.id), ['general', 'engineering', 'marketing']);

  const support = store.create(input('Support'), 'bd_x');
  assert.equal(support.id, 'support');
  assert.equal(support.slot, 2);
  assert.equal(support.trellaBoardId, 'bd_x');
  const sales = store.create(input('Sales'), null);
  assert.equal(sales.slot, 3);

  assert.throws(() => store.create(input('support'), null), /already exists/);
  assert.throws(() => store.create(input('Marketing'), null), /already exists/, 'a fixture department counts too');
  assert.throws(() => store.create({ ...input('Ops'), color: 'teal' as never, cwd: 'relative/path' }, null), /color.*absolute path/s);

  const renamed = store.update('support', { name: 'Care', model: 'claude-haiku-5-5' });
  assert.equal(renamed.id, 'support', 'the id stays when the name changes');
  assert.equal(renamed.model, 'claude-haiku-5-5');
  assert.throws(() => store.update('support', { permission: 'bypass' as never }), /permission policy/);

  assert.ok(store.remove('support'));
  assert.equal(store.create(input('Help desk'), null).slot, 2, 'the freed room is reused');
  const reopened = OfficeStore.open({ dataDir: dir, fixture });
  assert.deepEqual(reopened.departments().map((d) => [d.id, d.slot]), [['general', -1], ['engineering', 0], ['marketing', 1], ['help-desk', 2], ['sales', 3]]);
});

test('a relative working directory in the fixture means the office root', () => {
  const root = mkdtempSync(join(tmpdir(), 'office-root-'));
  const dir = mkdtempSync(join(tmpdir(), 'office-store-'));
  dirs.push(root, dir);
  const store = OfficeStore.open({ dataDir: dir, fixture, root });
  assert.deepEqual(store.departments().map((d) => d.cwd), [root, root, root]);
  const bare = mkdtempSync(join(tmpdir(), 'office-store-'));
  dirs.push(bare);
  assert.ok(OfficeStore.open({ dataDir: bare, fixture }).departments().every((d) => d.cwd === process.cwd()), 'no root: the current directory');
});

test('the general manager is seeded on every start, keeps its lobby, and cannot be removed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'office-store-'));
  dirs.push(dir);
  // An office.json from before the lobby: only the two departments.
  const old = JSON.parse(readFileSync(fixture, 'utf8'));
  old.departments = old.departments.filter((d: { id: string }) => d.id !== 'general');
  writeFileSync(join(dir, 'office.json'), JSON.stringify(old));
  // A seed whose general manager already has a board: the board id is carried over.
  const seed = JSON.parse(readFileSync(fixture, 'utf8'));
  seed.departments.find((d: { id: string }) => d.id === 'general').trellaBoardId = 'bd_general';
  const seedFile = join(dir, 'seed.json');
  writeFileSync(seedFile, JSON.stringify(seed));
  const store = OfficeStore.open({ dataDir: dir, fixture: seedFile });
  const general = store.byId('general')!;
  assert.equal(general.kind, 'lobby');
  assert.equal(general.slot, -1);
  assert.equal(general.trellaBoardId, 'bd_general');
  assert.ok(JSON.parse(readFileSync(join(dir, 'office.json'), 'utf8')).departments.some((d: { id: string }) => d.id === 'general'), 'saved');

  assert.throws(() => store.remove('general'), /cannot be removed/);
  assert.throws(() => store.create({ ...input('Front desk'), kind: 'lobby' } as DepartmentInput, null), /only one lobby/);
  assert.equal(store.create(input('Front desk'), null).kind, undefined, 'a new department is a room');
  assert.equal(store.update('general', { name: 'Chief of staff', permission: 'ask' }).kind, 'lobby', 'name and policy are editable');
});

test('the general manager has no board of its own: no board is looked up by name, whatever the workspace holds', () => {
  const root = mkdtempSync(join(tmpdir(), 'office-root-'));
  const dir = mkdtempSync(join(tmpdir(), 'office-store-'));
  dirs.push(root, dir);
  const boardDir = join(root, '.agentboard/projects/general/boards/bd_head');
  mkdirSync(boardDir, { recursive: true });
  writeFileSync(join(boardDir, 'board.json'), JSON.stringify({ id: 'bd_head', name: 'Head office' }));
  const config = JSON.parse(readFileSync(fixture, 'utf8'));
  config.departments.find((d: { id: string }) => d.id === 'general').trellaBoardId = null;
  writeFileSync(join(dir, 'office.json'), JSON.stringify(config));
  assert.equal(OfficeStore.open({ dataDir: dir, fixture, root }).byId('general')!.trellaBoardId, null);
});

test('knowledge folders are validated, kept, cleared by an empty list, and unset by default', () => {
  const { store, dir } = fresh();
  assert.equal(store.byId('general')!.knowledgeDirs, undefined, 'unset: the driver applies the general manager default');

  const withDirs = store.create({ ...input('Research'), knowledgeDirs: [' docs ', '/abs/notes', 'docs', ''] }, null);
  assert.deepEqual(withDirs.knowledgeDirs, ['docs', '/abs/notes'], 'trimmed, without blanks and repeats, absolute or relative as typed');
  assert.equal(store.create(input('Plain'), null).knowledgeDirs, undefined, 'a department without them stays unset');

  const general = store.update('general', { knowledgeDirs: ['Office', 'README.md'] } as never);
  assert.deepEqual(general.knowledgeDirs, ['Office', 'README.md'], 'the general manager can name its folders');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'office.json'), 'utf8')).departments.find((d: { id: string }) => d.id === 'general').knowledgeDirs, ['Office', 'README.md'], 'saved');
  assert.deepEqual(OfficeStore.open({ dataDir: dir, fixture }).byId('general')!.knowledgeDirs, ['Office', 'README.md'], 'and read back');

  assert.equal('knowledgeDirs' in store.update('general', { knowledgeDirs: [] } as never), false, 'an empty list clears them');
  assert.equal(store.update('research', { name: 'Research desk' }).knowledgeDirs?.length, 2, 'other patches leave them alone');

  assert.throws(() => store.update('general', { knowledgeDirs: 'docs' } as never), /list of at most 50 paths/);
  assert.throws(() => store.update('general', { knowledgeDirs: [1] } as never), /list of at most 50 paths/);
  assert.throws(() => store.update('general', { knowledgeDirs: Array.from({ length: 51 }, (_, i) => `d${i}`) } as never), /at most 50/);
  assert.throws(() => store.create({ ...input('Long'), knowledgeDirs: ['x'.repeat(1001)] }, null), /longer than 1000/);
  assert.equal(store.byId('long'), null, 'a refused department is not created');
});

test('a hand-edited office keeps the valid knowledge folders and drops the broken ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'office-store-'));
  dirs.push(dir);
  const config = JSON.parse(readFileSync(fixture, 'utf8'));
  for (const d of config.departments) d.cwd = tmpdir();
  config.departments[0].knowledgeDirs = ['Office', 7, '', 'README.md', 'Office'];
  config.departments[1].knowledgeDirs = 'docs';
  config.departments[2].knowledgeDirs = [];
  writeFileSync(join(dir, 'office.json'), JSON.stringify(config));
  const store = OfficeStore.open({ dataDir: dir, fixture });
  assert.deepEqual(store.byId('general')!.knowledgeDirs, ['Office', 'README.md']);
  assert.equal(store.byId('engineering')!.knowledgeDirs, undefined);
  assert.equal(store.byId('marketing')!.knowledgeDirs, undefined);
});

test('chat history appends, keeps the last messages, and is set aside on remove', () => {
  const { store, dir } = fresh();
  for (let i = 0; i < 5; i += 1) {
    store.appendChat({ id: `m${i}`, department: 'engineering', role: 'user', text: `hello ${i}`, at: `2026-10-17T13:00:0${i}.000Z`, streaming: true });
  }
  const last = store.loadChat('engineering', 3);
  assert.deepEqual(last.map((m) => m.id), ['m2', 'm3', 'm4']);
  assert.ok(last.every((m) => m.streaming === false));
  assert.ok(readFileSync(join(dir, 'chat/engineering.jsonl'), 'utf8').endsWith('\n'));
  store.remove('engineering');
  assert.deepEqual(store.loadChat('engineering'), []);
  assert.throws(() => store.loadChat('../etc'), /Not a department id/);
});

test('a chat file written with the old role name founder is read as user', () => {
  const { store, dir } = fresh();
  const old = { id: 'old1', department: 'engineering', role: 'founder', text: 'from an old version', at: '2026-10-01T09:00:00.000Z', streaming: false };
  const manager = { id: 'old2', department: 'engineering', role: 'manager', text: 'an answer', at: '2026-10-01T09:00:05.000Z', streaming: false };
  mkdirSync(join(dir, 'chat'), { recursive: true });
  writeFileSync(join(dir, 'chat/engineering.jsonl'), `${JSON.stringify(old)}\n${JSON.stringify(manager)}\nnot json, a torn line\n`);
  const messages = store.loadChat('engineering');
  assert.deepEqual(messages.map((m) => [m.id, m.role]), [['old1', 'user'], ['old2', 'manager']]);
  // New lines are written with the new name, after the old ones.
  store.appendChat({ id: 'new1', department: 'engineering', role: 'user', text: 'now', at: '2026-10-02T09:00:00.000Z', streaming: false });
  assert.deepEqual(store.loadChat('engineering').map((m) => m.role), ['user', 'manager', 'user']);
  assert.ok(!readFileSync(join(dir, 'chat/engineering.jsonl'), 'utf8').split('\n').slice(2).join('\n').includes('founder'));
  assert.equal(readChatLine(JSON.stringify(old)).role, 'user');
  assert.equal(readChatLine(JSON.stringify(manager)).role, 'manager');
});

// SEC-04: nothing is written through a symbolic link ----------------------------------------------------

function victimFolder(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'office-victim-'));
  dirs.push(dir);
  const file = join(dir, 'keep.txt');
  writeFileSync(file, 'KEEP-ME');
  return { dir, file };
}

test('SEC-04: a planted office.json.tmp link is not written through by a save', () => {
  const { store, dir } = fresh();
  const { file } = victimFolder();
  symlinkSync(file, join(dir, 'office.json.tmp'));
  store.setSessionId('engineering', 'abc12345');
  store.create(input('Support'), null);
  assert.equal(readFileSync(file, 'utf8'), 'KEEP-ME');
  assert.ok(!lstatSync(join(dir, 'office.json')).isSymbolicLink(), 'the config stays a regular file');
  assert.equal(JSON.parse(readFileSync(join(dir, 'office.json'), 'utf8')).departments.find((d: { id: string }) => d.id === 'engineering').sessionId, 'abc12345');
});

test('SEC-04: a config file that is a link, or a folder that is a link, is refused when the store opens', () => {
  const { dir: victim, file } = victimFolder();
  const holder = mkdtempSync(join(tmpdir(), 'office-store-'));
  dirs.push(holder);
  symlinkSync(file, join(holder, 'affice.json'));
  assert.throws(() => OfficeStore.open({ dataDir: holder, fixture, configFile: join(holder, 'affice.json') }), /office file .* is a symbolic link/);
  assert.equal(readFileSync(file, 'utf8'), 'KEEP-ME');

  const linkedFolder = join(holder, 'linked-office');
  symlinkSync(victim, linkedFolder);
  assert.throws(() => OfficeStore.open({ dataDir: linkedFolder, fixture }), /office folder .* is a symbolic link/);
  assert.deepEqual(readdirSync(victim), ['keep.txt'], 'nothing was created in the folder the link leads to');
});

test('SEC-04 P5: a chat folder that is a link gets no chat line, and its history is not read', () => {
  const { store, dir } = fresh();
  const { dir: victim } = victimFolder();
  symlinkSync(victim, join(dir, 'chat'));
  const message = { id: 'm1', department: 'engineering', role: 'user' as const, text: 'hello', at: '2026-01-01T00:00:00.000Z', streaming: false };
  assert.throws(() => store.appendChat(message), /chat folder .* is a symbolic link/);
  assert.deepEqual(readdirSync(victim), ['keep.txt'], 'no engineering.jsonl in the target folder');
  writeFileSync(join(victim, 'engineering.jsonl'), `${JSON.stringify(message)}\n`);
  assert.deepEqual(store.loadChat('engineering'), [], 'the history behind the link is not shown as this office\'s');
  assert.match(store.problems.join('\n'), /chat history of engineering was not read/);
  assert.ok(store.remove('engineering') === true);
  assert.ok(existsSync(join(victim, 'engineering.jsonl')), 'removing a department does not rename files behind a link');
});

test('SEC-04: a chat file that is a link (live or dangling) is refused, not followed', () => {
  const { store, dir } = fresh();
  const { dir: victim, file } = victimFolder();
  mkdirSync(join(dir, 'chat'), { recursive: true });
  symlinkSync(file, join(dir, 'chat', 'engineering.jsonl'));
  symlinkSync(join(victim, 'created-by-affice.jsonl'), join(dir, 'chat', 'marketing.jsonl'));
  const message = (department: string) => ({ id: 'm', department, role: 'user' as const, text: 'x', at: '2026-01-01T00:00:00.000Z', streaming: false });
  assert.throws(() => store.appendChat(message('engineering')), /chat file .* is a symbolic link/);
  assert.throws(() => store.appendChat(message('marketing')), /chat file .* is a symbolic link/);
  assert.equal(readFileSync(file, 'utf8'), 'KEEP-ME');
  assert.ok(!existsSync(join(victim, 'created-by-affice.jsonl')));
  // the normal path still works next to them
  store.appendChat(message('general'));
  assert.equal(store.loadChat('general').length, 1);
});

// SEC-10: the config is validated when it loads ---------------------------------------------------------

const hostile = (): Record<string, unknown> => ({
  version: 1,
  company: 'Hostile Inc',
  trellaUrl: 'http://evil.example/board',
  rogue: { a: 1 },
  departments: [
    {
      id: 'general',
      kind: 'lobby',
      name: 'General manager',
      color: 'stone',
      responsibility: 'Answer.',
      cwd: tmpdir(),
      model: 'opus',
      permission: 'read-only',
      repos: [],
      reportDirs: ['reports'],
      trellaBoardId: null,
      sessionId: null,
      slot: -1,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'evil',
      name: 'Evil',
      color: 'teal',
      responsibility: 'x',
      cwd: tmpdir(),
      model: '--dangerously-skip-permissions',
      permission: 'bypassPermissions',
      repos: [{ name: 'r', path: '/tmp/r', base: '--upload-pack=touch /tmp/x' }, { name: 'ok', path: '/tmp/ok', base: 'main' }, 'text', null],
      reportDirs: ['reports', 5, '', null, '/a/b'],
      knowledgeDirs: ['docs', 7, ''],
      trellaBoardId: '../../etc',
      sessionId: '--dangerously-skip-permissions',
      slot: 'two',
      createdAt: 'yesterday',
      shell: 'rm -rf /',
    },
    { id: '../escape', name: 'Escape' },
    { id: 'evil', name: 'Twin' },
    'not an object',
    null,
    { id: 'Upper Case' },
    { id: 'plain', name: 'Plain', color: 'sky', responsibility: 'ok', cwd: '/definitely/not/a/folder', model: 'claude-sonnet-5-5', permission: 'ask', slot: 3, createdAt: '2026-02-02T00:00:00.000Z' },
  ],
});

function configIn(dir: string, value: unknown): string {
  const file = join(dir, 'affice.json');
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
}

function openHostile(value: unknown): { store: OfficeStore; dir: string; lines: string[]; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'office-hostile-'));
  dirs.push(dir);
  const file = configIn(dir, value);
  const lines: string[] = [];
  const store = OfficeStore.open({ dataDir: dir, configFile: file, fixture, company: 'Folder name', cwdDefault: dir, log: (line) => lines.push(line) });
  return { store, dir, lines, file };
}

test('SEC-10: a hostile affice.json is repaired, reported, kept aside, and nothing of it reaches an argument', () => {
  const original = JSON.stringify(hostile());
  const { store, dir, lines, file } = openHostile(hostile());

  assert.deepEqual(store.departments().map((d) => d.id), ['general', 'evil', 'plain'], 'invalid ids, the twin and the non-objects are skipped');
  const evil = store.byId('evil')!;
  assert.equal(evil.model, 'sonnet');
  assert.equal(evil.permission, 'ask', 'bypassPermissions in a file is never kept');
  assert.equal(evil.color, 'stone');
  assert.equal(evil.sessionId, null, 'a session id that is a flag is dropped');
  assert.equal(evil.trellaBoardId, null);
  assert.deepEqual(evil.repos, [{ name: 'ok', path: '/tmp/ok', base: 'main' }], 'a base that is an option is dropped, with the entries that are not objects');
  assert.deepEqual(evil.reportDirs, ['reports', '/a/b']);
  assert.deepEqual(evil.knowledgeDirs, ['docs']);
  assert.equal(evil.slot, 0, 'a missing room position is given the lowest free one');
  assert.ok(!Number.isNaN(Date.parse(evil.createdAt)));
  assert.ok(!('shell' in evil), 'an unknown field is dropped');
  assert.equal(store.config.trellaUrl, 'http://localhost:4174', 'an address that is not on this machine is replaced');
  assert.ok(!('rogue' in store.config));
  assert.equal(store.byId('plain')!.cwd, '/definitely/not/a/folder', 'a working folder that is gone is kept and reported, not rewritten');

  const text = store.problems.join('\n');
  for (const part of ['Fields Affice does not know were dropped from the office (rogue)', 'Trella address', 'evil: ', 'the color teal', 'the model --dangerously-skip-permissions', 'the permission bypassPermissions', 'the session id', 'fields Affice does not know were dropped (shell)', 'repo entries', 'plain: the working folder /definitely/not/a/folder does not exist', 'no valid id', 'appears twice', 'The original file was kept as affice.json.corrupt-']) {
    assert.ok(text.includes(part), `${part}\n${text}`);
  }
  assert.deepEqual(lines.length, store.problems.length, 'every problem is logged once');

  const kept = readdirSync(dir).filter((name) => name.startsWith('affice.json.corrupt-'));
  assert.equal(kept.length, 1);
  assert.equal(readFileSync(join(dir, kept[0]), 'utf8'), original, 'the original is kept byte for byte');
  const saved = JSON.parse(readFileSync(file, 'utf8')) as { departments: Array<{ model: string }> };
  assert.ok(saved.departments.every((d) => d.model !== '--dangerously-skip-permissions'), 'the file on disk is the repaired one');

  const again = OfficeStore.open({ dataDir: dir, configFile: file, fixture, company: 'Folder name', cwdDefault: dir });
  assert.deepEqual(again.problems.filter((line) => !line.includes('does not exist')), [], 'a second open finds nothing to repair');
  assert.equal(readdirSync(dir).filter((name) => name.startsWith('affice.json.corrupt-')).length, 1, 'and keeps nothing more');
});

test('SEC-10: a file that is not JSON, not an object or too odd is kept aside and a new office is made', () => {
  for (const [label, content] of [
    ['truncated JSON', '{"version":1,"departments":['],
    ['an empty file', ''],
    ['plain text', 'hello'],
    ['an array', '[]'],
    ['null', 'null'],
    ['a number', '5'],
    ['departments that is not a list', '{"version":1,"departments":5}'],
    ['departments that is an object', '{"version":1,"departments":{"general":{}}}'],
  ] as const) {
    const { store, dir, file } = openHostile(content);
    assert.deepEqual(store.departments().map((d) => d.id), ['general'], label);
    assert.equal(store.config.company, 'Folder name', label);
    assert.equal(store.byId('general')!.cwd, dir, `${label}: the general manager works in the project folder`);
    assert.match(store.problems[0], /office file could not be used/, label);
    const kept = readdirSync(dir).filter((name) => name.startsWith('affice.json.corrupt-'));
    assert.equal(kept.length, 1, label);
    assert.equal(readFileSync(join(dir, kept[0]), 'utf8'), content, `${label}: the original is kept`);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).departments[0].id, 'general', `${label}: a fresh file is written`);
  }
});

test('SEC-10: a file larger than 10 MB is set aside without being read into the office', () => {
  const dir = mkdtempSync(join(tmpdir(), 'office-big-'));
  dirs.push(dir);
  const file = join(dir, 'affice.json');
  writeFileSync(file, `{"version":1,"departments":[],"pad":"${'x'.repeat(10 * 1024 * 1024 + 10)}"}`);
  const store = OfficeStore.open({ dataDir: dir, configFile: file, fixture });
  assert.match(store.problems[0], /larger than 10 MB/);
  assert.deepEqual(store.departments().map((d) => d.id), ['general']);
});

test('SEC-10: odd departments never crash the load, and long or control characters stay out of the sentences', () => {
  const nasty = 'A'.repeat(500) + '\u0007\u001b[31m';
  const { store } = openHostile({
    version: 2,
    company: 5,
    departments: [
      { id: 'a', name: 5, color: {}, responsibility: [], cwd: {}, model: [], permission: 7, repos: 'x', reportDirs: 'y', knowledgeDirs: 'z', trellaBoardId: {}, sessionId: 12, slot: -5, createdAt: null, kind: 'boss', [nasty]: 1 },
      { id: 'b', name: 'B', repos: [{ name: 'n', path: 'p', base: 'main' }, { name: 'n', path: 'q', base: 'main' }], slot: 0 },
      ...Array.from({ length: 150 }, (_, i) => ({ id: `d${i}`, name: `D${i}`, slot: i })),
    ],
  });
  assert.ok(store.departments().length <= 101, 'at most 100 departments are kept, plus the general manager');
  const a = store.byId('a')!;
  assert.deepEqual([a.name, a.color, a.model, a.permission, a.repos, a.reportDirs, a.trellaBoardId, a.sessionId], ['a', 'stone', 'sonnet', 'ask', [], [], null, null]);
  assert.equal(store.byId('b')!.repos.length, 1, 'a repeated repo name is dropped');
  const text = store.problems.join('\n');
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text), 'no control characters in a sentence');
  assert.ok(store.problems.length <= 45 && text.length < 25000, `the sentences stay few and short (${store.problems.length}, ${text.length})`);
  assert.match(text, /version 2/);
  assert.match(text, /only the first 100 were kept/);
});

test('SEC-10: a valid file is left exactly as it is, with no problem and no copy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'office-valid-'));
  dirs.push(dir);
  const file = join(dir, 'affice.json');
  const first = OfficeStore.open({ dataDir: dir, configFile: file, fixture, company: 'Valid', cwdDefault: dir });
  first.create(input('Support'), 'bd_abc123');
  first.setSessionId('support', '9b3e1ff0-4d2a-4f4e-9a52-0c6a2c1b7e11');
  const before = readFileSync(file, 'utf8');
  const lines: string[] = [];
  const store = OfficeStore.open({ dataDir: dir, configFile: file, fixture, company: 'Valid', cwdDefault: dir, log: (line) => lines.push(line) });
  assert.deepEqual(store.problems, []);
  assert.deepEqual(lines, []);
  assert.equal(readFileSync(file, 'utf8'), before, 'not rewritten');
  assert.deepEqual(readdirSync(dir).sort(), ['affice.json']);
  assert.equal(store.byId('support')!.sessionId, '9b3e1ff0-4d2a-4f4e-9a52-0c6a2c1b7e11');
  assert.equal(store.byId('support')!.trellaBoardId, 'bd_abc123');
});

test('SEC-10: the department form refuses a repo base that git would read as an option', () => {
  const { store } = fresh();
  assert.throws(() => store.create({ ...input('Ops'), repos: [{ name: 'r', path: '/tmp/r', base: '--upload-pack=x' }] }, null), /base must not start with a hyphen/);
  assert.ok(store.create({ ...input('Ops'), repos: [{ name: 'r', path: '/tmp/r', base: 'origin/main' }] }, null));
});

// The root of the disk and the home folder are not folders to hand to a manager -------------------------

/** Runs `body` with HOME (and so os.homedir()) pointing at a temporary folder that stands for the user's home. */
function withHome<T>(body: (home: string) => T): T {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'office-home-')));
  dirs.push(home);
  const before = process.env.HOME;
  process.env.HOME = home;
  try {
    return body(home);
  } finally {
    if (before === undefined) delete process.env.HOME;
    else process.env.HOME = before;
  }
}

function openIn(home: string, name: string): { store: OfficeStore; project: string; office: string } {
  const project = join(home, name);
  const office = join(project, 'Office');
  mkdirSync(office, { recursive: true });
  const store = OfficeStore.open({ dataDir: office, configFile: join(office, 'affice.json'), chatDir: join(office, 'chat'), fixture, root: office, company: name, cwdDefault: project });
  return { store, project, office };
}

test('the form refuses report, knowledge and repo folders that are / or the home folder, and says what to do', () => {
  withHome((home) => {
    const { store, project } = openIn(home, 'app');
    const base = { ...input('Ops'), cwd: project };
    assert.throws(() => store.create({ ...base, reportDirs: ['/'] }, null), /A report folder \/ is the root of the disk, which is too broad\. Name a folder inside your project instead/);
    assert.throws(() => store.create({ ...base, reportDirs: [home] }, null), new RegExp(`A report folder ${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is your home folder`));
    assert.throws(() => store.create({ ...base, reportDirs: [`${home}/`] }, null), /your home folder/);
    assert.throws(() => store.create({ ...base, knowledgeDirs: ['docs', '/'] }, null), /A knowledge folder \/ is the root of the disk/);
    assert.throws(() => store.create({ ...base, knowledgeDirs: [home] }, null), /A knowledge folder .* is your home folder/);
    assert.throws(() => store.create({ ...base, repos: [{ name: 'all', path: '/', base: 'main' }] }, null), /A repository path \/ is the root of the disk/);
    assert.throws(() => store.create({ ...base, repos: [{ name: 'home', path: home, base: 'main' }] }, null), /A repository path .* is your home folder/);
    // Knowledge folders start at the project, report folders and repos at the Office folder.
    assert.throws(() => store.create({ ...base, knowledgeDirs: ['..'] }, null), /your home folder/, 'the project folder is directly inside the home folder');
    assert.throws(() => store.create({ ...base, reportDirs: ['../..'] }, null), /your home folder/, 'the Office folder is two folders down');
    assert.equal(store.departments().length, 3, 'nothing was created');

    // Ordinary folders still work: inside the project, inside the home folder, relative, and the project itself.
    const ok = store.create({ ...base, reportDirs: ['reports', join(home, 'elsewhere', 'reports')], knowledgeDirs: ['docs', '.', join(home, 'notes')], repos: [{ name: 'api', path: join(home, 'code', 'api'), base: 'main' }] }, null);
    assert.deepEqual(ok.reportDirs, ['reports', join(home, 'elsewhere', 'reports')]);

    // An update goes through the same check.
    assert.throws(() => store.update(ok.id, { reportDirs: ['/'] }), /root of the disk/);
    assert.throws(() => store.update(ok.id, { knowledgeDirs: [home] }), /home folder/);
    assert.deepEqual(store.byId(ok.id)!.reportDirs, ['reports', join(home, 'elsewhere', 'reports')], 'a refused update changes nothing');
  });
});

test('a folder that is a link to / or to the home folder is as broad as they are', () => {
  withHome((home) => {
    const { store, project } = openIn(home, 'app');
    const toRoot = join(project, 'link-to-root');
    const toHome = join(project, 'link-to-home');
    symlinkSync('/', toRoot);
    symlinkSync(home, toHome);
    const base = { ...input('Ops'), cwd: project };
    assert.throws(() => store.create({ ...base, reportDirs: [toRoot] }, null), /root of the disk/);
    assert.throws(() => store.create({ ...base, knowledgeDirs: [toHome] }, null), /home folder/);
    assert.throws(() => store.create({ ...base, repos: [{ name: 'l', path: 'link-to-home', base: 'main' }] }, null), /home folder/, 'a relative repo path starts at the project folder');
    assert.throws(() => store.create({ ...base, repos: [{ name: 'u', path: '..', base: 'main' }] }, null), /home folder/, 'the project folder is directly inside the home folder');
    assert.ok(store.create({ ...base, repos: [{ name: 'p', path: '.', base: 'main' }, { name: 'o', path: '../app', base: 'main' }] }, null), 'the project itself is a fine repository path');
  });
});

test('an affice.json with / or the home folder as a report, knowledge or repo folder is repaired on load', () => {
  withHome((home) => {
    const project = join(home, 'app');
    const office = join(project, 'Office');
    mkdirSync(office, { recursive: true });
    const file = join(office, 'affice.json');
    const department = (id: string, extra: Record<string, unknown>) => ({
      id, name: id, color: 'sky', responsibility: 'Does the work and reports to the user.', cwd: project, model: 'sonnet', permission: 'ask', slot: id === 'ops' ? 0 : 1, createdAt: '2026-02-02T00:00:00.000Z', ...extra,
    });
    writeFileSync(file, JSON.stringify({
      version: 1,
      company: 'app',
      trellaUrl: 'http://localhost:4174',
      departments: [
        department('ops', {
          reportDirs: ['reports', '/', home],
          knowledgeDirs: ['docs', '..', '/'],
          repos: [{ name: 'a', path: '/', base: 'main' }, { name: 'b', path: join(home, 'code', 'b'), base: 'main' }],
        }),
        department('only-broad', { knowledgeDirs: ['/'], reportDirs: [home] }),
      ],
    }));
    const original = readFileSync(file, 'utf8');
    const lines: string[] = [];
    const store = OfficeStore.open({ dataDir: office, configFile: file, fixture, root: office, company: 'app', cwdDefault: project, log: (line) => lines.push(line) });
    const ops = store.byId('ops')!;
    assert.deepEqual(ops.reportDirs, ['reports']);
    assert.deepEqual(ops.knowledgeDirs, ['docs']);
    assert.deepEqual(ops.repos.map((r) => r.name), ['b']);
    assert.deepEqual(store.byId('only-broad')!.reportDirs, []);
    assert.equal(store.byId('only-broad')!.knowledgeDirs, undefined, 'a list of only broad folders is the same as no list');
    const text = store.problems.join('\n');
    assert.match(text, /ops: .*the root of the disk or your home folder, which is too broad, so they were dropped/);
    assert.match(text, /only-broad: .*too broad, so they were dropped/);
    assert.equal(lines.length, store.problems.length);
    const kept = readdirSync(office).filter((name) => name.startsWith('affice.json.corrupt-'));
    assert.equal(kept.length, 1, 'the original is kept');
    assert.equal(readFileSync(join(office, kept[0]), 'utf8'), original);
    assert.ok(!readFileSync(file, 'utf8').includes('"/"'), 'and the file on disk is the repaired one');
  });
});

// Private modes: what only the user should read ----------------------------------------------------------

const mode = (path: string): number => lstatSync(path).mode & 0o777;

test('affice.json and the chat files are 0600, and the chat folder 0700, whatever the umask would give', { skip: process.platform === 'win32' }, () => {
  const before = process.umask(0o022);
  try {
    withHome((home) => {
      const { store, office } = openIn(home, 'app');
      assert.equal(mode(join(office, 'affice.json')), 0o600, 'the config made at the first save');
      store.appendChat({ id: 'm1', department: 'general', role: 'user', text: 'hello', at: '2026-10-01T09:00:00.000Z', streaming: false });
      assert.equal(mode(join(office, 'chat')), 0o700);
      assert.equal(mode(join(office, 'chat', 'general.jsonl')), 0o600);
      store.create({ ...input('Ops'), cwd: home }, null);
      assert.equal(mode(join(office, 'affice.json')), 0o600, 'the config stays private when it is saved again');
      assert.equal(readdirSync(office).filter((name) => name.endsWith('.tmp')).length, 0);
    });
  } finally {
    process.umask(before);
  }
});
