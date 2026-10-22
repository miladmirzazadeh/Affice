// The Kanban view: Trella's own board in an iframe, with a link to open it in a tab, and a
// message when Trella does not answer or the department has no board. Affice starts Trella itself for the
// open project, so the message points to `affice doctor`, never to a command that starts it by hand.
//
// Trella's web app opens the board named by ?board=<id>.

import type { Department } from '../../../shared/types';
import { createRoot, el, safeHttp, showLoading, type DataView } from './common';

/** The command that checks Claude Code, Trella's built files and the port. It runs in any terminal. */
export const DOCTOR_COMMAND = 'npx affice doctor';

const PROBE_MS = 3000;

export function boardUrl(trellaUrl: string, boardId: string | null): string {
  const base = trellaUrl.replace(/\/+$/, '');
  return boardId ? `${base}/?board=${encodeURIComponent(boardId)}` : `${base}/`;
}

/** Any answer at all, even an error page, means Trella is up. A refused connection is the "not running" case. */
async function reachable(trellaUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), PROBE_MS);
  try {
    await fetch(`${trellaUrl.replace(/\/+$/, '')}/api/health`, { mode: 'no-cors', cache: 'no-store', signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timer);
  }
}

export function renderKanban(container: HTMLElement, department: Department, trellaUrl: string): DataView {
  const { root, body } = createRoot(container, department, 'dv-kanban');
  const url = safeHttp(boardUrl(trellaUrl, department.trellaBoardId));
  let disposed = false;

  const open = el('a', 'dv-btn', 'Open in Trella');
  if (url) {
    open.href = url;
    open.target = '_blank';
    open.rel = 'noopener noreferrer';
  }
  const bar = el('div', 'dv-bar', el('span', 'dv-title', department.kind === 'lobby' ? 'Project boards' : `${department.name} board`), el('span', 'dv-bar-grow'), open);
  root.insertBefore(bar, body);

  const command = () => {
    const code = el('code', 'dv-cmd', DOCTOR_COMMAND);
    code.title = 'Run this in a terminal';
    return code;
  };

  function message(title: string, text: string, withCommand: boolean, ...actions: HTMLElement[]): void {
    body.replaceChildren(
      el('div', 'dv-pad', el('div', 'dv-message', el('h3', '', title), el('p', '', text), ...(withCommand ? [command()] : []), el('div', 'dv-actions', ...actions))),
    );
  }

  function showDown(): void {
    const again = el('button', 'dv-btn', 'Check again');
    again.type = 'button';
    again.addEventListener('click', () => void start());
    message(
      'Trella did not start',
      'This view shows Trella, which Affice starts for the open project. It does not answer yet. Give it a moment and check again. If it still does not answer, run the command below in a terminal to see what is missing.',
      true,
      again,
    );
  }

  function showNoBoard(): void {
    message(
      `No Trella board for ${department.name} yet`,
      'A department gets its board when it is created in the office.',
      false,
    );
  }

  function showFrame(address: string): void {
    const frame = el('iframe', 'dv-frame');
    frame.title = `Trella board of ${department.name}`;
    frame.referrerPolicy = 'no-referrer';
    frame.src = address;
    body.replaceChildren(frame);
  }

  async function start(): Promise<void> {
    // The general manager has no board of its own: its tab is Trella itself, with the boards of the project's workspace.
    if (department.trellaBoardId === null && department.kind !== 'lobby') return showNoBoard();
    if (!url) {
      return message('The Trella address is not a web address', `The office is set to open "${trellaUrl}". Fix trellaUrl in the office settings.`, false);
    }
    showLoading(body, 'Looking for Trella');
    const up = await reachable(trellaUrl);
    if (disposed) return;
    if (up) showFrame(url);
    else showDown();
  }

  void start();
  return {
    refresh: start,
    dispose() {
      disposed = true;
      root.remove();
    },
  };
}
