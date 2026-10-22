// The Claude Code setup screen: shown while Claude Code is not installed, too old to report its sign-in, or
// not signed in. createClaudeSetup and its signature are the seam.
//
// One view per state (claudeView): missing, old, signedOut, signingIn, ready. Affice works with a Claude
// subscription only, so every sign-in that is not one (the server decides) shows signedOut. Text that comes from
// the server (the error note, the version, the path, the sign-in link) only ever goes in through
// textContent or as a validated https href, never as markup. The sign-in itself happens in Claude Code and
// the browser; this screen only sends claude.login, claude.cancelLogin and claude.refresh.

import type { ClaudeStatus } from '../../../shared/types';
import { h, setAttr, setText } from '../dom';
import type { SetupScreen, SetupScreenDeps } from './index';

export const DOCS_URL = 'https://code.claude.com/docs/en/setup';
export const SIGN_IN_COMMAND = 'claude auth login';
export const UPDATE_COMMAND = 'claude update';

export type Os = 'mac' | 'linux' | 'windows';

/** The OS of the browser (Affice runs on the same computer), from navigator.platform and the user agent. */
export function osFromAgent(text: string): Os {
  if (/win/i.test(text) && !/darwin/i.test(text)) return 'windows';
  if (/mac|iphone|ipad/i.test(text)) return 'mac';
  return 'linux';
}

interface InstallOption {
  label: string;
  command: string;
  os: Os[];
}

/** The install commands of the docs page ([setup](https://code.claude.com/docs/en/setup)). The first option of an OS is the one shown. */
export const INSTALL_OPTIONS: readonly InstallOption[] = [
  { label: 'macOS, Linux and WSL', command: 'curl -fsSL https://claude.ai/install.sh | bash', os: ['mac', 'linux'] },
  { label: 'Windows PowerShell', command: 'irm https://claude.ai/install.ps1 | iex', os: ['windows'] },
  { label: 'Homebrew', command: 'brew install --cask claude-code', os: [] },
  { label: 'WinGet', command: 'winget install Anthropic.ClaudeCode', os: [] },
  { label: 'npm (Node 22 or newer)', command: 'npm install -g @anthropic-ai/claude-code', os: [] },
];

/** The install command to show first for this OS. */
export function installCommand(os: Os): InstallOption {
  return INSTALL_OPTIONS.find((option) => option.os.includes(os)) ?? INSTALL_OPTIONS[0];
}

export type ClaudeView = 'missing' | 'old' | 'signedOut' | 'signingIn' | 'ready';

/** Which view a status shows. A version that is too old only takes over while Claude Code is not signed in (the gate lets a signed in one through). */
export function claudeView(status: ClaudeStatus): ClaudeView {
  if (!status.installed) return 'missing';
  if (status.signedIn) return 'ready';
  if (status.signingIn) return 'signingIn';
  if (status.tooOld) return 'old';
  return 'signedOut';
}

/** The setup screen for a CLAUDE_BIN that does not answer: the fix is the variable, so no install commands. */
export const BIN_FIX_TITLE = 'Fix CLAUDE_BIN';
export const BIN_FIX_TEXT =
  'CLAUDE_BIN is set, and Affice uses only the program it names. That program did not answer claude --version. Correct CLAUDE_BIN or unset it in the terminal where you started Affice, then start Affice again.';

/** Claude Code counts as missing only because CLAUDE_BIN names a program that does not answer. */
export function binFixNeeded(status: ClaudeStatus): boolean {
  return status.claudeBinProblem === true && claudeView(status) === 'missing';
}

/** How the sign-in method reads in a sentence. */
export function methodLabel(authMethod: string | null): string {
  switch (authMethod) {
    case 'claude.ai':
      return 'your Claude account';
    case 'oauth_token':
      return 'a Claude Code token';
    default:
      return authMethod ?? 'an unknown method';
  }
}

/** Installed through Homebrew, judging by where the binary lives. */
export function isHomebrew(path: string | null): boolean {
  return path !== null && /\/(homebrew|Cellar|Caskroom)\//i.test(path);
}

/** A sign-in link that is safe to open: https only. Null for anything else. */
export function safeHttpsUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Not a secure context, or the permission was refused: select the text in a hidden field instead.
  }
  try {
    const field = h('textarea', { 'aria-hidden': 'true', tabindex: '-1', style: 'position:fixed;opacity:0;pointer-events:none' });
    field.value = text;
    document.body.append(field);
    field.select();
    const ok = document.execCommand('copy');
    field.remove();
    return ok;
  } catch {
    return false;
  }
}

/** A copy button: says "Copied" for a moment. `text` is read at click time. */
function copyButton(label: string, text: () => string): HTMLButtonElement {
  const button = h('button', { class: 'btn btn--small', type: 'button', text: 'Copy', 'aria-label': label });
  let timer: ReturnType<typeof setTimeout> | undefined;
  button.addEventListener('click', async () => {
    const ok = await copyText(text());
    button.textContent = ok ? 'Copied' : 'Select and copy';
    clearTimeout(timer);
    timer = setTimeout(() => {
      button.textContent = 'Copy';
    }, 1600);
  });
  return button;
}

/** A command in a mono box with a copy button. */
function commandRow(command: string, label: string): HTMLElement {
  return h('div', { class: 'setup-command' }, h('code', { text: command }), copyButton(`Copy ${label}`, () => command));
}

export function createClaudeSetup(deps: SetupScreenDeps): SetupScreen {
  const title = h('h1', { class: 'setup-title' });
  const text = h('p', { class: 'setup-text' });

  // Not installed.
  const os = osFromAgent(typeof navigator === 'undefined' ? '' : `${navigator.platform} ${navigator.userAgent}`);
  const primary = installCommand(os);
  const others = INSTALL_OPTIONS.filter((option) => option !== primary);
  const missing = h(
    'div',
    { class: 'setup-section' },
    h('p', { class: 'setup-subtitle', text: primary.label }),
    commandRow(primary.command, 'the install command'),
    h(
      'details',
      { class: 'setup-more' },
      h('summary', { text: 'Other ways to install' }),
      h(
        'div',
        { class: 'setup-section' },
        ...others.flatMap((option) => [h('p', { class: 'setup-note', text: option.label }), commandRow(option.command, `the ${option.label} command`)]),
      ),
    ),
    h('a', { class: 'setup-link', href: DOCS_URL, target: '_blank', rel: 'noopener noreferrer', text: 'Installation guide' }),
  );

  // Too old.
  const oldVersion = h('p', { class: 'setup-subtitle' });
  const brew = h(
    'div',
    { class: 'setup-section' },
    h('p', { class: 'setup-note', text: 'Installed with Homebrew? Use this instead.' }),
    commandRow('brew upgrade claude-code', 'the Homebrew update command'),
  );
  const old = h('div', { class: 'setup-section' }, oldVersion, commandRow(UPDATE_COMMAND, 'the update command'), brew);

  // Signing in: the wait line, the sign-in link, Cancel.
  const spinner = h('span', { class: 'setup-spinner', 'aria-hidden': 'true' });
  const wait = h(
    'div',
    { class: 'setup-wait', role: 'status' },
    spinner,
    h('span', { text: 'Waiting for the browser sign-in' }),
  );
  const loginLink = h('a', { class: 'setup-link', target: '_blank', rel: 'noopener noreferrer', text: 'Open the sign-in page' });
  let loginUrl = '';
  const loginHost = h('p', { class: 'setup-note' });
  const loginRow = h('div', { class: 'setup-section' }, h('div', { class: 'setup-row setup-row--center' }, loginLink, copyButton('Copy the sign-in link', () => loginUrl)), loginHost);
  const signing = h('div', { class: 'setup-section' }, wait, loginRow);

  // Signed out and signing in share the terminal fallback.
  const fallback = h(
    'div',
    { class: 'setup-section' },
    h('p', { class: 'setup-note', text: 'Or sign in from a terminal, then check again.' }),
    commandRow(SIGN_IN_COMMAND, 'the sign-in command'),
  );

  // Ready.
  const fact = h('p', { class: 'setup-note' });

  const note = h('p', { class: 'setup-note', hidden: true });

  const signIn = h('button', { class: 'btn btn--primary', type: 'button', text: 'Sign in with Claude' });
  const cancel = h('button', { class: 'btn', type: 'button', text: 'Cancel' });
  const check = h('button', { class: 'btn', type: 'button', text: 'Check again' });
  const next = h('button', { class: 'btn btn--primary', type: 'button', text: 'Continue' });

  let busy: ReturnType<typeof setTimeout> | undefined;
  const release = () => {
    clearTimeout(busy);
    signIn.disabled = false;
    check.disabled = false;
    setText(check, 'Check again');
  };
  // A pressed button waits for the next app.state; if none comes, it frees itself.
  const hold = (...buttons: HTMLButtonElement[]) => {
    for (const button of buttons) button.disabled = true;
    clearTimeout(busy);
    busy = setTimeout(release, 6000);
  };
  signIn.addEventListener('click', () => {
    hold(signIn);
    deps.send({ type: 'claude.login' });
  });
  cancel.addEventListener('click', () => deps.send({ type: 'claude.cancelLogin' }));
  check.addEventListener('click', () => {
    hold(check);
    setText(check, 'Checking');
    deps.send({ type: 'claude.refresh' });
  });
  next.addEventListener('click', () => deps.send({ type: 'claude.refresh' }));

  const actions = h('div', { class: 'setup-actions' }, signIn, cancel, check, next);
  const el = h('div', { class: 'setup-screen setup-claude' }, title, text, missing, old, signing, fallback, fact, note, actions);

  return {
    el,
    update(app) {
      release();
      const status = app.claude;
      const view = claudeView(status);
      const version = status.version ?? 'unknown';

      const binFix = binFixNeeded(status);
      const headings: Record<ClaudeView, string> = {
        missing: 'Install Claude Code',
        old: 'Update Claude Code',
        signedOut: 'Sign in to Claude Code',
        signingIn: 'Sign in to Claude Code',
        ready: 'Claude Code is ready',
      };
      const texts: Record<ClaudeView, string> = {
        missing: 'Affice runs the Claude Code on your computer, and it is not installed yet. Run this command, then check again.',
        old: `Claude Code ${version} is installed, and Affice needs ${status.minVersion} or newer. Run this command, then check again.`,
        signedOut: 'Affice works with your Claude subscription. Sign in with your Claude account so the managers can work. You finish in your browser, and Affice never sees your password.',
        signingIn: 'Finish the sign-in in your browser. This page moves on by itself when it is done.',
        ready: status.authMethod ? `Signed in with ${methodLabel(status.authMethod)}.` : 'Signed in.',
      };
      setText(title, binFix ? BIN_FIX_TITLE : headings[view]);
      setText(text, binFix ? BIN_FIX_TEXT : texts[view]);

      missing.hidden = view !== 'missing' || binFix;
      old.hidden = view !== 'old';
      brew.hidden = !isHomebrew(status.path);
      setText(oldVersion, `Installed: ${version}. Needed: ${status.minVersion} or newer.`);
      signing.hidden = view !== 'signingIn';
      fallback.hidden = view !== 'signedOut' && view !== 'signingIn';

      const url = view === 'signingIn' ? safeHttpsUrl(status.loginUrl) : null;
      loginRow.hidden = url === null;
      loginUrl = url ?? '';
      setAttr(loginLink, 'href', url);
      setText(loginHost, url ? `This opens ${new URL(url).host} in your browser.` : '');

      const done = view === 'ready';
      fact.hidden = !done || status.version === null;
      setText(fact, `Claude Code ${version}${status.path ? ` at ${status.path}` : ''}.`);

      // The server's sentence: a sign-in problem, a sign-in that is not a Claude subscription, a CLAUDE_BIN problem. Red while Claude Code is not usable.
      const sentence = status.error ?? '';
      setText(note, sentence);
      note.hidden = sentence === '';
      note.className = status.signedIn ? 'setup-note' : 'setup-error';

      signIn.hidden = view !== 'signedOut';
      cancel.hidden = view !== 'signingIn';
      check.hidden = done;
      next.hidden = !done;
    },
  };
}
