// The room panel of the open department: its header, the tabs (Branches only for a department with
// repos, so not for the general manager), the agents roster and the manager chat. Office keeps the scene in view; the other tabs mount a data view in the stage
// beside the chat (wide screens) or in place of it (narrow screens).

import type { OfficeState } from '../../shared/scene-api';
import type { DataViewKind, Department } from '../../shared/types';
import type { Store } from '../state/store';
import { ROOM_TABS, tabsFor, type RoomTab, type UiState, type UiStore } from '../state/ui';
import { createChat } from './chat';
import { h, icon, setAttr, setText } from './dom';
import { approvalsOf, colorVar, openDepartment, sessionOf } from './derive';
import { POLICY, SESSION_LABEL, plural } from './format';
import { createRoster } from './roster';
import type { Toasts } from './toast';
import { renderView, type DataView } from './views/index';

export interface Room {
  el: HTMLElement;
  update(state: OfficeState, ui: UiState): void;
  /** Refreshes the elapsed times once a second. */
  tick(): void;
}

export interface RoomDeps {
  store: Store;
  ui: UiStore;
  toasts: Toasts;
  onClose(): void;
  onEdit(id: string): void;
  onSelectAgent(id: string): void;
}

interface Mounted {
  kind: DataViewKind;
  department: Department;
  trellaUrl: string;
  host: HTMLElement;
  view: DataView | null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createRoom(deps: RoomDeps): Room {
  let currentId: string | null = null;
  let lastTab: RoomTab = 'office';
  let mounted: Mounted | null = null;
  /** The tabs the open department offers, in order. */
  let visibleTabs: RoomTab[] = ROOM_TABS.map((t) => t.id);

  // Header.
  const name = h('h2', { class: 'room-name', id: 'room-name', dir: 'auto' });
  const stateDot = h('span', { class: 'state-dot', 'aria-hidden': 'true' });
  const stateText = h('span');
  const policy = h('span', { class: 'room-policy' });
  // With Bypass on, the policy line gives way to the same red mark the lobby shows.
  const bypassMark = h('span', { class: 'room-policy bypass-mark', hidden: true, title: 'The manager runs every tool without asking', text: 'Approvals off' });
  const edit = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Edit department', title: 'Edit department' }, icon('edit'));
  const close = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close the room', title: 'Close (Escape)' }, icon('close'));
  edit.addEventListener('click', () => currentId && deps.onEdit(currentId));
  close.addEventListener('click', deps.onClose);
  const head = h(
    'header',
    { class: 'room-head' },
    h('span', { class: 'room-swatch', 'aria-hidden': 'true' }),
    h('div', { class: 'room-title' }, name, h('div', { class: 'room-meta' }, h('span', { class: 'room-state' }, stateDot, stateText), policy, bypassMark)),
    h('div', { class: 'room-actions' }, edit, close),
  );

  // Tabs.
  const tabButtons = new Map<RoomTab, HTMLButtonElement>();
  const officeBadge = h('span', { class: 'tab-badge', hidden: true });
  const tablist = h('div', { class: 'room-tablist', role: 'tablist', 'aria-label': 'Room views' });
  for (const tab of ROOM_TABS) {
    const button = h('button', { class: 'tab', type: 'button', role: 'tab', id: `room-tab-${tab.id}`, tabindex: '-1' }, tab.label);
    if (tab.id === 'office') button.append(officeBadge);
    button.addEventListener('click', () => deps.ui.set({ tab: tab.id }));
    tabButtons.set(tab.id, button);
    tablist.append(button);
  }
  tablist.addEventListener('keydown', (event) => {
    const ids = visibleTabs;
    const at = ids.indexOf(deps.ui.get().tab);
    const next =
      event.key === 'ArrowRight' ? (at + 1) % ids.length
      : event.key === 'ArrowLeft' ? (at - 1 + ids.length) % ids.length
      : event.key === 'Home' ? 0
      : event.key === 'End' ? ids.length - 1
      : -1;
    if (next < 0) return;
    event.preventDefault();
    deps.ui.set({ tab: ids[next] });
    tabButtons.get(ids[next])?.focus();
  });
  const refresh = h(
    'button',
    { class: 'icon-btn room-refresh', type: 'button', 'aria-label': 'Refresh the view', title: 'Refresh', hidden: true },
    icon('refresh'),
  );
  refresh.addEventListener('click', () => {
    mounted?.view?.refresh().catch((error: unknown) => deps.toasts.show(`The view could not refresh: ${message(error)}`, 'error'));
  });
  const tabs = h('nav', { class: 'room-tabs', 'aria-label': 'Room' }, tablist, refresh);

  // Body: the stage for data views, and the side with the roster and the chat.
  const stage = h('div', { class: 'room-stage', id: 'room-stage', role: 'tabpanel', hidden: true });
  const roster = createRoster({ onSelect: deps.onSelectAgent });
  const chat = createChat({ store: deps.store, ui: deps.ui, toasts: deps.toasts });
  const side = h('div', { class: 'room-side' }, roster.el, chat.el);

  const el = h('section', { class: 'room', 'aria-labelledby': 'room-name', hidden: true }, head, tabs, stage, side);

  function unmount() {
    if (!mounted) return;
    try {
      mounted.view?.dispose();
    } catch (error) {
      console.error('office: a data view failed to dispose', error);
    }
    mounted.host.remove();
    mounted = null;
  }

  function mount(kind: DataViewKind, department: Department, trellaUrl: string) {
    const host = h('div', { class: 'view-host' });
    stage.append(host);
    let view: DataView | null = null;
    try {
      view = renderView(kind, host, department, trellaUrl);
    } catch (error) {
      host.replaceChildren(h('p', { class: 'view-error', text: `This view could not open: ${message(error)}` }));
    }
    mounted = { kind, department, trellaUrl, host, view };
  }

  /** One view at a time; switching tab, department or its settings disposes the old one first. */
  function syncView(kind: DataViewKind | null, department: Department | null, trellaUrl: string) {
    if (mounted && (mounted.kind !== kind || mounted.department !== department || mounted.trellaUrl !== trellaUrl)) unmount();
    if (!mounted && kind && department) mount(kind, department, trellaUrl);
  }

  return {
    el,
    update(state, ui) {
      const department = openDepartment(state);
      el.hidden = !department;
      if (!department) {
        syncView(null, null, '');
        currentId = null;
        return;
      }
      currentId = department.id;

      // A tab the department does not offer (Branches without repos) gives way to Office.
      const available = tabsFor(department);
      visibleTabs = available.map((t) => t.id);
      if (!visibleTabs.includes(ui.tab)) {
        deps.ui.set({ tab: 'office' });
        ui = { ...ui, tab: 'office' };
      }

      el.style.setProperty('--dept', colorVar(department.color));
      setText(name, department.name);
      const status = sessionOf(state, department.id)?.status ?? 'off';
      stateDot.dataset.status = status;
      setText(stateText, SESSION_LABEL[status]);
      const bypass = sessionOf(state, department.id)?.bypass === true;
      setText(policy, POLICY[department.permission]?.short ?? department.permission);
      policy.hidden = bypass;
      bypassMark.hidden = !bypass;

      for (const [id, button] of tabButtons) {
        button.hidden = !visibleTabs.includes(id);
        const selected = id === ui.tab;
        setAttr(button, 'aria-selected', String(selected));
        setAttr(button, 'tabindex', selected ? '0' : '-1');
        setAttr(button, 'aria-controls', selected && id !== 'office' ? 'room-stage' : null);
      }
      const waiting = approvalsOf(state, department.id).length;
      officeBadge.hidden = ui.tab === 'office' || waiting === 0;
      setText(officeBadge, String(waiting));
      setAttr(officeBadge, 'aria-label', waiting ? `${plural(waiting, 'approval')} waiting` : null);

      const kind = ui.tab === 'office' ? null : ui.tab;
      el.classList.toggle('has-view', kind !== null);
      refresh.hidden = kind === null;
      stage.hidden = kind === null;
      setAttr(stage, 'aria-labelledby', kind ? `room-tab-${kind}` : null);
      syncView(kind, department, state.config.trellaUrl);

      roster.update(state, department.id);
      chat.update(state, department);
      if (ui.tab !== lastTab && ui.tab === 'office') chat.scrollToEnd();
      lastTab = ui.tab;
    },
    tick() {
      if (!el.hidden) roster.tick();
    },
  };
}
