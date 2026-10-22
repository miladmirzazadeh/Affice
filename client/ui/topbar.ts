// The top bar: the company, the connection state, the stats toggle and Add department.

import type { Connection, OfficeScene, OfficeState } from '../../shared/scene-api';
import type { UiState } from '../state/ui';
import { h, icon, setAttr, setText } from './dom';

const CONNECTION: Record<Connection, { label: string; title: string }> = {
  mock: { label: 'Mock', title: 'Replaying the mock timeline. Nothing reaches a server.' },
  connecting: { label: 'Connecting', title: 'Connecting to the office server.' },
  live: { label: 'Live', title: 'Connected to the office server.' },
  offline: { label: 'Offline', title: 'The office server is not reachable. Retrying in the background.' },
};

const STATS_INTERVAL_MS = 500;

export interface Topbar {
  el: HTMLElement;
  update(state: OfficeState, ui: UiState): void;
}

export function createTopbar(deps: { scene: OfficeScene; onAdd(): void; onToggleStats(): void }): Topbar {
  const company = h('span', { class: 'brand-name' });
  const connLabel = h('span', { class: 'conn-label' });
  const conn = h('span', { class: 'conn' }, h('span', { class: 'conn-dot', 'aria-hidden': 'true' }), connLabel);
  const brand = h('div', { class: 'brand' }, company, h('span', { class: 'brand-sub', text: 'Office' }), conn);

  const draws = h('span');
  const triangles = h('span');
  const fps = h('span');
  const readout = h('div', { class: 'stats', hidden: true, 'aria-label': 'Scene stats' }, draws, triangles, fps);
  const statsButton = h(
    'button',
    { class: 'pill-btn', type: 'button', 'aria-pressed': 'false', title: 'Draw calls, triangles and frame rate of the scene' },
    icon('stats'),
    h('span', { class: 'label', text: 'Stats' }),
  );
  const addButton = h(
    'button',
    { class: 'pill-btn pill-btn--primary', type: 'button' },
    icon('plus'),
    h('span', { class: 'label', text: 'Add department' }),
  );
  statsButton.addEventListener('click', deps.onToggleStats);
  addButton.addEventListener('click', deps.onAdd);

  const el = h('header', { class: 'topbar' }, brand, h('div', { class: 'top-actions' }, readout, statsButton, addButton));

  let timer: number | undefined;
  function readStats() {
    const stats = deps.scene.stats();
    setText(draws, `${stats.drawCalls} draws`);
    setText(triangles, `${stats.triangles < 1000 ? stats.triangles : `${(stats.triangles / 1000).toFixed(1)}k`} tris`);
    setText(fps, `${Math.round(stats.fps)} fps`);
  }

  return {
    el,
    update(state, ui) {
      setText(company, state.config.company);
      const connection = CONNECTION[state.connection];
      conn.dataset.state = state.connection;
      setText(connLabel, connection.label);
      setAttr(conn, 'title', connection.title);

      setAttr(statsButton, 'aria-pressed', String(ui.stats));
      readout.hidden = !ui.stats;
      if (ui.stats && timer === undefined) {
        readStats();
        timer = window.setInterval(readStats, STATS_INTERVAL_MS);
      } else if (!ui.stats && timer !== undefined) {
        window.clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
