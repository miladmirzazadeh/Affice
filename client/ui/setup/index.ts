// The setup gate in front of the office: while Claude Code is not ready or no project is open, a full
// page screen covers the office and asks for what is missing. The two screens are
// client/ui/setup/claude.ts (the Claude Code connection) and client/ui/setup/project.ts (the project picker).
// The mock (?mock=1) never shows it.

import type { OfficeState } from '../../../shared/scene-api';
import { claudeReady, type AppState, type ClientCommand, type ServerEvent } from '../../../shared/types';
import type { Emitter } from '../../state/ui';
import { h, setText } from '../dom';
import { createClaudeSetup } from './claude';
import { createProjectSetup } from './project';
import './setup.css';

/** The screen the gate shows: before the first app.state, Claude Code, then the project. */
export type SetupStep = 'connecting' | 'claude' | 'project';

/** Which setup screen shows, or null for the office. */
export function setupStep(state: Pick<OfficeState, 'app' | 'connection'>): SetupStep | null {
  if (state.connection === 'mock') return null;
  if (!state.app) return 'connecting';
  if (!claudeReady(state.app.claude)) return 'claude';
  if (!state.app.project) return 'project';
  return null;
}

/** What a setup screen may do: send app commands (claude.*, project.*) to the server. */
export interface SetupScreenDeps {
  send(command: ClientCommand): void;
}

/** One setup screen. The gate shows it and calls update on every change while it shows. */
export interface SetupScreen {
  el: HTMLElement;
  update(app: AppState, state: OfficeState): void;
}

export interface SetupGate {
  el: HTMLElement;
  /** Shows the right screen for the state, or hides the gate. Returns the step shown. */
  update(state: OfficeState): SetupStep | null;
  dispose(): void;
}

export interface SetupGateDeps extends SetupScreenDeps {
  /** Every ServerEvent: the gate shows the newest error while it is open. */
  events: Emitter<ServerEvent>;
}

export function mountSetup(deps: SetupGateDeps): SetupGate {
  const claude = createClaudeSetup({ send: deps.send });
  const project = createProjectSetup({ send: deps.send });
  const connectingText = h('p', { class: 'setup-text' });
  const connecting = h('div', { class: 'setup-screen' }, h('h1', { class: 'setup-title', text: 'Connecting' }), connectingText);
  const error = h('p', { class: 'setup-error', role: 'alert', hidden: true });
  const card = h('div', { class: 'setup-card' }, h('p', { class: 'setup-brand', text: 'Affice' }), connecting, claude.el, project.el, error);
  const el = h('section', { class: 'setup', 'aria-label': 'Setup', hidden: true }, card);

  let step: SetupStep | null = null;
  const offEvents = deps.events.on((event) => {
    if (event.type === 'error' && step) {
      setText(error, event.message);
      error.hidden = false;
    }
  });

  return {
    el,
    update(state) {
      const next = setupStep(state);
      if (next !== step) {
        error.hidden = true;
        step = next;
      }
      el.hidden = step === null;
      connecting.hidden = step !== 'connecting';
      claude.el.hidden = step !== 'claude';
      project.el.hidden = step !== 'project';
      if (step === 'connecting') {
        setText(connectingText, state.connection === 'offline' ? 'The Affice server is not reachable. Trying again in the background.' : 'Connecting to the Affice server.');
      } else if (step === 'claude' && state.app) {
        claude.update(state.app, state);
      } else if (step === 'project' && state.app) {
        project.update(state.app, state);
      }
      return step;
    },
    dispose() {
      offEvents();
      el.remove();
    },
  };
}
