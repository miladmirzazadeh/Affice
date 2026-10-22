// The project picker: shown while no project is open, and again from the lobby's "Open another project".
// It lists the recent projects and the user's Claude Code
// projects (GET /api/projects), offers a folder browser (GET /api/fs), and a choice sends project.open.
// Everything that comes from the server (names, paths, error messages) goes in through textContent only.

import type { FolderListing, ProjectSummary } from '../../../shared/types';
import { h, setText } from '../dom';
import { ago, fetchJson } from '../views/common';
import type { SetupScreen, SetupScreenDeps } from './index';
import { crumbs, shortenPath } from './paths';
import './project.css';

export interface ProjectPickerDeps extends SetupScreenDeps {
  /** Called right after a project was chosen (the lobby closes its dialog). */
  onChosen?(): void;
}

export interface ProjectPicker extends SetupScreen {
  /** Loads the lists again (the picker was hidden, or the recent projects changed). */
  refresh(): void;
}

/** A second click on the same project within this time is ignored while it opens. */
const REOPEN_GUARD_MS = 3000;
/** A refresh within this time of the last load is skipped. */
const REFRESH_GUARD_MS = 500;
/** The "Opening ..." note stays this long. */
const NOTE_MS = 6000;

export function createProjectPicker(deps: ProjectPickerDeps): ProjectPicker {
  let projects: ProjectSummary[] | null = null;
  let loadError = '';
  let appRecent: ProjectSummary[] = [];
  let requested = 0;
  let pending: { path: string; at: number } | null = null;
  let noteTimer: number | undefined;

  // The lists ------------------------------------------------------------------------------------------
  const recentList = h('ul', { class: 'project-list', 'aria-label': 'Recent projects' });
  const recent = h('section', { class: 'project-group', hidden: true }, h('h2', { class: 'setup-subtitle', text: 'Recent' }), recentList);
  const claudeList = h('ul', { class: 'project-list', 'aria-label': 'Claude Code projects' });
  const claude = h('section', { class: 'project-group', hidden: true }, h('h2', { class: 'setup-subtitle', text: 'From Claude Code' }), claudeList);
  const status = h('p', { class: 'setup-note', role: 'status' });
  const note = h('p', { class: 'setup-note project-note', role: 'status', hidden: true });

  function row(project: ProjectSummary): HTMLElement {
    const button = h(
      'button',
      { class: 'project-row', type: 'button', title: project.path },
      h(
        'span',
        { class: 'project-line' },
        h('span', { class: 'project-name', dir: 'auto', text: project.name }),
        project.hasOffice ? h('span', { class: 'project-badge', text: 'Has an Office' }) : null,
      ),
      h(
        'span',
        { class: 'project-line' },
        h('span', { class: 'project-path', text: shortenPath(project.path) }),
        project.lastUsedAt ? h('span', { class: 'project-used', text: ago(project.lastUsedAt) }) : null,
      ),
    );
    button.addEventListener('click', () => choose(project.path, project.name));
    return h('li', {}, button);
  }

  function render() {
    const all = projects ?? appRecent;
    const recents = all.filter((p) => p.source !== 'claude');
    const claudes = all.filter((p) => p.source === 'claude');
    recentList.replaceChildren(...recents.map(row));
    claudeList.replaceChildren(...claudes.map(row));
    recent.hidden = recents.length === 0;
    claude.hidden = claudes.length === 0;
    if (projects === null && all.length === 0) setText(status, loadError || 'Looking for your projects.');
    else if (all.length === 0) setText(status, loadError || 'No projects yet. Browse the folders below to pick one.');
    else setText(status, loadError);
    status.hidden = !status.textContent;
  }

  let loadedAt = 0;
  async function load() {
    const mine = (requested += 1);
    loadedAt = Date.now();
    try {
      const list = await fetchJson<ProjectSummary[]>('/api/projects');
      if (mine !== requested) return;
      projects = list;
      loadError = '';
    } catch (error) {
      if (mine !== requested) return;
      loadError = `The project list could not be loaded. ${(error as Error).message}`;
    }
    render();
  }

  // Choosing --------------------------------------------------------------------------------------------
  function choose(path: string, name: string) {
    const now = Date.now();
    if (pending && pending.path === path && now - pending.at < REOPEN_GUARD_MS) return;
    pending = { path, at: now };
    deps.send({ type: 'project.open', path });
    setText(note, `Opening ${name}. A new project takes a moment while Affice creates its Office folder.`);
    note.hidden = false;
    window.clearTimeout(noteTimer);
    noteTimer = window.setTimeout(() => {
      note.hidden = true;
    }, NOTE_MS);
    deps.onChosen?.();
  }

  // The folder browser ----------------------------------------------------------------------------------
  let listing: FolderListing | null = null;
  let showHidden = false;
  let browsing = false;
  let browseRequest = 0;

  const upButton = h('button', { class: 'btn btn--small', type: 'button', text: 'Up' });
  const homeButton = h('button', { class: 'btn btn--small', type: 'button', text: 'Home' });
  const crumbBar = h('nav', { class: 'browse-crumbs', 'aria-label': 'Folder path' });
  const hiddenBox = h('input', { type: 'checkbox', id: 'project-browse-hidden' });
  const hiddenLabel = h('label', { class: 'browse-hidden', for: 'project-browse-hidden' }, hiddenBox, h('span', { text: 'Show hidden' }));
  const folderList = h('ul', { class: 'browse-list', 'aria-label': 'Folders' });
  const browseError = h('p', { class: 'setup-error', role: 'alert', hidden: true });
  const current = h('span', { class: 'browse-current' });
  const useButton = h('button', { class: 'btn btn--primary', type: 'button', text: 'Use this folder' });
  const panel = h(
    'div',
    { class: 'browse-panel', hidden: true },
    h('div', { class: 'browse-bar' }, upButton, homeButton, crumbBar, hiddenLabel),
    folderList,
    browseError,
    h('div', { class: 'browse-foot' }, current, useButton),
  );
  const toggle = h('button', { class: 'btn', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'project-browse-panel' }, h('span', { text: 'Browse folders' }));
  panel.id = 'project-browse-panel';

  function folderRow(entry: FolderListing['folders'][number]): HTMLElement {
    const button = h(
      'button',
      { class: 'browse-row', type: 'button', title: entry.path },
      h('span', { class: 'browse-folder', 'aria-hidden': 'true' }),
      h('span', { class: 'browse-name', dir: 'auto', text: entry.name }),
      entry.hasOffice ? h('span', { class: 'project-badge', text: 'Has an Office' }) : null,
    );
    button.addEventListener('click', () => void browse(entry.path));
    return h('li', {}, button);
  }

  function renderBrowse() {
    if (!listing) {
      crumbBar.replaceChildren();
      folderList.replaceChildren();
      setText(current, '');
      upButton.disabled = true;
      useButton.disabled = true;
      return;
    }
    const steps = crumbs(listing.path);
    crumbBar.replaceChildren(
      ...steps.map((step, index) => {
        if (index === steps.length - 1) return h('span', { class: 'browse-crumb browse-crumb--here', 'aria-current': 'location', text: step.label });
        const link = h('button', { class: 'browse-crumb', type: 'button', text: step.label });
        link.addEventListener('click', () => void browse(step.path));
        return link;
      }),
    );
    crumbBar.scrollLeft = crumbBar.scrollWidth;
    folderList.replaceChildren(...listing.folders.map(folderRow));
    if (listing.folders.length === 0) folderList.replaceChildren(h('li', { class: 'browse-empty', text: 'No folders in here.' }));
    setText(current, shortenPath(listing.path));
    current.title = listing.path;
    upButton.disabled = listing.parent === null || browsing;
    useButton.disabled = browsing;
  }

  /** Lists a folder (the home folder without a path). A folder that cannot be read leaves the last listing in place. */
  async function browse(path?: string) {
    const mine = (browseRequest += 1);
    browsing = true;
    panel.setAttribute('aria-busy', 'true');
    browseError.hidden = true;
    try {
      const query = new URLSearchParams();
      if (path) query.set('path', path);
      if (showHidden) query.set('hidden', '1');
      const next = await fetchJson<FolderListing>(`/api/fs${query.size ? `?${query}` : ''}`);
      if (mine !== browseRequest) return;
      listing = next;
    } catch (error) {
      if (mine !== browseRequest) return;
      setText(browseError, (error as Error).message);
      browseError.hidden = false;
    } finally {
      if (mine === browseRequest) {
        browsing = false;
        panel.removeAttribute('aria-busy');
      }
    }
    if (mine === browseRequest) renderBrowse();
  }

  toggle.addEventListener('click', () => {
    const open = panel.hidden;
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open && !listing) {
      renderBrowse();
      void browse();
    }
  });
  upButton.addEventListener('click', () => {
    if (listing?.parent) void browse(listing.parent);
  });
  homeButton.addEventListener('click', () => void browse());
  hiddenBox.addEventListener('change', () => {
    showHidden = hiddenBox.checked;
    void browse(listing?.path);
  });
  useButton.addEventListener('click', () => {
    if (!listing) return;
    const name = listing.path.split('/').filter(Boolean).pop() ?? listing.path;
    choose(listing.path, name);
  });
  renderBrowse();

  // The screen ------------------------------------------------------------------------------------------
  const el = h(
    'div',
    { class: 'setup-screen setup-project' },
    h('h1', { class: 'setup-title', text: 'Choose a project' }),
    h('p', { class: 'setup-text', text: 'Pick the folder of a project. Affice creates an Office folder inside it for the departments, the board and the reports.' }),
    recent,
    claude,
    status,
    h('section', { class: 'project-group project-browse' }, toggle, panel),
    note,
  );

  let recentKey = '';
  let started = false;
  return {
    el,
    // A refresh right after a load (the screen was just shown and just updated) would only repeat it.
    refresh: () => {
      if (Date.now() - loadedAt > REFRESH_GUARD_MS) void load();
    },
    update(app) {
      appRecent = app.recent;
      const key = JSON.stringify(app.recent.map((p) => [p.path, p.name, p.lastUsedAt]));
      if (!started) {
        started = true;
        recentKey = key;
        render();
        void load();
        return;
      }
      if (key !== recentKey) {
        recentKey = key;
        void load();
      }
    },
  };
}

/** The setup gate's project screen. It loads its lists again every time the gate shows it. */
export function createProjectSetup(deps: SetupScreenDeps): SetupScreen {
  const picker = createProjectPicker(deps);
  let wasHidden = picker.el.hidden;
  new MutationObserver(() => {
    const hidden = picker.el.hidden;
    if (wasHidden && !hidden) picker.refresh();
    wasHidden = hidden;
  }).observe(picker.el, { attributes: true, attributeFilter: ['hidden'] });
  return picker;
}
