// The project seam in temporary folders: the Office folder, the recent list, Claude Code's projects from a
// fake config, the folder browser and its routes. AFFICE_HOME and CLAUDE_CONFIG_DIR point at scratch
// folders, so nothing of the real ~/.affice, ~/.claude.json or ~/.claude is read or written.

import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, before, test } from 'node:test';
import { RouteError } from '../../shared/server-api';
import type { OfficeConfig, ProjectSummary } from '../../shared/types';
import type { HostHandle } from '../host';
import { HttpRouter } from '../router';
import {
  CLAUDE_LIMIT,
  RECENT_LIMIT,
  claudeProjects,
  isClaudeWorkspace,
  ensureOffice,
  listFolder,
  listProjects,
  officeLayout,
  recentProjects,
  recordRecent,
  registerProjectRoutes,
} from './index';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'affice-project-')));
const home = join(root, 'affice-home');
const claudeDir = join(root, 'claude-config');
const fakeHome = join(root, 'home');
const savedEnv = { HOME: process.env.HOME, AFFICE_HOME: process.env.AFFICE_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, AFFICE_CLAUDE_JSON: process.env.AFFICE_CLAUDE_JSON };

before(() => {
  // The home folder is a scratch folder too: the folder browser's default and every default path of Claude Code stay inside it.
  mkdirSync(join(fakeHome, 'Projects'), { recursive: true });
  process.env.HOME = fakeHome;
  process.env.AFFICE_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  delete process.env.AFFICE_CLAUDE_JSON;
  mkdirSync(claudeDir, { recursive: true });
});
after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
/** A new folder, with an optional name. */
function folder(name = 'project'): string {
  const dir = join(root, `d${(n += 1)}`, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const summary = (path: string, lastUsedAt: string | null): ProjectSummary => ({ path, name: 'x', hasOffice: true, lastUsedAt, source: 'recent' });
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

// ensureOffice -------------------------------------------------------------------------------------------

test('ensureOffice on a new project creates Office/ with only the lobby general manager', () => {
  const dir = folder('Moonbase');
  const layout = ensureOffice(dir);
  assert.deepEqual(layout, officeLayout(dir));
  assert.equal(layout.name, 'Moonbase');
  assert.equal(layout.trellaWorkspace, join(dir, 'Office'));

  for (const entry of ['affice.json', 'chat', 'reports', '.gitignore']) assert.ok(existsSync(join(dir, 'Office', entry)), entry);
  assert.ok(statSync(layout.chatDir).isDirectory() && statSync(layout.reportsDir).isDirectory());
  assert.match(readFileSync(join(dir, 'Office', '.gitignore'), 'utf8'), /^chat\/$/m);
  assert.ok(!existsSync(join(dir, 'Office', '.agentboard')), 'the Trella service makes .agentboard');
  assert.ok(!existsSync(layout.protocolFile), 'the protocol seam makes PROTOCOL.md');
  assert.ok(!existsSync(`${layout.configFile}.tmp`));

  const config = read(layout.configFile) as OfficeConfig;
  assert.equal(config.version, 1);
  assert.equal(config.company, 'Moonbase');
  assert.deepEqual(config.departments.map((d) => d.id), ['general'], 'no demo departments');
  const general = config.departments[0];
  assert.equal(general.kind, 'lobby');
  assert.equal(general.slot, -1);
  assert.equal(general.cwd, dir, 'works in the project folder');
  assert.equal(general.trellaBoardId, null, 'the general manager has no board of its own');
  assert.equal(general.sessionId, null);
  assert.equal(general.knowledgeDirs, undefined, 'unset: the driver applies the default');
});

test('ensureOffice on an existing Office rewrites nothing and only adds what is missing', () => {
  const dir = folder('Lab');
  const layout = ensureOffice(dir);
  // The user's own edits: a renamed office, a second department, their own .gitignore, a chat file.
  const config = read(layout.configFile) as OfficeConfig;
  config.company = 'My lab';
  config.departments.push({ ...config.departments[0], id: 'support', kind: undefined, name: 'Support', slot: 0 });
  const edited = `${JSON.stringify(config)}\n`;
  writeFileSync(layout.configFile, edited);
  const gitignore = join(layout.officeDir, '.gitignore');
  writeFileSync(gitignore, 'node_modules/\n');
  writeFileSync(join(layout.chatDir, 'general.jsonl'), '{"id":"m1"}\n');
  writeFileSync(join(layout.reportsDir, 'one.md'), '# One\n');

  // A missing piece is created again; nothing else changes.
  rmSync(layout.reportsDir, { recursive: true });
  ensureOffice(dir);
  assert.equal(readFileSync(layout.configFile, 'utf8'), edited, 'affice.json is byte for byte what the user left');
  assert.equal(readFileSync(gitignore, 'utf8'), 'node_modules/\n', 'the .gitignore is the user\'s');
  assert.equal(readFileSync(join(layout.chatDir, 'general.jsonl'), 'utf8'), '{"id":"m1"}\n');
  assert.ok(statSync(layout.reportsDir).isDirectory(), 'the missing reports/ is back');

  // Everything there: a second call changes nothing at all.
  const before = [readFileSync(layout.configFile, 'utf8'), readFileSync(gitignore, 'utf8')];
  ensureOffice(dir);
  assert.deepEqual([readFileSync(layout.configFile, 'utf8'), readFileSync(gitignore, 'utf8')], before);

  // A missing affice.json is made again, named after the folder, without touching the rest.
  rmSync(layout.configFile);
  ensureOffice(dir);
  assert.equal((read(layout.configFile) as OfficeConfig).company, 'Lab');
  assert.equal(readFileSync(join(layout.reportsDir, '..', 'chat', 'general.jsonl'), 'utf8'), '{"id":"m1"}\n');
});

test('ensureOffice refuses what is not a folder, with a sentence', () => {
  assert.throws(() => ensureOffice('relative/path'), /absolute path/);
  assert.throws(() => ensureOffice(join(root, 'does-not-exist')), /is not a folder/);
  const file = join(folder(), 'file.txt');
  writeFileSync(file, 'x');
  assert.throws(() => ensureOffice(file), /is not a folder/);
  const blocked = folder('Blocked');
  writeFileSync(join(blocked, 'Office'), 'a file where the folder should be');
  assert.throws(() => ensureOffice(blocked), /could not create the Office folder in .*Blocked\. Something that is not a folder is in the way\./);
});

// ensureOffice and symbolic links (SEC-04) ---------------------------------------------------------------

/** A victim folder outside the project with one file in it, and its contents to compare afterwards. */
function victim(): { dir: string; file: string; keep: string } {
  const dir = join(root, `victim${(n += 1)}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'keep.txt');
  writeFileSync(file, 'KEEP-ME');
  return { dir, file, keep: 'KEEP-ME' };
}

test('SEC-04 P3: a symlinked affice.json.tmp is not written through, and the office is made normally', () => {
  const project = folder('P3');
  const { file, keep } = victim();
  mkdirSync(join(project, 'Office'));
  symlinkSync(file, join(project, 'Office', 'affice.json.tmp'));
  const layout = ensureOffice(project);
  assert.equal(readFileSync(file, 'utf8'), keep, 'the file the link points at is untouched');
  assert.ok(lstatSync(layout.configFile).isFile() && !lstatSync(layout.configFile).isSymbolicLink(), 'affice.json is a regular file, not a link to the victim');
  assert.equal((read(layout.configFile) as OfficeConfig).company, 'P3');
  assert.ok(lstatSync(join(project, 'Office', 'affice.json.tmp')).isSymbolicLink(), 'the planted link is left as it was');
  assert.deepEqual(readdirSync(layout.officeDir).filter((name) => name.endsWith('.tmp')), ['affice.json.tmp'], 'no temporary file is left behind');
});

test('SEC-04 P4: a dangling .gitignore link does not create the file it points at', () => {
  const project = folder('P4');
  const { dir } = victim();
  const created = join(dir, 'created-by-affice.txt');
  mkdirSync(join(project, 'Office'));
  symlinkSync(created, join(project, 'Office', '.gitignore'));
  const layout = ensureOffice(project);
  assert.ok(!existsSync(created), 'nothing was created through the link');
  assert.ok(lstatSync(join(layout.officeDir, '.gitignore')).isSymbolicLink(), 'the link is left as it was');
  assert.ok(existsSync(layout.configFile) && existsSync(layout.chatDir), 'the rest of the office is made');
});

test('SEC-04 P2: a symlinked Office is refused with a sentence and nothing is created in its target', () => {
  const project = folder('P2');
  const { dir } = victim();
  symlinkSync(dir, join(project, 'Office'));
  assert.throws(() => ensureOffice(project), /The Office folder .* is a symbolic link\. Affice never writes through symbolic links/);
  assert.deepEqual(readdirSync(dir), ['keep.txt'], 'the target folder got no .agentboard, .gitignore, affice.json, chat or reports');
  // Also a link to a folder inside the project, and a dangling one.
  const inside = folder('P2b');
  mkdirSync(join(inside, 'real-office'));
  symlinkSync(join(inside, 'real-office'), join(inside, 'Office'));
  assert.throws(() => ensureOffice(inside), /symbolic link/);
  assert.deepEqual(readdirSync(join(inside, 'real-office')), []);
  const dangling = folder('P2c');
  symlinkSync(join(root, 'nowhere-at-all'), join(dangling, 'Office'));
  assert.throws(() => ensureOffice(dangling), /symbolic link/);
  assert.ok(!existsSync(join(root, 'nowhere-at-all')));
});

test('SEC-04 P5: a symlinked chat or reports folder is refused before a message is written', () => {
  for (const name of ['chat', 'reports']) {
    const project = folder(`P5-${name}`);
    const { dir } = victim();
    mkdirSync(join(project, 'Office'));
    symlinkSync(dir, join(project, 'Office', name));
    assert.throws(() => ensureOffice(project), new RegExp(`Office/${name} folder .* is a symbolic link`));
    assert.deepEqual(readdirSync(dir), ['keep.txt'], `nothing is written into the target of ${name}`);
  }
});

test('SEC-04: a symlinked affice.json is refused, whether it points at a file or at nothing', () => {
  const project = folder('Linked-config');
  const { file, keep } = victim();
  mkdirSync(join(project, 'Office'));
  symlinkSync(file, join(project, 'Office', 'affice.json'));
  assert.throws(() => ensureOffice(project), /Office\/affice\.json .* is a symbolic link/);
  assert.equal(readFileSync(file, 'utf8'), keep);
  rmSync(join(project, 'Office', 'affice.json'));
  symlinkSync(join(root, 'no-such-config.json'), join(project, 'Office', 'affice.json'));
  assert.throws(() => ensureOffice(project), /symbolic link/);
  assert.ok(!existsSync(join(root, 'no-such-config.json')));
});

test('SEC-04: the normal path works, also when the project is reached through a symlink', () => {
  const real = folder('Real');
  const viaLink = join(root, `link-to-real-${(n += 1)}`);
  symlinkSync(real, viaLink);
  const layout = ensureOffice(viaLink);
  assert.ok(existsSync(join(real, 'Office', 'affice.json')), 'the office is made in the real project');
  assert.ok(lstatSync(join(real, 'Office')).isDirectory() && !lstatSync(join(real, 'Office')).isSymbolicLink());
  assert.equal(layout.project, viaLink, 'the layout keeps the path the user gave');
  ensureOffice(viaLink); // a second open is quiet
  const reopened = ensureOffice(real);
  assert.equal((read(reopened.configFile) as OfficeConfig).company, basename(viaLink), 'named after the folder the user gave, as before');
});

// The recent list ----------------------------------------------------------------------------------------

test('the recent list is newest first, at most 12, and drops folders that are gone', () => {
  rmSync(home, { recursive: true, force: true });
  assert.deepEqual(recentProjects(), [], 'no file yet');
  const made = Array.from({ length: 14 }, (_, i) => folder(`recent-${i}`));
  made.forEach((dir, i) => recordRecent(summary(dir, `2026-10-19T10:${String(i).padStart(2, '0')}:00.000Z`)));

  const list = recentProjects();
  assert.equal(RECENT_LIMIT, 12);
  assert.equal(list.length, 12);
  assert.deepEqual(list.map((p) => p.path), made.slice(2).reverse(), 'the two oldest were pushed out');
  assert.ok(list.every((p) => p.source === 'recent'));
  assert.equal(read(join(home, 'projects.json')).length, 12, 'the file keeps no more than the limit');

  // Opening an older one again moves it to the front instead of adding a second row.
  recordRecent(summary(made[5], '2026-10-19T12:00:00.000Z'));
  assert.deepEqual(recentProjects().map((p) => p.path).slice(0, 2), [made[5], made[13]]);
  assert.equal(recentProjects().filter((p) => p.path === made[5]).length, 1);

  // A folder that was deleted drops out of the list.
  rmSync(made[13], { recursive: true });
  assert.ok(!recentProjects().some((p) => p.path === made[13]));
  assert.equal(recentProjects()[0].path, made[5]);
});

test('the recent list says whether a project has an Office and uses its name', () => {
  rmSync(home, { recursive: true, force: true });
  const plain = folder('Plain');
  const withOffice = folder('Folder name');
  const layout = ensureOffice(withOffice);
  const config = read(layout.configFile) as OfficeConfig;
  config.company = 'Company name';
  writeFileSync(layout.configFile, JSON.stringify(config));
  recordRecent(summary(plain, '2026-10-19T10:00:00.000Z'));
  recordRecent(summary(withOffice, '2026-10-19T11:00:00.000Z'));
  const [first, second] = recentProjects();
  assert.deepEqual([first.name, first.hasOffice], ['Company name', true]);
  assert.deepEqual([second.name, second.hasOffice], ['Plain', false]);
});

test('a damaged recent file is an empty list, not an error', () => {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'projects.json'), '{ not json');
  assert.deepEqual(recentProjects(), []);
  writeFileSync(join(home, 'projects.json'), JSON.stringify({ path: '/x' }));
  assert.deepEqual(recentProjects(), []);
});

// Claude Code's projects -----------------------------------------------------------------------------------

/** The folder name Claude Code keeps transcripts in. */
const encode = (path: string) => path.replace(/[^a-zA-Z0-9]/g, '-');

function transcript(path: string, name: string, modified: string): void {
  const dir = join(claudeDir, 'projects', encode(path));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, '{"type":"user"}\n');
  utimesSync(file, new Date(modified), new Date(modified));
}

test('Claude Code projects: existing folders only, no worktrees, newest transcript first, none last', async () => {
  const older = folder('older');
  const newer = folder('newer');
  const spaced = folder('with space.and dots');
  const noTranscripts = folder('quiet');
  const alsoQuiet = folder('quiet-too');
  const gone = join(root, 'removed-project');
  const worktree = join(folder('main'), '.claude', 'worktrees', 'feature');
  mkdirSync(worktree, { recursive: true });

  transcript(older, 'a.jsonl', '2026-10-01T10:00:00.000Z');
  transcript(older, 'b.jsonl', '2026-10-02T10:00:00.000Z');
  transcript(newer, 'a.jsonl', '2026-10-10T10:00:00.000Z');
  transcript(newer, 'notes.txt', '2026-10-30T10:00:00.000Z'); // not a transcript
  transcript(spaced, 'a.jsonl', '2026-10-05T10:00:00.000Z'); // the folder name replaces space and dot too
  transcript(worktree, 'a.jsonl', '2026-10-31T10:00:00.000Z');

  const file = join(claudeDir, '.claude.json');
  const fake = {
    userID: 'must-never-be-read',
    oauthAccount: { emailAddress: 'must-never-be-read@example.com' },
    projects: {
      [older]: { allowedTools: [], lastCost: 1 },
      [noTranscripts]: {},
      [gone]: {},
      [worktree]: {},
      [newer]: { mcpServers: { secret: { env: { TOKEN: 'must-never-be-read' } } } },
      [spaced]: {},
      [alsoQuiet]: {},
      'relative/key': {},
    },
  };
  writeFileSync(file, JSON.stringify(fake));
  const before = readFileSync(file);

  const list = await claudeProjects();
  assert.deepEqual(
    list.map((p) => p.path),
    [newer, spaced, older, noTranscripts, alsoQuiet],
    'newest first by the newest .jsonl, then the ones without transcripts in the order of the file; the missing, the worktree and the relative key are gone',
  );
  assert.ok(list.every((p) => p.source === 'claude'));
  assert.equal(list[0].lastUsedAt, '2026-10-10T10:00:00.000Z');
  assert.equal(list[2].lastUsedAt, '2026-10-02T10:00:00.000Z', 'the newest of two transcripts');
  assert.equal(list[3].lastUsedAt, null);
  assert.equal(list[0].name, 'newer');
  assert.ok(list.every((p) => !p.hasOffice));
  assert.ok(Buffer.from(JSON.stringify(list)).toString().indexOf('must-never-be-read') < 0, 'nothing but the keys leaves the file');
  assert.ok(readFileSync(file).equals(before), 'the config file is read only');
  assert.ok(CLAUDE_LIMIT >= 5);

  // A project that has an Office says so.
  ensureOffice(older);
  assert.equal((await claudeProjects()).find((p) => p.path === older)?.hasOffice, true);
});

test('Claude Code projects: not the home folder itself, not the root, not the desktop app\'s scratch workspaces', async () => {
  const real = folder('real-project');
  const insideHome = join(fakeHome, 'Projects', 'mine');
  mkdirSync(insideHome, { recursive: true });
  const named = folder('Claude notes'); // a real project that only has the word in its name
  const scratchMac = join(fakeHome, 'Library', 'Application Support', 'Claude', 'scratch-workspaces', 'aaaa-1111', 'bbbb-2222', 'scratch-9f3');
  const sessionsMac = join(fakeHome, 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions', 'cccc-3333');
  const linuxConfig = join(fakeHome, '.config', 'Claude', 'scratch-workspaces', 'dddd-4444');
  const bareScratch = join(folder('elsewhere'), 'scratch-workspaces', 'eeee-5555');
  for (const dir of [scratchMac, sessionsMac, linuxConfig, bareScratch]) mkdirSync(dir, { recursive: true });
  const link = join(root, 'link-to-home');
  symlinkSync(fakeHome, link);

  writeFileSync(
    join(claudeDir, '.claude.json'),
    JSON.stringify({ projects: { [fakeHome]: {}, [`${fakeHome}/`]: {}, [link]: {}, '/': {}, [scratchMac]: {}, [sessionsMac]: {}, [linuxConfig]: {}, [bareScratch]: {}, [real]: {}, [insideHome]: {}, [named]: {} } }),
  );
  assert.deepEqual(
    (await claudeProjects()).map((p) => p.path).sort(),
    [real, insideHome, named].sort(),
    'real projects stay, also inside the home folder; the home folder, a link to it, the root and the scratch workspaces go',
  );
  // The scratch folders were made inside the fake home: leave it as it was for the folder browser tests.
  for (const dir of [join(fakeHome, 'Library'), join(fakeHome, '.config'), insideHome]) rmSync(dir, { recursive: true, force: true });
  assert.equal(isClaudeWorkspace(scratchMac), true);
  assert.equal(isClaudeWorkspace('C:\\Users\\ada\\AppData\\Roaming\\Claude\\scratch-workspaces\\x'), true);
  assert.equal(isClaudeWorkspace('/Users/ada/code/.claude/worktrees/feature'), true);
  assert.equal(isClaudeWorkspace('/Users/ada/code/Claude notes'), false);
  assert.equal(isClaudeWorkspace('/Users/ada/Library/Application Support/Other/Claude'), false);
});

test('the picker list is the recent projects, then Claude Code\'s that are not already in it', async () => {
  rmSync(home, { recursive: true, force: true });
  const a = folder('a');
  const b = folder('b');
  const c = folder('c');
  writeFileSync(join(claudeDir, '.claude.json'), JSON.stringify({ projects: { [a]: {}, [b]: {}, [c]: {} } }));
  transcript(a, 's.jsonl', '2026-10-01T10:00:00.000Z');
  transcript(b, 's.jsonl', '2026-10-03T10:00:00.000Z');
  transcript(c, 's.jsonl', '2026-10-02T10:00:00.000Z');
  recordRecent(summary(c, '2026-10-19T09:00:00.000Z'));

  const list = await listProjects();
  assert.deepEqual(list.map((p) => [p.path, p.source]), [[c, 'recent'], [b, 'claude'], [a, 'claude']]);
});

test('no Claude Code config, a damaged one, or a missing projects map is an empty list', async () => {
  const file = join(claudeDir, '.claude.json');
  rmSync(file, { force: true });
  assert.deepEqual(await claudeProjects(), []);
  writeFileSync(file, '{ not json');
  assert.deepEqual(await claudeProjects(), []);
  writeFileSync(file, JSON.stringify({ projects: ['/x'] }));
  assert.deepEqual(await claudeProjects(), []);
  writeFileSync(file, JSON.stringify({ numStartups: 3 }));
  assert.deepEqual(await claudeProjects(), []);
});

test('AFFICE_CLAUDE_JSON moves the config file alone', async () => {
  const project = folder('elsewhere');
  const other = join(folder('fake-home'), '.claude.json');
  writeFileSync(other, JSON.stringify({ projects: { [project]: {} } }));
  process.env.AFFICE_CLAUDE_JSON = other;
  try {
    assert.deepEqual((await claudeProjects()).map((p) => p.path), [project]);
  } finally {
    delete process.env.AFFICE_CLAUDE_JSON;
  }
});

// The folder browser ---------------------------------------------------------------------------------------

test('listFolder lists folders only, with the Office badge, and never a file name', async () => {
  const dir = folder('browse');
  mkdirSync(join(dir, 'Beta'));
  mkdirSync(join(dir, 'alpha'));
  mkdirSync(join(dir, '.hidden'));
  mkdirSync(join(dir, '.also-hidden'));
  mkdirSync(join(dir, 'with-office'));
  ensureOffice(join(dir, 'with-office'));
  writeFileSync(join(dir, 'secret-notes.txt'), 'TOP SECRET CONTENT');
  writeFileSync(join(dir, 'passwords.md'), 'hunter2');
  symlinkSync(join(dir, 'alpha'), join(dir, 'link-to-folder'));
  symlinkSync(join(dir, 'secret-notes.txt'), join(dir, 'link-to-file'));

  const listing = await listFolder(dir);
  assert.equal(listing.path, dir);
  assert.equal(listing.parent, join(dir, '..').replace(/\/$/, ''));
  assert.deepEqual(listing.folders.map((f) => f.name), ['alpha', 'Beta', 'link-to-folder', 'with-office'], 'by name, no hidden folders, no files, a link to a folder counts');
  assert.deepEqual(listing.folders.map((f) => f.hasOffice), [false, false, false, true]);
  assert.equal(listing.folders[0].path, join(dir, 'alpha'));
  const text = JSON.stringify(listing);
  for (const leaked of ['secret-notes', 'passwords', 'TOP SECRET', 'hunter2', 'link-to-file']) assert.ok(!text.includes(leaked), leaked);

  // The hidden flag lists them too, after the others.
  const all = await listFolder(dir, { hidden: true });
  assert.deepEqual(all.folders.map((f) => f.name), ['alpha', 'Beta', 'link-to-folder', 'with-office', '.also-hidden', '.hidden']);
});

test('listFolder has no parent at the file system root, and says why a path cannot be listed', async () => {
  assert.equal((await listFolder('/')).parent, null);
  const dir = folder('normalised');
  assert.equal((await listFolder(join(dir, 'x', '..'))).path, dir, 'a path is normalised');

  await assert.rejects(listFolder('relative'), (e: unknown) => e instanceof RouteError && e.status === 400 && /absolute/.test(e.message));
  await assert.rejects(listFolder(join(root, 'no-such-folder')), (e: unknown) => e instanceof RouteError && e.status === 404 && /does not exist/.test(e.message));
  const file = join(folder(), 'plain.txt');
  writeFileSync(file, 'x');
  await assert.rejects(listFolder(file), (e: unknown) => e instanceof RouteError && e.status === 400 && /is not a folder/.test(e.message));
});

test('listFolder answers a readable error for a folder it may not open', { skip: process.getuid?.() === 0 ? 'root can read everything' : false }, async () => {
  const locked = folder('locked');
  mkdirSync(join(locked, 'inside'));
  chmodSync(locked, 0o000);
  try {
    await assert.rejects(listFolder(locked), (e: unknown) => e instanceof RouteError && e.status === 403 && /cannot read .*locked \(permission denied\)\. Pick another folder\./.test(e.message));
  } finally {
    chmodSync(locked, 0o755);
  }
});

// The routes -----------------------------------------------------------------------------------------------

test('GET /api/projects and GET /api/fs answer through the router', async () => {
  rmSync(home, { recursive: true, force: true });
  const project = folder('routed');
  const sub = folder('browse-routes');
  mkdirSync(join(sub, 'one'));
  mkdirSync(join(sub, '.dot'));
  recordRecent(summary(project, '2026-10-19T10:00:00.000Z'));
  writeFileSync(join(claudeDir, '.claude.json'), JSON.stringify({ projects: {} }));

  const router = new HttpRouter();
  registerProjectRoutes(router, {} as HostHandle);
  const server = createServer((req, res) => {
    void router.handle(req, res).then((handled) => {
      if (!handled) res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const projects = (await (await fetch(`${base}/api/projects`)).json()) as ProjectSummary[];
    assert.deepEqual(projects.map((p) => [p.path, p.source]), [[project, 'recent']]);

    const plain = await (await fetch(`${base}/api/fs?path=${encodeURIComponent(sub)}`)).json();
    assert.deepEqual(plain.folders.map((f: { name: string }) => f.name), ['one']);
    const hidden = await (await fetch(`${base}/api/fs?path=${encodeURIComponent(sub)}&hidden=1`)).json();
    assert.deepEqual(hidden.folders.map((f: { name: string }) => f.name), ['one', '.dot']);

    const noPath = await fetch(`${base}/api/fs`);
    assert.equal(noPath.status, 200, 'no path: the home folder');
    const homeListing = await noPath.json();
    assert.equal(homeListing.path, fakeHome);
    assert.deepEqual(homeListing.folders.map((f: { name: string }) => f.name), ['Projects']);
    const bad = await fetch(`${base}/api/fs?path=${encodeURIComponent(join(sub, 'missing'))}`);
    assert.equal(bad.status, 404);
    assert.match((await bad.json()).error, /does not exist/);
    assert.equal((await fetch(`${base}/api/fs?path=relative`)).status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('what only the user should read is private: affice.json 0600, the chat folder 0700, ~/.affice 0700 and projects.json 0600', { skip: process.platform === 'win32' }, () => {
  const mode = (path: string): number => lstatSync(path).mode & 0o777;
  const before = process.umask(0o022);
  const savedHome = process.env.AFFICE_HOME;
  try {
    const fresh = join(root, `private-home-${(n += 1)}`, 'nested', '.affice');
    process.env.AFFICE_HOME = fresh;
    const project = folder('private');
    const layout = ensureOffice(project);
    assert.equal(mode(layout.configFile), 0o600, 'Office/affice.json');
    assert.equal(mode(layout.chatDir), 0o700, 'Office/chat');
    // What the user may share stays readable: the Office folder itself, the reports folder, the protocol and the ignore file.
    assert.equal(mode(layout.officeDir), 0o755, 'Office/ is not made private');
    assert.equal(mode(layout.reportsDir), 0o755, 'Office/reports is not made private');
    assert.equal(mode(join(layout.officeDir, '.gitignore')), 0o644);

    recordRecent(summary(project, '2026-10-19T10:00:00.000Z'));
    assert.equal(mode(fresh), 0o700, '~/.affice');
    assert.equal(mode(join(fresh, 'projects.json')), 0o600, 'projects.json');
    recordRecent(summary(project, '2026-10-19T11:00:00.000Z'));
    assert.equal(mode(join(fresh, 'projects.json')), 0o600, 'and again after it is replaced');
  } finally {
    process.umask(before);
    process.env.AFFICE_HOME = savedHome;
  }
});
