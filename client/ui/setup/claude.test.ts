// Tests of the pure parts of the Claude Code setup screen (which view a status shows, the commands, the
// links that are safe to open). The DOM itself is checked in a browser.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { ClaudeStatus } from '../../../shared/types';
import { BIN_FIX_TEXT, BIN_FIX_TITLE, binFixNeeded, claudeView, INSTALL_OPTIONS, installCommand, isHomebrew, methodLabel, osFromAgent, safeHttpsUrl, SIGN_IN_COMMAND, UPDATE_COMMAND } from './claude';

const status = (patch: Partial<ClaudeStatus> = {}): ClaudeStatus => ({
  installed: true, path: '/usr/local/bin/claude', version: '2.1.287', minVersion: '2.1.211', tooOld: false,
  signedIn: false, authMethod: null, signingIn: false, loginUrl: null, error: null, ...patch,
});

test('each state shows its view', () => {
  assert.equal(claudeView(status({ installed: false, path: null, version: null })), 'missing');
  assert.equal(claudeView(status({ version: '2.1.100', tooOld: true })), 'old');
  assert.equal(claudeView(status()), 'signedOut');
  assert.equal(claudeView(status({ signingIn: true })), 'signingIn');
  assert.equal(claudeView(status({ signingIn: true, loginUrl: 'https://claude.ai/x' })), 'signingIn');
  assert.equal(claudeView(status({ signedIn: true, authMethod: 'claude.ai' })), 'ready');
  assert.equal(claudeView(status({ signedIn: true, authMethod: 'oauth_token' })), 'ready');
  // The server says not signed in for every sign-in that is not a Claude subscription: the signed out view, with its sentence.
  assert.equal(claudeView(status({ error: 'Claude Code is signed in another way (api_key), but Affice needs a Claude subscription. Sign in with your Claude account.' })), 'signedOut');
  // Signed in beats too old (the gate lets it through); a running sign-in beats too old.
  assert.equal(claudeView(status({ signedIn: true, authMethod: 'claude.ai', tooOld: true })), 'ready');
  assert.equal(claudeView(status({ signingIn: true, tooOld: true })), 'signingIn');
});

test('the install command of each OS', () => {
  assert.equal(installCommand('mac').command, 'curl -fsSL https://claude.ai/install.sh | bash');
  assert.equal(installCommand('linux').command, 'curl -fsSL https://claude.ai/install.sh | bash');
  assert.equal(installCommand('windows').command, 'irm https://claude.ai/install.ps1 | iex');
  assert.ok(INSTALL_OPTIONS.some((option) => option.command === 'brew install --cask claude-code'));
  assert.ok(INSTALL_OPTIONS.some((option) => option.command === 'npm install -g @anthropic-ai/claude-code'));
  assert.equal(SIGN_IN_COMMAND, 'claude auth login');
  assert.equal(UPDATE_COMMAND, 'claude update');
});

test('the OS is read from the browser', () => {
  assert.equal(osFromAgent('MacIntel Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), 'mac');
  assert.equal(osFromAgent('Win32 Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'windows');
  assert.equal(osFromAgent('Linux x86_64 Mozilla/5.0 (X11; Linux x86_64)'), 'linux');
  assert.equal(osFromAgent(''), 'linux');
});

test('only https links are opened, a Homebrew install is recognised, the method reads as a sentence', () => {
  assert.equal(safeHttpsUrl('https://claude.ai/oauth/authorize?state=x'), 'https://claude.ai/oauth/authorize?state=x');
  assert.equal(safeHttpsUrl('http://claude.ai/x'), null);
  assert.equal(safeHttpsUrl('javascript:alert(1)'), null);
  assert.equal(safeHttpsUrl('data:text/html,<b>x</b>'), null);
  assert.equal(safeHttpsUrl('not a url'), null);
  assert.equal(safeHttpsUrl(null), null);
  assert.ok(isHomebrew('/opt/homebrew/bin/claude'));
  assert.ok(isHomebrew('/usr/local/Caskroom/claude-code/2.1.0/claude'));
  assert.ok(!isHomebrew('/Users/me/.local/bin/claude'));
  assert.ok(!isHomebrew(null));
  assert.equal(methodLabel('claude.ai'), 'your Claude account');
  assert.equal(methodLabel('oauth_token'), 'a Claude Code token');
  assert.equal(methodLabel('future_method'), 'future_method');
  assert.equal(methodLabel(null), 'an unknown method');
});

test('the screen never writes server text as markup and has no dashes in its copy', () => {
  const source = readFileSync(new URL('./claude.ts', import.meta.url), 'utf8');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(source));
  assert.ok(!new RegExp('[\\u2013\\u2014]').test(source), 'no em or en dashes');
});

test('a CLAUDE_BIN that does not answer shows the fix for that variable, not the install page', () => {
  const broken = status({ installed: false, path: null, version: null, claudeBinProblem: true, error: 'CLAUDE_BIN is set to /x, but that did not answer claude --version. Fix the path or unset CLAUDE_BIN.' });
  assert.equal(claudeView(broken), 'missing');
  assert.equal(binFixNeeded(broken), true);
  assert.equal(binFixNeeded(status({ installed: false, path: null, version: null })), false, 'plainly not installed: the install page');
  assert.equal(binFixNeeded(status({ claudeBinProblem: true })), false, 'only while Claude Code counts as missing');
  assert.match(BIN_FIX_TITLE, /CLAUDE_BIN/);
  assert.match(BIN_FIX_TEXT, /Correct CLAUDE_BIN or unset it/);
  assert.ok(!/install/i.test(BIN_FIX_TEXT.replace('did not answer', '')), 'it does not tell anyone to install');
});
