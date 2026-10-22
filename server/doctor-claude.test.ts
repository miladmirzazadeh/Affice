// Tests of the Claude Code checks of `affice doctor`: pure checks for each state and OS, and one run against a fake claude.

import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { ClaudeStatus } from '../shared/types';
import { INSTALL_OPTIONS, SIGN_IN_COMMAND as CLIENT_SIGN_IN, UPDATE_COMMAND as CLIENT_UPDATE, installCommand as clientInstall } from '../client/ui/setup/claude';
import { checkClaude, claudeChecks, installAlternatives, installCommand, osOf, SIGN_IN_COMMAND, UPDATE_COMMAND } from './doctor-claude';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'affice-doctor-')));
after(() => rmSync(root, { recursive: true, force: true }));

const base: ClaudeStatus = {
  installed: true, path: '/opt/homebrew/bin/claude', version: '2.1.287', minVersion: '2.1.211', tooOld: false,
  signedIn: true, authMethod: 'claude.ai', signingIn: false, loginUrl: null, error: null,
};
const byId = (checks: ReturnType<typeof claudeChecks>) => Object.fromEntries(checks.map((check) => [check.id, check]));

test('ready: three checks, all ok, no fix', () => {
  const checks = claudeChecks(base, 'mac');
  assert.deepEqual(checks.map((check) => check.id), ['claude.installed', 'claude.version', 'claude.signedIn']);
  assert.ok(checks.every((check) => check.ok && check.fix === null));
  assert.match(byId(checks)['claude.installed'].detail, /2\.1\.287/);
  assert.match(byId(checks)['claude.signedIn'].detail, /Claude subscription \(claude\.ai\)/);
  assert.match(byId(checks)['claude.signedIn'].title, /Claude subscription/);
  assert.match(byId(claudeChecks({ ...base, authMethod: 'oauth_token' }, 'mac'))['claude.signedIn'].detail, /subscription token \(oauth_token\)/);
});

test('not installed: the install fix of each OS, the others say to fix that first', () => {
  const missing = { ...base, installed: false, path: null, version: null, signedIn: false, authMethod: null };
  const mac = byId(claudeChecks(missing, 'mac'));
  assert.equal(mac['claude.installed'].ok, false);
  assert.match(mac['claude.installed'].fix ?? '', /curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash/);
  assert.match(mac['claude.installed'].fix ?? '', /brew install --cask claude-code/);
  assert.match(mac['claude.installed'].fix ?? '', /npm install -g @anthropic-ai\/claude-code/);
  assert.match(mac['claude.installed'].fix ?? '', /code\.claude\.com\/docs\/en\/setup/);
  const linux = byId(claudeChecks(missing, 'linux'));
  assert.match(linux['claude.installed'].fix ?? '', /install\.sh \| bash/);
  assert.ok(!(linux['claude.installed'].fix ?? '').includes('brew'));
  const windows = byId(claudeChecks(missing, 'windows'));
  assert.match(windows['claude.installed'].fix ?? '', /PowerShell: irm https:\/\/claude\.ai\/install\.ps1 \| iex/);
  assert.match(windows['claude.installed'].fix ?? '', /winget install Anthropic\.ClaudeCode/);
  for (const checks of [mac, linux, windows]) {
    assert.equal(checks['claude.version'].ok, false);
    assert.equal(checks['claude.signedIn'].ok, false);
    assert.match(checks['claude.version'].fix ?? '', /claude\.installed/);
    assert.match(checks['claude.signedIn'].fix ?? '', /claude\.installed/);
  }
});

test('a broken CLAUDE_BIN keeps its own sentence as the detail', () => {
  const checks = byId(claudeChecks({ ...base, installed: false, path: null, version: null, signedIn: false, error: 'CLAUDE_BIN is set to /x, but that did not answer claude --version.' }, 'mac'));
  assert.match(checks['claude.installed'].detail, /CLAUDE_BIN is set to \/x/);
});

test('a broken CLAUDE_BIN gets a fix about that variable, not an install command; a plain missing Claude Code still gets the install', () => {
  const broken = byId(claudeChecks({ ...base, installed: false, path: null, version: null, signedIn: false, claudeBinProblem: true, error: 'CLAUDE_BIN is set to /x, but that did not answer claude --version. Fix the path or unset CLAUDE_BIN.' }, 'mac'));
  const fix = broken['claude.installed'].fix ?? '';
  assert.equal(broken['claude.installed'].ok, false);
  assert.match(fix, /Correct CLAUDE_BIN/);
  assert.match(fix, /unset it/);
  assert.ok(!/curl|install\.sh|brew|npm install|Install Claude Code/.test(fix), 'no install advice');
  const missing = byId(claudeChecks({ ...base, installed: false, path: null, version: null, signedIn: false, error: null }, 'mac'));
  assert.match(missing['claude.installed'].fix ?? '', /Install Claude Code by running/);
});

test('too old: the version check fails as a warning with the update fix, the rest still pass', () => {
  const checks = byId(claudeChecks({ ...base, version: '2.1.100', tooOld: true }, 'mac'));
  assert.equal(checks['claude.installed'].ok, true);
  assert.equal(checks['claude.version'].ok, false);
  assert.equal(checks['claude.version'].level, 'warn', 'it still works, so it is a warning');
  for (const id of ['claude.installed', 'claude.signedIn']) assert.equal(checks[id].level, undefined, `${id} is no warning`);
  assert.match(checks['claude.version'].detail, /2\.1\.100 is older than 2\.1\.211/);
  assert.match(checks['claude.version'].fix ?? '', /claude update/);
  assert.match(checks['claude.version'].fix ?? '', /brew upgrade claude-code/);
  assert.equal(checks['claude.signedIn'].ok, true);
});

test('signed out: the fix is the one terminal line', () => {
  const checks = byId(claudeChecks({ ...base, signedIn: false, authMethod: null }, 'mac'));
  assert.equal(checks['claude.signedIn'].ok, false);
  assert.match(checks['claude.signedIn'].fix ?? '', /Run claude auth login in a terminal/);
  assert.match(checks['claude.signedIn'].fix ?? '', /Claude subscription/);
  assert.equal(checks['claude.signedIn'].level, undefined, 'signed out is a failure');
  assert.equal(SIGN_IN_COMMAND, 'claude auth login');
  const unknown = byId(claudeChecks({ ...base, signedIn: false, authMethod: null, error: 'Claude Code did not answer claude auth status within 5 seconds.' }, 'mac'));
  assert.match(unknown['claude.signedIn'].detail, /within 5 seconds/);
});

test('a sign-in that is not a Claude subscription fails with its sentence and the subscription sign-in as the fix', () => {
  const sentence = 'Claude Code is signed in another way (api_key), but Affice needs a Claude subscription. Sign in with your Claude account.';
  const check = byId(claudeChecks({ ...base, signedIn: false, authMethod: null, error: sentence }, 'mac'))['claude.signedIn'];
  assert.equal(check.ok, false);
  assert.equal(check.detail, sentence);
  assert.match(check.fix ?? '', /claude auth login/);
});

test('the doctor and the setup screen give the same commands', () => {
  for (const os of ['mac', 'linux', 'windows'] as const) {
    assert.equal(clientInstall(os).command, installCommand(os).command, os);
    for (const alternative of installAlternatives(os)) {
      assert.ok(INSTALL_OPTIONS.some((option) => option.command === alternative), `${alternative} is offered on the screen`);
    }
  }
  assert.equal(CLIENT_SIGN_IN, SIGN_IN_COMMAND);
  assert.equal(CLIENT_UPDATE, UPDATE_COMMAND);
  assert.equal(osOf('darwin'), 'mac');
  assert.equal(osOf('win32'), 'windows');
  assert.equal(osOf('linux'), 'linux');
});

test('checkClaude reads the real status through a fake claude', async () => {
  const bin = join(root, 'claude');
  writeFileSync(bin, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.287 (Claude Code)"; exit 0; fi\necho \'{"loggedIn":false,"authMethod":"none"}\'; exit 1\n');
  chmodSync(bin, 0o755);
  const saved = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = bin;
  try {
    const checks = byId(await checkClaude());
    assert.equal(checks['claude.installed'].ok, true);
    assert.equal(checks['claude.version'].ok, true);
    assert.equal(checks['claude.signedIn'].ok, false);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = saved;
  }
});

test('checkClaude with a CLAUDE_BIN that does not answer says to fix the variable', async () => {
  const saved = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = join(root, 'no-such-claude');
  try {
    const checks = byId(await checkClaude());
    assert.equal(checks['claude.installed'].ok, false);
    assert.match(checks['claude.installed'].detail, /CLAUDE_BIN is set to .*no-such-claude/);
    assert.match(checks['claude.installed'].fix ?? '', /Correct CLAUDE_BIN/);
    assert.ok(!/curl -fsSL/.test(checks['claude.installed'].fix ?? ''));
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = saved;
  }
});
