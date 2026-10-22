import { AGENT_TOKEN_ENV, agentToken } from '../auth';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { OfficeLayout } from '../../shared/server-api';
import { GENERAL_ID } from '../../shared/types';
import {
  DEFAULT_COMPANY,
  GENERAL_TOOLS,
  knowledgeSources,
  managerActor,
  managerMcpServers,
  managerPrompt,
  PROTOCOL_TEMPLATE,
  protocolText,
  writeProtocol,
  type McpRuntime,
  type PromptDepartment,
} from './index';

const dirs: string[] = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function project(): { layout: OfficeLayout; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'protocol-'));
  dirs.push(dir);
  const officeDir = join(dir, 'Office');
  return {
    dir,
    layout: {
      project: dir,
      name: 'Atlas',
      officeDir,
      configFile: join(officeDir, 'affice.json'),
      chatDir: join(officeDir, 'chat'),
      reportsDir: join(officeDir, 'reports'),
      protocolFile: join(officeDir, 'PROTOCOL.md'),
      trellaWorkspace: officeDir,
    },
  };
}

/** A Trella CLI that counts as built: the file and dist/index.js beside it. */
function fakeTrella(built = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'protocol-trella-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'trella.js'), '');
  if (built) {
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'dist', 'index.js'), '');
  }
  return join(dir, 'bin', 'trella.js');
}

function runtime(overrides: Partial<McpRuntime> = {}): McpRuntime {
  return {
    officeUrl: 'http://127.0.0.1:5331',
    nodeBin: '/usr/bin/node',
    tsxCli: '/affice/node_modules/tsx/dist/cli.mjs',
    approvalsScript: '/affice/server/claude/approvals-mcp.ts',
    trellaCli: fakeTrella(),
    log: () => undefined,
    ...overrides,
  };
}

const engineering: PromptDepartment = { id: 'engineering', name: 'Engineering', responsibility: 'Build the product.', trellaBoardId: 'bd_eng' };
const general: PromptDepartment = { id: GENERAL_ID, kind: 'lobby', name: 'General manager', responsibility: 'Answer my general questions.', trellaBoardId: 'bd_general' };

// What must never appear in what Affice ships to every user.
const NOT_GENERIC = new RegExp(`Safhe|DEV-|SAF-|founder|Milad|Darkube|Management/|WORK-PROTOCOL|agent-reports|[${String.fromCharCode(0x600)}-${String.fromCharCode(0x6ff)}]`, 'i');
const DASH = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);

test('writeProtocol writes Office/PROTOCOL.md once and keeps what the user edited', () => {
  const { layout } = project();
  assert.throws(() => readFileSync(layout.protocolFile, 'utf8'), /ENOENT/);
  writeProtocol(layout);
  assert.equal(readFileSync(layout.protocolFile, 'utf8'), PROTOCOL_TEMPLATE);

  writeFileSync(layout.protocolFile, '# Our rules\n\nAlways ask Marketing first.\n');
  writeProtocol(layout);
  assert.equal(readFileSync(layout.protocolFile, 'utf8'), '# Our rules\n\nAlways ask Marketing first.\n');

  // An emptied file is the user's too: it is not rewritten, and the prompts fall back to the template.
  writeFileSync(layout.protocolFile, '');
  writeProtocol(layout);
  assert.equal(readFileSync(layout.protocolFile, 'utf8'), '');
  assert.equal(protocolText(layout), PROTOCOL_TEMPLATE.trim());
});

test('the protocol is generic, short, and covers the card protocol, reports, decisions, the project and colleagues', () => {
  assert.ok(!NOT_GENERIC.test(PROTOCOL_TEMPLATE), 'no Safhe, DEV-, SAF-, founder, Persian or deploy wording');
  assert.ok(!DASH.test(PROTOCOL_TEMPLATE), 'no em or en dashes');
  assert.ok(PROTOCOL_TEMPLATE.split('\n').length <= 70, 'about one page');
  for (const needle of [
    'Claim the card',
    'Comment on the card',
    'move the card to Review',
    'task/ENG-12-short-slug',
    'Card: ENG-12',
    'description of a subagent',
    'Office/reports/YYYY-MM-DD-<KEY>-<topic>.md',
    'label the card `decision`',
    'recommendation',
    'Do not run destructive git commands',
    'Commit only when the user asked',
    'ask_manager',
    'two managers deep',
    'approvals off',
    'Do not hand your own work back and forth',
    'Never invent progress',
  ]) {
    assert.ok(PROTOCOL_TEMPLATE.includes(needle), needle);
  }
});

test('a department manager prompt names the project, the company, the card protocol, its tools and its Trella identity', () => {
  const { layout } = project();
  writeProtocol(layout);
  const prompt = managerPrompt(layout, engineering, 'Acme Studio');
  assert.match(prompt, /^You are the manager of the Engineering department of Acme Studio\./);
  assert.match(prompt, /Your responsibility: Build the product\./);
  assert.ok(prompt.includes(`The project is Atlas, in ${layout.project}.`));
  assert.ok(prompt.includes(layout.protocolFile), 'points at PROTOCOL.md');
  assert.match(prompt, /Trella board \(bd_eng\)/);
  assert.match(prompt, /mcp__trella__\*/);
  for (const tool of ['mcp__office__list_departments', 'mcp__office__office_status', 'mcp__office__ask_manager']) assert.ok(prompt.includes(tool), tool);
  assert.match(prompt, /identity on Trella is agent:engineering-manager, name "Engineering manager"/);
  assert.match(prompt, /card key \(ENG-12\) in every subagent description/);
  assert.match(prompt, /Reply in the language the user writes in\. Keep replies short/);
  assert.ok(prompt.endsWith(PROTOCOL_TEMPLATE.trim()), 'the protocol text is the end of the prompt');
  assert.ok(!NOT_GENERIC.test(prompt), 'no Safhe, DEV-, SAF-, founder, Persian or deploy wording');
  assert.ok(!DASH.test(prompt));
  assert.ok(!/What you read for context/.test(prompt), 'no knowledge folders, no line about them');
  assert.match(managerPrompt(layout, engineering, null), /of Your office\./);
  assert.equal(DEFAULT_COMPANY, 'Your office');
});

test("the prompt carries the office's PROTOCOL.md as the user edited it, and works without the file", () => {
  const { layout } = project();
  assert.ok(managerPrompt(layout, engineering, 'Acme').endsWith(PROTOCOL_TEMPLATE.trim()), 'no file yet: the template');
  mkdirSync(layout.officeDir, { recursive: true });
  writeFileSync(layout.protocolFile, '# Our rules\n\nAsk Marketing before you ship.\n');
  const edited = managerPrompt(layout, engineering, 'Acme');
  assert.ok(edited.endsWith('# Our rules\n\nAsk Marketing before you ship.'));
  assert.ok(!edited.includes('Work found without a card'));
  assert.ok(managerPrompt(layout, engineering, 'Acme', { protocol: 'Only this.' }).endsWith('Only this.'));
});

test('the general manager prompt keeps its behaviors, says what it knows and where, and does not write to the knowledge folders', () => {
  const { layout, dir } = project();
  mkdirSync(layout.officeDir, { recursive: true });
  writeFileSync(join(dir, 'README.md'), '# Atlas\n');
  const prompt = managerPrompt(layout, general, 'Acme Studio');
  assert.match(prompt, /^You are the general manager of Acme Studio\. You sit at the reception desk in the lobby of the office,/);
  assert.ok(prompt.includes(`the file ${join(dir, 'README.md')}`), 'the project README');
  assert.ok(prompt.includes(`the office folder ${layout.officeDir}`));
  assert.match(prompt, /Every Trella board through the Trella tools \(your own board is bd_general\)/);
  assert.match(prompt, /ask_manager instead of doing the department's work yourself/);
  // The office tools are named in full, called directly, and the first move for a department question.
  assert.match(prompt, /Your tools: mcp__office__list_departments/);
  for (const tool of ['mcp__office__list_departments', 'mcp__office__office_status', 'mcp__office__ask_manager']) assert.ok(prompt.includes(tool), tool);
  assert.match(prompt, /MCP tools: call them directly by these names, never through Bash/);
  assert.match(prompt, /Whenever the question concerns a department's work or state, ask that department's manager with ask_manager first, then answer from the reply\./);
  assert.ok(GENERAL_TOOLS.length < 700, 'the tools paragraph stays short');
  assert.ok(prompt.includes(GENERAL_TOOLS));
  assert.match(prompt, /You do not write to the knowledge folders\./);
  assert.match(prompt, /Do not invent dates, owners, commitments or progress/);
  assert.match(prompt, /Reply in the language the user writes in\. Keep replies short/);
  assert.match(prompt, /identity on Trella is agent:general-manager, name "General manager"/);
  assert.ok(prompt.indexOf("Your responsibility, in the user's words: Answer my general questions.") < prompt.indexOf('The protocol of this office'), 'the user text comes before the protocol');
  assert.ok(prompt.endsWith(PROTOCOL_TEMPLATE.trim()));
  assert.ok(!NOT_GENERIC.test(prompt));
  assert.ok(!DASH.test(prompt));

  // No README, no Office folder yet, nothing set: the project folder is where it reads, and nothing is promised as read-only.
  const bare = project();
  const bareDefault = managerPrompt(bare.layout, general, null);
  assert.ok(bareDefault.includes(`the project folder (${bare.layout.project})`));
  assert.ok(!/knowledge folders/.test(bareDefault));
});

test('knowledge folders: set ones that exist, the general manager default, and an explicit empty list', () => {
  const { layout, dir } = project();
  mkdirSync(join(dir, 'docs'));
  mkdirSync(join(dir, 'notes'));
  mkdirSync(layout.officeDir, { recursive: true });
  writeFileSync(join(dir, 'README.md'), '# Atlas\n');
  writeFileSync(join(dir, 'a-file'), '');

  assert.deepEqual(knowledgeSources(layout, { kind: 'lobby' }), { dirs: [layout.officeDir], files: [join(dir, 'README.md')] }, 'default for the lobby');
  assert.deepEqual(knowledgeSources(layout, {}), { dirs: [], files: [] }, 'a department has none by default');
  assert.deepEqual(knowledgeSources(layout, { kind: 'lobby', knowledgeDirs: [] }), { dirs: [], files: [] }, 'an explicit empty list means none');

  const set = { knowledgeDirs: ['docs', join(dir, 'notes'), 'missing', 'a-file', 'docs', '  '] };
  assert.deepEqual(knowledgeSources(layout, set), { dirs: [join(dir, 'docs'), join(dir, 'notes')], files: [] }, 'relative to the project or absolute, existing folders only, no duplicates');
  assert.deepEqual(knowledgeSources(layout, { kind: 'lobby', ...set }).files, [], 'a set list replaces the README default');

  const prompt = managerPrompt(layout, { ...engineering, ...set }, 'Acme');
  assert.ok(prompt.includes(`What you read for context: the folder ${join(dir, 'docs')}, the folder ${join(dir, 'notes')}.`));
  assert.ok(!prompt.includes('missing'));
});

test('every manager gets the trella and office MCP servers, each with its own Trella identity', () => {
  const { layout } = project();
  const rt = runtime();
  const eng = managerMcpServers(layout, { id: 'engineering', name: 'Engineering' }, rt);
  const gen = managerMcpServers(layout, { id: GENERAL_ID, kind: 'lobby', name: 'General manager' }, rt);
  assert.deepEqual(Object.keys(eng).sort(), ['office', 'trella']);

  assert.equal(eng.trella.type, 'stdio');
  assert.equal(eng.trella.command, process.execPath);
  assert.deepEqual(eng.trella.args, [rt.trellaCli, 'mcp']);
  assert.equal(eng.trella.env.TRELLA_PROJECT, layout.trellaWorkspace);
  assert.deepEqual(JSON.parse(eng.trella.env.TRELLA_ACTOR), { type: 'agent', id: 'agent:engineering-manager', name: 'Engineering manager' });
  assert.deepEqual(JSON.parse(gen.trella.env.TRELLA_ACTOR), { type: 'agent', id: 'agent:general-manager', name: 'General manager' });
  assert.notEqual(eng.trella.env.TRELLA_ACTOR, gen.trella.env.TRELLA_ACTOR);
  assert.deepEqual(Object.keys(eng.trella.env).sort(), ['TRELLA_ACTOR', 'TRELLA_PROJECT'], 'no TRELLA_URL: the MCP server finds the service itself');
  assert.deepEqual(managerActor({ id: 'engineering', name: 'Engineering' }), { type: 'agent', id: 'agent:engineering-manager', name: 'Engineering manager' });

  // The office server serves approve and the office tools to every manager: no AFFICE_GENERAL switch.
  assert.deepEqual(eng.office.env, { AFFICE_URL: 'http://127.0.0.1:5331', AFFICE_DEPARTMENT: 'engineering', [AGENT_TOKEN_ENV]: agentToken('engineering') });
  assert.notEqual(eng.office.env[AGENT_TOKEN_ENV], gen.office.env[AGENT_TOKEN_ENV], 'each manager has its own agent token');
  assert.deepEqual(gen.office.env, { AFFICE_URL: 'http://127.0.0.1:5331', AFFICE_DEPARTMENT: GENERAL_ID, [AGENT_TOKEN_ENV]: agentToken(GENERAL_ID) });
  assert.deepEqual(eng.office.args, ['/affice/node_modules/tsx/dist/cli.mjs', '/affice/server/claude/approvals-mcp.ts']);
  assert.equal(eng.office.command, '/usr/bin/node');
  assert.equal(eng.office.timeout, 24 * 60 * 60 * 1000);
});

test('the Trella entry is left out, with one log line, when Trella is missing or not built', () => {
  const { layout } = project();
  const lines: string[] = [];
  const unbuilt = runtime({ trellaCli: fakeTrella(false), log: (line) => lines.push(line) });
  for (let i = 0; i < 3; i += 1) assert.deepEqual(Object.keys(managerMcpServers(layout, { id: 'engineering' }, unbuilt)), ['office']);
  assert.equal(lines.length, 1, 'said once per runtime, not at every start');
  assert.match(lines[0], /^The engineering manager starts without Trella tools: Trella is not built .*npm run build/);

  const missing = runtime({ trellaCli: join(tmpdir(), 'no-such-trella', 'bin', 'trella.js'), log: (line) => lines.push(line) });
  assert.deepEqual(Object.keys(managerMcpServers(layout, { id: 'marketing' }, missing)), ['office']);
  assert.match(lines[1], /Trella was not found at .*AFFICE_TRELLA_CLI/);
});

test('the Trella CLI defaults to AFFICE_TRELLA_CLI, then the vendored one', () => {
  const { layout } = project();
  const cli = fakeTrella();
  const before = process.env.AFFICE_TRELLA_CLI;
  process.env.AFFICE_TRELLA_CLI = cli;
  try {
    const { trellaCli: _unused, ...withoutCli } = runtime();
    assert.deepEqual(managerMcpServers(layout, { id: 'engineering' }, withoutCli).trella.args, [cli, 'mcp']);
  } finally {
    if (before === undefined) delete process.env.AFFICE_TRELLA_CLI;
    else process.env.AFFICE_TRELLA_CLI = before;
  }
});

test('the files of this seam have no em or en dashes and nothing of the old protocol', () => {
  for (const file of ['server/protocol/index.ts', 'server/protocol/index.test.ts', 'server/claude/driver.ts', 'server/claude/approvals-mcp.ts', 'server/office.ts']) {
    const text = readFileSync(join(import.meta.dirname, '../..', file), 'utf8');
    assert.ok(!DASH.test(text), `${file} has an em or en dash`);
  }
  const source = readFileSync(join(import.meta.dirname, 'index.ts'), 'utf8');
  assert.ok(!/Safhe|DEV-|SAF-|founder|WORK-PROTOCOL/.test(source));
});
