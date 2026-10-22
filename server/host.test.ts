import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { RouteError, type OfficeLayout } from '../shared/server-api';
import type { AgentPresence, ClaudeStatus, OfficeConfig, ServerEvent, SessionState } from '../shared/types';
import type { CliDriverOptions, ManagerSession } from './claude/driver';
import { AppHost, NO_PROJECT } from './host';
import { parseCommand } from './office';
import { ensureOffice } from './project/index';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'affice-host-')));
// The recent projects go to a scratch folder, never to the real ~/.affice.
process.env.AFFICE_HOME = join(root, 'home', '.affice');
after(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
function project(name: string): string {
  const dir = join(root, `p${(n += 1)}`, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const ready: ClaudeStatus = {
  installed: true, path: '/usr/local/bin/claude', version: '2.1.287', minVersion: '2.1.211', tooOld: false,
  signedIn: true, authMethod: 'claude.ai', signingIn: false, loginUrl: null, error: null,
};

/** A session without a process. */
class FakeSession extends EventEmitter implements ManagerSession {
  disposed = false;
  constructor(readonly department: string, readonly options: CliDriverOptions) {
    super();
  }
  start(): void {}
  send(): void {}
  interrupt(): void {}
  async stop(): Promise<void> {}
  async setBypass(): Promise<void> {}
  snapshot(): { state: SessionState; agents: AgentPresence[] } {
    return { state: { department: this.department, status: 'off', bypass: false, sessionId: null, model: null, startedAt: null, error: null }, agents: [] };
  }
  refresh(): void {}
  setWaiting(): void {}
  ownerOf(): string {
    return `manager:${this.department}`;
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.emit('event', { type: 'session.state', state: { ...this.snapshot().state } } satisfies ServerEvent);
  }
}

function host() {
  const sessions: FakeSession[] = [];
  const calls: string[] = [];
  const events: ServerEvent[] = [];
  const h = new AppHost({
    officeUrl: 'http://127.0.0.1:5999',
    log: () => undefined,
    createSession: (department, _lookup, options) => {
      const session = new FakeSession(department.id, options);
      sessions.push(session);
      return session;
    },
    createBoard: () => async () => ({ boardId: null, error: null }),
    seams: {
      claudeStatus: async () => ({ ...ready }),
      startTrella: async (layout: OfficeLayout) => {
        calls.push(`start ${layout.project}`);
        return { url: 'http://127.0.0.1:4999' };
      },
      stopTrella: async (layout: OfficeLayout) => {
        calls.push(`stop ${layout.project}`);
      },
    },
  });
  h.on('event', (event: ServerEvent) => events.push(event));
  return { host: h, sessions, calls, events };
}

const last = <T extends ServerEvent['type']>(events: ServerEvent[], type: T) =>
  events.filter((e): e is Extract<ServerEvent, { type: T }> => e.type === type).at(-1);

test('the host starts with no project: an empty office, and Claude Code checked', async () => {
  const { host: h, events } = host();
  await h.start({ project: null });
  assert.equal(h.appState().project, null);
  assert.deepEqual(h.appState().claude, ready);
  assert.equal(last(events, 'app.state')?.state.claude.version, '2.1.287');
  assert.deepEqual(h.officeSnapshot().config.departments, []);
  assert.equal(h.layout(), null);
});

test('opening a project creates Office/ with affice.json named after the folder, and builds its office', async () => {
  const { host: h, sessions, calls, events } = host();
  await h.start({ project: null });
  const dir = project('Moonbase');
  const summary = await h.openProject(dir);

  const office = join(dir, 'Office');
  for (const path of ['affice.json', 'chat', 'reports', '.gitignore']) assert.ok(existsSync(join(office, path)), path);
  assert.match(readFileSync(join(office, '.gitignore'), 'utf8'), /^chat\/$/m);
  const config = JSON.parse(readFileSync(join(office, 'affice.json'), 'utf8')) as OfficeConfig;
  assert.equal(config.company, 'Moonbase');
  assert.ok(config.departments.every((d) => d.cwd === dir), 'departments work in the project folder');

  assert.equal(summary.name, 'Moonbase');
  assert.equal(h.appState().project?.path, dir);
  assert.deepEqual(h.appState().recent.map((p) => p.path), [dir]);
  assert.deepEqual(calls, [`start ${dir}`]);
  const snapshot = h.officeSnapshot();
  assert.deepEqual(snapshot.config.departments.map((d) => d.id), ['general']);
  assert.equal(snapshot.config.company, 'Moonbase', 'the lobby sign shows the project name');
  assert.equal(snapshot.config.trellaUrl, 'http://127.0.0.1:4999', 'the Trella service address wins');

  assert.deepEqual(sessions.map((s) => s.department), ['general']);
  assert.equal(sessions[0].options.layout.officeDir, office);
  assert.equal(sessions[0].options.layout.trellaWorkspace, office);
  assert.equal(sessions[0].options.claudeBin, '/usr/local/bin/claude');
  assert.equal(sessions[0].options.forwardSubagentText, true);

  const order = events.map((e) => e.type).filter((t) => t === 'app.state' || t === 'office.state');
  assert.deepEqual(order.slice(-2), ['app.state', 'office.state'], 'app.state, then the new office');
  assert.equal(last(events, 'office.state')?.snapshot.config.company, 'Moonbase');

  // An existing affice.json is kept as it is.
  writeFileSync(join(office, 'affice.json'), JSON.stringify({ ...config, company: 'Renamed' }));
  ensureOffice(dir);
  assert.equal((JSON.parse(readFileSync(join(office, 'affice.json'), 'utf8')) as OfficeConfig).company, 'Renamed');
});

test('closing stops the sessions and the Trella service, and returns to no project', async () => {
  const { host: h, sessions, calls, events } = host();
  const dir = project('Lab');
  await h.openProject(dir);
  await h.closeProject();

  assert.ok(sessions.length === 1 && sessions.every((s) => s.disposed), 'every session stopped');
  assert.deepEqual(calls, [`start ${dir}`, `stop ${dir}`]);
  assert.equal(h.appState().project, null);
  assert.equal(h.layout(), null);
  assert.equal(last(events, 'app.state')?.state.project, null);
  assert.deepEqual(last(events, 'office.state')?.snapshot.config.departments, []);
  assert.ok(events.some((e) => e.type === 'session.state' && e.state.department === 'general'), 'the sessions going off still reach the clients');
});

test('switching closes the open project, then opens the other; the open one again changes nothing', async () => {
  const { host: h, sessions, calls } = host();
  const a = project('Alpha');
  const b = project('Beta');
  await h.openProject(a);
  await h.openProject(a);
  assert.equal(sessions.filter((s) => s.disposed).length, 0, 'reopening the open project keeps its sessions');

  await h.openProject(b);
  assert.deepEqual(calls, [`start ${a}`, `stop ${a}`, `start ${b}`]);
  assert.ok(sessions.slice(0, 1).every((s) => s.disposed));
  assert.ok(sessions.slice(1).every((s) => !s.disposed && s.options.layout.project === b));
  assert.equal(h.appState().project?.name, 'Beta');
  assert.deepEqual(h.appState().recent.map((p) => p.name).slice(0, 2), ['Beta', 'Alpha'], 'newest first');
});

test('a switch to a folder that does not exist leaves no project open, and says so', async () => {
  const { host: h, events } = host();
  await h.openProject(project('Gamma'));
  await h.handle({ type: 'project.open', path: join(root, 'missing') });
  assert.equal(h.appState().project, null);
  assert.match(last(events, 'error')?.message ?? '', /is not a folder/);
  assert.equal(last(events, 'app.state')?.state.project, null);
  assert.deepEqual(last(events, 'office.state')?.snapshot.config.departments, []);
});

test('with no project open, office commands and routes answer a clear error', async () => {
  const { host: h, events } = host();
  await h.handle({ type: 'chat.send', department: 'engineering', text: 'Hello' });
  assert.deepEqual(last(events, 'error'), { type: 'error', department: null, message: NO_PROJECT });

  const is409 = (error: unknown) => error instanceof RouteError && error.status === 409 && error.message === NO_PROJECT;
  assert.throws(() => h.requireOffice(), is409);
  assert.throws(() => h.paths.root, is409);
  assert.throws(() => h.departments.byId('engineering'), is409);

  await h.handle({ type: 'project.open', path: 'relative/folder' });
  assert.match(last(events, 'error')?.message ?? '', /absolute path/);
  assert.equal(h.appState().project, null);
});

test('the socket parses the app commands', () => {
  assert.deepEqual(parseCommand(JSON.stringify({ type: 'project.open', path: '/work/p' })), { type: 'project.open', path: '/work/p' });
  assert.match(String(parseCommand(JSON.stringify({ type: 'project.open' }))), /needs a path/);
  for (const type of ['project.close', 'claude.refresh', 'claude.login', 'claude.cancelLogin']) {
    assert.deepEqual(parseCommand(JSON.stringify({ type })), { type });
  }
});

test('AFFICE_PROJECT opens that project at start', async () => {
  const { host: h } = host();
  const dir = project('Delta');
  process.env.AFFICE_PROJECT = dir;
  try {
    await h.start();
  } finally {
    delete process.env.AFFICE_PROJECT;
  }
  assert.equal(h.layout()?.project, dir);
  assert.equal(h.appState().project?.name, 'Delta');
  await h.closeProject();
});

// SEC-04 and SEC-10 reach the user as sentences ----------------------------------------------------------

test('a project whose Office is a symbolic link is refused with a sentence, and nothing is created behind the link', async () => {
  const { host: h, events, calls } = host();
  const dir = project('Linked');
  const behind = join(root, `behind-${(n += 1)}`);
  mkdirSync(behind);
  symlinkSync(behind, join(dir, 'Office'));
  await h.handle({ type: 'project.open', path: dir });
  const error = last(events, 'error');
  assert.match(error?.message ?? '', /The Office folder .* is a symbolic link\. Affice never writes through symbolic links/);
  assert.equal(h.appState().project, null, 'no project is open');
  assert.deepEqual(readdirSync(behind), [], 'nothing was created in the folder behind the link');
  assert.deepEqual(calls, [], 'no Trella service was started for it');
});

test('an affice.json with bad fields opens repaired, and the user is told what was changed', async () => {
  const { host: h, events, sessions } = host();
  const dir = project('Repaired');
  const layout = ensureOffice(dir);
  const config = JSON.parse(readFileSync(layout.configFile, 'utf8')) as OfficeConfig;
  const general = config.departments[0];
  writeFileSync(layout.configFile, JSON.stringify({
    ...config,
    departments: [{ ...general, model: '--dangerously-skip-permissions', sessionId: '--dangerously-skip-permissions', permission: 'bypassPermissions' }],
  }));
  await h.openProject(dir);
  const told = events.filter((e): e is Extract<ServerEvent, { type: 'error' }> => e.type === 'error').map((e) => e.message).join('\n');
  assert.match(told, /office files needed repairs/);
  assert.match(told, /the model --dangerously-skip-permissions is not an alias/);
  assert.match(told, /kept as affice\.json\.corrupt-/);
  const repaired = h.officeSnapshot().config.departments[0];
  assert.deepEqual([repaired.model, repaired.sessionId, repaired.permission], ['sonnet', null, 'ask']);
  assert.deepEqual(sessions.map((s) => s.department), ['general'], 'the office still opens');
});

test('a corrupt affice.json does not stop the project from opening', async () => {
  const { host: h, events } = host();
  const dir = project('Corrupt');
  const layout = ensureOffice(dir);
  writeFileSync(layout.configFile, '{"departments": [');
  await h.openProject(dir);
  assert.equal(h.appState().project?.path, dir);
  assert.deepEqual(h.officeSnapshot().config.departments.map((d) => d.id), ['general']);
  assert.match(last(events, 'error')?.message ?? '', /could not be used \(it is not valid JSON/);
  assert.equal(readdirSync(layout.officeDir).filter((name) => name.startsWith('affice.json.corrupt-')).length, 1);
});
