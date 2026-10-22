// The Claude Code checks of `affice doctor` (server/doctor.ts calls checkClaude).
// Three checks with stable ids: claude.installed, claude.version (a warning when too old), claude.signedIn. Every failed check carries a
// `fix` that is one command or one sentence a person, or their agent, can act on. Read-only: nothing here
// signs in, signs out or changes Claude Code.

import type { DoctorCheck } from '../shared/server-api';
import type { ClaudeStatus } from '../shared/types';
import { claudeStatus } from './claude/setup';

export const CLAUDE_DOCS = 'https://code.claude.com/docs/en/setup';

export type Os = 'mac' | 'linux' | 'windows';

export function osOf(platform: NodeJS.Platform = process.platform): Os {
  if (platform === 'win32') return 'windows';
  return platform === 'darwin' ? 'mac' : 'linux';
}

/** The official install command for this OS, with the shell it runs in. */
export function installCommand(os: Os): { shell: string; command: string } {
  return os === 'windows'
    ? { shell: 'PowerShell', command: 'irm https://claude.ai/install.ps1 | iex' }
    : { shell: 'a terminal', command: 'curl -fsSL https://claude.ai/install.sh | bash' };
}

/** Other ways to install, from the same docs page. */
export function installAlternatives(os: Os): string[] {
  if (os === 'mac') return ['brew install --cask claude-code', 'npm install -g @anthropic-ai/claude-code'];
  if (os === 'windows') return ['winget install Anthropic.ClaudeCode', 'npm install -g @anthropic-ai/claude-code'];
  return ['npm install -g @anthropic-ai/claude-code'];
}

/** The one terminal line that signs in. */
export const SIGN_IN_COMMAND = 'claude auth login';
const SIGNED_IN_TITLE = 'Claude Code is signed in with a Claude subscription';
export const UPDATE_COMMAND = 'claude update';

function installFix(os: Os): string {
  const { shell, command } = installCommand(os);
  const others = installAlternatives(os).join(', or ');
  return `Install Claude Code by running this in ${shell}: ${command}  Other ways: ${others}. Then open a new terminal, run claude --version, and run affice doctor again. Docs: ${CLAUDE_DOCS}`;
}

/** CLAUDE_BIN names a program that does not answer: installing Claude Code again would not change that. */
export const CLAUDE_BIN_FIX =
  'CLAUDE_BIN is set, and Affice uses only the program it names. Correct CLAUDE_BIN so it points to a working claude (one that answers claude --version), or unset it so Affice looks for claude itself. Then run affice doctor again.';

function updateFix(status: ClaudeStatus): string {
  return `Update Claude Code: run ${UPDATE_COMMAND} (Homebrew installs: brew upgrade claude-code; npm installs: npm install -g @anthropic-ai/claude-code@latest). Affice needs ${status.minVersion} or newer for --forward-subagent-text; ${status.version ?? 'this version'} does not have it.`;
}

/** The checks for a status (pure, so it can be tested and reused). */
export function claudeChecks(status: ClaudeStatus, os: Os = osOf()): DoctorCheck[] {
  const installed: DoctorCheck = status.installed
    ? { id: 'claude.installed', ok: true, title: 'Claude Code is installed', detail: `${status.path ?? 'claude'} ${status.version ?? ''}`.trim(), fix: null }
    : {
        id: 'claude.installed',
        ok: false,
        title: 'Claude Code is installed',
        detail: status.error ?? 'No claude command was found on PATH or in the usual install folders.',
        fix: status.claudeBinProblem ? CLAUDE_BIN_FIX : installFix(os),
      };

  const version: DoctorCheck = !status.installed
    ? { id: 'claude.version', ok: false, title: 'Claude Code is recent enough', detail: 'Not checked, because Claude Code is not installed.', fix: 'Fix claude.installed first.' }
    : status.tooOld
      ? {
          id: 'claude.version',
          ok: false,
          // It still works, without the newer flags: a warning, not a failure.
          level: 'warn',
          title: 'Claude Code is recent enough',
          detail: `Version ${status.version ?? 'unknown'} is older than ${status.minVersion}. Affice still runs, without the newer flags.`,
          fix: updateFix(status),
        }
      : { id: 'claude.version', ok: true, title: 'Claude Code is recent enough', detail: `Version ${status.version ?? 'unknown'} (needs ${status.minVersion} or newer).`, fix: null };

  const signedIn: DoctorCheck = !status.installed
    ? { id: 'claude.signedIn', ok: false, title: SIGNED_IN_TITLE, detail: 'Not checked, because Claude Code is not installed.', fix: 'Fix claude.installed first.' }
    : status.signedIn
      ? {
          id: 'claude.signedIn',
          ok: true,
          title: SIGNED_IN_TITLE,
          detail: status.authMethod === 'oauth_token' ? 'Signed in with a Claude subscription token (oauth_token).' : `Signed in with your Claude subscription (${status.authMethod ?? 'method unknown'}).`,
          fix: null,
        }
      : {
          id: 'claude.signedIn',
          ok: false,
          title: SIGNED_IN_TITLE,
          detail: status.error ?? 'Claude Code is not signed in with a Claude subscription.',
          fix: `Run ${SIGN_IN_COMMAND} in a terminal and sign in with your Claude subscription account, finish the sign-in in the browser, then run affice doctor again. Or open Affice and choose Sign in with Claude.`,
        };

  return [installed, version, signedIn];
}

export async function checkClaude(): Promise<DoctorCheck[]> {
  return claudeChecks(await claudeStatus());
}
