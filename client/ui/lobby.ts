// The lobby: the project's name as its heading with a small menu (recent projects, open another project,
// close the project), then every department with its session state, its agents and its waiting approvals,
// the general manager first. A red mark shows where approvals are off. Clicking one opens its room.
// An office with only the general manager shows an invitation to add the first department.

import type { OfficeState } from '../../shared/scene-api';
import type { AppState, ClientCommand, Department, ProjectSummary } from '../../shared/types';
import { h, icon, setAttr, setText, syncList } from './dom';
import { approvalsOf, colorVar, openDepartment, sessionOf } from './derive';
import { SERVER_DOWN_ADVICE, SESSION_LABEL, plural } from './format';
import { createProjectPicker } from './setup/project';
import { shortenPath } from './setup/paths';
import { DEPARTMENT_TEMPLATES } from './templates';
import './lobby.css';

export interface Lobby {
  el: HTMLElement;
  update(state: OfficeState): void;
}

export interface LobbyDeps {
  onSelect(id: string): void;
  /** Opens the department form, from a template when one is given. */
  onAdd(template?: string): void;
  /** Sends an app command (project.open, project.close). */
  send(command: ClientCommand): void;
}

/** How many recent projects the menu lists. */
const MENU_RECENT = 6;

export function createLobby(deps: LobbyDeps): Lobby {
  // The heading: the project's name, and its menu.
  const title = h('h2', { class: 'lobby-title', id: 'lobby-title', dir: 'auto' });
  const menuButton = h(
    'button',
    { class: 'icon-btn lobby-menu-button', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': 'lobby-menu', 'aria-label': 'Project menu', hidden: true },
    icon('more'),
  );
  const head = h('div', { class: 'lobby-head' }, title, menuButton);
  const count = h('span', { class: 'lobby-count' });
  const sub = h('div', { class: 'lobby-sub' }, h('span', { class: 'lobby-sub-label', text: 'Departments' }), count);
  const list = h('ul', { class: 'lobby-list' });

  // The menu is a popover: it sits in the top layer, so the lobby's clipping does not cut it, and it
  // closes on a click outside and on Escape.
  const menu = h('div', { class: 'lobby-menu', id: 'lobby-menu', role: 'menu', 'aria-label': 'Project menu', popover: 'auto' });
  const menuItems = (): HTMLButtonElement[] => [...menu.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')];

  function menuItem(label: string, detail: string | null, onClick: () => void, className = ''): HTMLButtonElement {
    const item = h(
      'button',
      { class: `lobby-menu-item ${className}`.trim(), type: 'button', role: 'menuitem' },
      h('span', { class: 'lobby-menu-label', dir: 'auto', text: label }),
      detail ? h('span', { class: 'lobby-menu-detail', text: detail }) : null,
    );
    item.addEventListener('click', () => {
      menu.hidePopover();
      onClick();
    });
    return item;
  }

  // "Open another project" shows the same picker as the first screen, in a dialog: nothing changes until
  // a project is chosen, and Escape leaves everything as it was.
  const closeDialog = h('button', { class: 'icon-btn project-dialog-close', type: 'button', 'aria-label': 'Close' }, icon('close'));
  const picker = createProjectPicker({ send: deps.send, onChosen: () => dialog.close() });
  const dialog = h('dialog', { class: 'project-dialog', 'aria-label': 'Open another project' }, closeDialog, picker.el);
  closeDialog.addEventListener('click', () => dialog.close());
  // The picker loads its lists when the dialog is first opened, not before.
  let pickerStarted = false;
  let latest: OfficeState | null = null;
  function openPicker() {
    dialog.showModal();
    if (latest?.app && !pickerStarted) picker.update(latest.app, latest);
    else picker.refresh();
    pickerStarted = true;
  }

  let app: AppState | null = null;
  function buildMenu() {
    const current = app?.project ?? null;
    const others: ProjectSummary[] = (app?.recent ?? []).filter((p) => p.path !== current?.path).slice(0, MENU_RECENT);
    menu.replaceChildren(
      h('p', { class: 'lobby-menu-heading', role: 'presentation', text: 'Recent projects' }),
      ...(others.length
        ? others.map((p) => menuItem(p.name, shortenPath(p.path), () => deps.send({ type: 'project.open', path: p.path })))
        : [h('p', { class: 'lobby-menu-none', role: 'presentation', text: 'No other recent projects.' })]),
      h('hr', { class: 'lobby-menu-rule', role: 'separator' }),
      menuItem('Open another project', null, openPicker),
      menuItem('Close project', null, () => deps.send({ type: 'project.close' }), 'lobby-menu-item--quiet'),
    );
  }

  menuButton.addEventListener('click', () => {
    if (menu.matches(':popover-open')) {
      menu.hidePopover();
      return;
    }
    buildMenu();
    const box = menuButton.getBoundingClientRect();
    const width = 280;
    menu.style.top = `${Math.round(box.bottom + 6)}px`;
    menu.style.left = `${Math.round(Math.min(Math.max(8, box.left), window.innerWidth - width - 8))}px`;
    menu.showPopover();
    menuItems()[0]?.focus();
  });
  menu.addEventListener('toggle', (event) => {
    const open = (event as ToggleEvent).newState === 'open';
    menuButton.setAttribute('aria-expanded', String(open));
    if (!open && (document.activeElement === document.body || menu.contains(document.activeElement))) menuButton.focus();
  });
  menu.addEventListener('keydown', (event) => {
    const items = menuItems();
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const move = (index: number) => {
      event.preventDefault();
      items[(index + items.length) % items.length]?.focus();
    };
    if (event.key === 'ArrowDown') move(at + 1);
    else if (event.key === 'ArrowUp') move(at - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(items.length - 1);
  });

  // The empty office: an invitation with four starting points, or a word about the connection.
  const invite = h(
    'div',
    { class: 'lobby-invite' },
    h('h3', { class: 'lobby-invite-title', text: 'Add your first department' }),
    h('p', { class: 'lobby-empty-text', text: 'A department is a room with its own manager and a board for its work. Start from a template, or write your own.' }),
  );
  const templates = h('div', { class: 'lobby-templates', role: 'group', 'aria-label': 'Start from a template' });
  for (const template of DEPARTMENT_TEMPLATES) {
    const button = h('button', { class: 'template-chip', type: 'button' }, h('span', { class: 'template-dot', 'aria-hidden': 'true' }), h('span', { text: template.name }));
    button.style.setProperty('--c', colorVar(template.color));
    button.addEventListener('click', () => deps.onAdd(template.id));
    templates.append(button);
  }
  const inviteAdd = h('button', { class: 'btn btn--primary', type: 'button', text: 'Add department' });
  inviteAdd.addEventListener('click', () => deps.onAdd());
  invite.append(templates, inviteAdd);
  const emptyText = h('p', { class: 'lobby-empty-text' });
  const empty = h('div', { class: 'lobby-empty', hidden: true }, invite, emptyText);
  const el = h('nav', { class: 'lobby', 'aria-labelledby': 'lobby-title' }, head, sub, list, empty, menu, dialog);

  function create(department: Department): HTMLElement {
    const row = h(
      'button',
      { class: 'lobby-row', type: 'button' },
      h('span', { class: 'swatch', 'aria-hidden': 'true' }),
      h(
        'span',
        { class: 'lobby-text' },
        h(
          'span',
          { class: 'lobby-nameline' },
          h('span', { class: 'lobby-name' }),
          h('span', { class: 'bypass-mark', hidden: true, title: 'Approvals are off for this manager', text: 'Bypass' }),
        ),
        h(
          'span',
          { class: 'lobby-meta' },
          h('span', { class: 'state-dot', 'aria-hidden': 'true' }),
          h('span', { class: 'lobby-state' }),
          h('span', { class: 'lobby-agents' }),
        ),
      ),
      h('span', { class: 'badge', hidden: true }),
    );
    row.addEventListener('click', () => deps.onSelect(department.id));
    return h('li', { class: 'lobby-item', 'data-kind': department.kind ?? 'room' }, row);
  }

  function fill(item: HTMLElement, department: Department, state: OfficeState, openId: string | null) {
    const row = item.firstElementChild as HTMLButtonElement;
    row.style.setProperty('--row-color', colorVar(department.color));
    setAttr(row, 'aria-current', department.id === openId ? 'true' : null);
    setText(row.querySelector('.lobby-name')!, department.name);

    const session = sessionOf(state, department.id);
    const status = session?.status ?? 'off';
    (row.querySelector('.state-dot') as HTMLElement).dataset.status = status;
    setText(row.querySelector('.lobby-state')!, SESSION_LABEL[status]);
    // The general manager has no room and no desks of its own: its second label is where it sits.
    const subagents = state.agents.filter((a) => a.department === department.id && a.kind === 'subagent').length;
    const agents = row.querySelector('.lobby-agents') as HTMLElement;
    const lobby = department.kind === 'lobby';
    agents.hidden = !lobby && subagents === 0;
    setText(agents, lobby ? 'Lobby' : plural(subagents, 'agent'));
    (row.querySelector('.bypass-mark') as HTMLElement).hidden = session?.bypass !== true;

    const waiting = approvalsOf(state, department.id).length;
    const badge = row.querySelector('.badge') as HTMLElement;
    badge.hidden = waiting === 0;
    setText(badge, String(waiting));
    setAttr(badge, 'aria-label', waiting ? `${plural(waiting, 'approval')} waiting` : null);
  }

  let last: unknown[] = [];

  return {
    el,
    update(state) {
      const inputs = [state.config.departments, state.config.company, state.sessions, state.agents, state.permissions, state.selected, state.connection, state.app];
      if (inputs.every((value, i) => value === last[i])) return;
      last = inputs;

      // The project's name is the heading (and the window title) while a project is open; the mock has none.
      app = state.app;
      const project = state.app?.project ?? null;
      setText(title, project?.name ?? state.config.company);
      menuButton.hidden = project === null;
      document.title = project ? `${project.name} | Affice` : 'Affice';
      latest = state;
      if (state.app && dialog.open) picker.update(state.app, state);

      // The general manager first (its slot is -1), then the rooms in the order of their slots.
      const departments = [...state.config.departments].sort(
        (a, b) => Number(b.kind === 'lobby') - Number(a.kind === 'lobby') || a.slot - b.slot,
      );
      const rooms = departments.filter((d) => d.kind !== 'lobby').length;
      const openId = openDepartment(state)?.id ?? null;
      setText(count, rooms ? String(rooms) : '');
      syncList(list, departments, (d) => d.id, create, (item, d) => fill(item, d, state, openId));

      empty.hidden = rooms > 0;
      if (!rooms) {
        const live = state.connection === 'live' || state.connection === 'mock';
        invite.hidden = !live;
        emptyText.hidden = live;
        setText(
          emptyText,
          state.connection === 'connecting' ? 'Connecting to the office.' : state.connection === 'offline' ? `The office server is not reachable. ${SERVER_DOWN_ADVICE}` : '',
        );
      }
    },
  };
}
