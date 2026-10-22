// Opens a page in the user's default browser. A convenience: the address is always printed as well, so a
// failure here is silent.
//
// The opener (open, xdg-open, start) is not Claude Code and needs none of the user's credentials, so it runs
// with the minimal environment (server/env.ts) plus the few variables a Linux desktop needs to find the
// session it should open the page in. None of them is a secret.

import { spawn } from 'node:child_process';
import { minimalEnv } from './env';

/** What xdg-open and friends read to find the user's desktop session and browser (X11, Wayland, D-Bus, WSL). */
const DESKTOP_SESSION = [
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'DBUS_SESSION_BUS_ADDRESS',
  'XDG_RUNTIME_DIR',
  'XDG_CURRENT_DESKTOP',
  'XDG_SESSION_TYPE',
  'XDG_SESSION_DESKTOP',
  'DESKTOP_SESSION',
  'BROWSER',
  'WSL_DISTRO_NAME',
  'WSL_INTEROP',
];

/** The environment of the browser opener. Exported for the test. */
export function openerEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const extra: Record<string, string | undefined> = {};
  for (const name of DESKTOP_SESSION) extra[name] = base[name];
  return minimalEnv(extra, base);
}

export function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, env: openerEnv() });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // The address is printed; the user can open it.
  }
}
