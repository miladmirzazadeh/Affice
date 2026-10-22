// The chrome over the scene. Builds the top bar, the lobby, the room panel, the department form and
// the toasts, keeps them in step with the store and the UI state, and owns the selection rules:
// a selection made in the chrome moves the camera; Escape closes the panel and clears the selection;
// an agent that leaves while selected leaves its room open.

import type { OfficeScene, OfficeState, Selection } from '../../shared/scene-api';
import type { ServerEvent } from '../../shared/types';
import type { Store } from '../state/store';
import { tabsFor, type Emitter, type UiStore } from '../state/ui';
import { openDepartment } from './derive';
import { createDepartmentForm } from './form';
import { createLobby } from './lobby';
import { createRoom } from './room';
import { createToasts } from './toast';
import { createTopbar } from './topbar';

export interface ShellDeps {
  root: HTMLElement;
  store: Store;
  ui: UiStore;
  scene: OfficeScene;
  events: Emitter<ServerEvent>;
}

export interface Shell {
  /** A short note, for example a command that could not be sent. */
  notify(text: string, tone?: 'info' | 'error'): void;
  dispose(): void;
}

export function mountShell(deps: ShellDeps): Shell {
  const { store, ui, scene } = deps;
  const toasts = createToasts();
  let fromUi = false;

  /** The chrome changes the selection: update the store, then move the camera. */
  function selectFromUi(selection: Selection) {
    fromUi = true;
    try {
      store.select(selection);
    } finally {
      fromUi = false;
    }
    scene.focus(selection, { animate: true });
  }

  // The top bar passes its click event, the lobby's template buttons pass a template id.
  const openAdd = (template?: unknown) => ui.set({ form: typeof template === 'string' ? { mode: 'add', template } : { mode: 'add' } });
  const topbar = createTopbar({ scene, onAdd: openAdd, onToggleStats: () => ui.set({ stats: !ui.get().stats }) });
  const lobby = createLobby({ onSelect: (id) => selectFromUi({ kind: 'department', id }), onAdd: openAdd, send: (command) => store.send(command) });
  const room = createRoom({
    store,
    ui,
    toasts,
    onClose: () => selectFromUi(null),
    onEdit: (id) => ui.set({ form: { mode: 'edit', id } }),
    onSelectAgent: (id) => selectFromUi({ kind: 'agent', id }),
  });
  const form = createDepartmentForm({
    store,
    events: deps.events,
    onClosed: () => ui.set({ form: null }),
    onCreated: (id) => selectFromUi({ kind: 'department', id }),
    onRemoved: () => selectFromUi(null),
  });
  deps.root.append(lobby.el, room.el, topbar.el, toasts.el, form.el);

  // One render per frame. A hidden page gets no animation frames, so it renders on a timer
  // instead and is already current when it is shown again.
  let scheduled = false;
  function render() {
    if (!scheduled) return;
    scheduled = false;
    const state = store.getState();
    const uiState = ui.get();
    const open = openDepartment(state) !== null;
    document.body.classList.toggle('has-room', open);
    document.body.classList.toggle('room-has-view', open && uiState.tab !== 'office');
    topbar.update(state, uiState);
    lobby.update(state);
    room.update(state, uiState);
    form.sync(uiState.form, state);
    // The lobby sets the window title to the project's name.
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    if (document.hidden) window.setTimeout(render, 50);
    else window.requestAnimationFrame(render);
  }
  // A frame requested just before the page was hidden would wait for it to show again.
  const onVisibility = () => {
    if (scheduled) window.setTimeout(render, 50);
  };
  document.addEventListener('visibilitychange', onVisibility);

  /** The selection points at something that is gone: fall back to the agent's room, or to nothing. */
  function repair(state: OfficeState, previous: OfficeState) {
    if (fromUi) return;
    const selected = state.selected;
    let lostAgent: string | null = null;
    if (selected?.kind === 'agent' && !state.agents.some((a) => a.id === selected.id)) lostAgent = selected.id;
    else if (!selected && previous.selected?.kind === 'agent') {
      const id = previous.selected.id;
      if (!state.agents.some((a) => a.id === id)) lostAgent = id;
    }
    const lostDepartment = selected?.kind === 'department' && openDepartment(state) === null;
    if (!lostAgent && !lostDepartment) return;

    const home = lostAgent ? previous.agents.find((a) => a.id === lostAgent)?.department : undefined;
    const fallback: Selection = home && state.config.departments.some((d) => d.id === home) ? { kind: 'department', id: home } : null;
    queueMicrotask(() => {
      if (store.getState().selected === selected) store.select(fallback);
    });
  }

  const offStore = store.subscribe((state, previous) => {
    if (state.selected !== previous.selected) {
      // An agent opens its room on the Office tab, where the scene shows it; a closed panel starts there too,
      // and so does a department that does not offer the open tab (no Branches without repos).
      const department = openDepartment(state);
      if (!state.selected || state.selected.kind === 'agent' || (department && !tabsFor(department).some((t) => t.id === ui.get().tab))) {
        ui.set({ tab: 'office' });
      }
    }
    repair(state, previous);
    schedule();
  });
  const offUi = ui.subscribe(schedule);

  const offEvents = deps.events.on((event) => {
    if (event.type !== 'error') return;
    const name = event.department ? store.getState().config.departments.find((d) => d.id === event.department)?.name : null;
    toasts.show(name ? `${name}: ${event.message}` : event.message, 'error');
  });

  function onKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape' || event.defaultPrevented || form.isOpen()) return;
    if (!store.getState().selected) return;
    event.preventDefault();
    selectFromUi(null);
  }
  document.addEventListener('keydown', onKeydown);

  const ticker = window.setInterval(() => room.tick(), 1000);
  schedule();

  return {
    notify: (text, tone) => toasts.show(text, tone),
    dispose() {
      offStore();
      offUi();
      offEvents();
      document.removeEventListener('keydown', onKeydown);
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearInterval(ticker);
      scheduled = false;
      deps.root.replaceChildren();
    },
  };
}
