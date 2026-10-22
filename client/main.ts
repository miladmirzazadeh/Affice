// Entry point. Wires the store, the transport (the mock with ?mock=1, else the WebSocket), the 3D
// scene, the chrome around it, and the setup gate in front of the office while Claude Code is not
// ready or no project is open. Owned by the coordinator.

import type { OfficeScene } from '../shared/scene-api';
import type { ServerEvent } from '../shared/types';
import { createOffice } from './scene/index';
import { startMock, type TimedEvent } from './state/mock';
import { createStore, type Store } from './state/store';
import { createEmitter, createUiStore } from './state/ui';
import { mountSetup } from './ui/setup/index';
import { mountShell } from './ui/shell';
import { connectSocket } from './ui/socket';

const params = new URLSearchParams(window.location.search);
const mock = params.get('mock') === '1';

// Every ServerEvent also reaches the chrome through `events`, so it can show `error` frames,
// which change nothing in the store.
const events = createEmitter<ServerEvent>();
const base = createStore({ send: () => {} }, mock ? 'mock' : 'connecting');
const store: Store = {
  ...base,
  dispatch(event) {
    base.dispatch(event);
    events.emit(event);
  },
};
const ui = createUiStore();

// The chat and the panels must work even when the 3D office cannot start (no WebGL, a scene bug).
const inertScene: OfficeScene = {
  focus() {},
  resize() {},
  setReducedMotion() {},
  onSelect: () => () => {},
  stats: () => ({ drawCalls: 0, triangles: 0, fps: 0 }),
  dispose() {},
};
const sceneHost = document.getElementById('scene')!;
let sceneError: string | null = null;
let scene: OfficeScene;
try {
  scene = createOffice(sceneHost, store);
} catch (error) {
  console.error('office: the 3D scene failed to start', error);
  sceneError = error instanceof Error ? error.message : String(error);
  scene = inertScene;
}
scene.onSelect((selection) => store.select(selection));
new ResizeObserver(() => scene.resize()).observe(sceneHost);

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
scene.setReducedMotion(reducedMotion.matches);
reducedMotion.addEventListener('change', () => scene.setReducedMotion(reducedMotion.matches));

const shell = mountShell({ root: document.getElementById('ui')!, store, ui, scene, events });
if (sceneError) shell.notify(`The 3D office could not start: ${sceneError}`, 'error');

// The setup screens cover the office (which stays mounted, and out of the tab order) until Claude Code
// is ready and a project is open. The mock never shows them.
const setup = mountSetup({ send: (command) => store.send(command), events });
document.body.append(setup.el);
const app = document.getElementById('app')!;
const gate = () => {
  app.inert = setup.update(store.getState()) !== null;
};
store.subscribe(gate);
gate();

if (mock) {
  const speed = Number(params.get('speed') ?? '1') || 1;
  void import('../fixtures/events.json').then((module) => startMock(store, module.default as TimedEvent[], speed));
} else {
  const socket = connectSocket({
    dispatch: (event) => store.dispatch(event),
    setConnection: (connection) => store.setConnection(connection),
  });
  store.setTransport({
    send(command) {
      // Through the event bus, so the setup screens show it too (the shell shows it as a toast).
      if (!socket.send(command)) events.emit({ type: 'error', department: null, message: 'The office is offline, so that did not go through.' });
    },
  });
}
