// The Decisions view: the cards that wait for the user, with their labels and a link into Trella. They
// are the cards labelled `decision` on every board of the project's Trella workspace, in one group per
// board titled with the board's name. A department's own board comes first, then the other boards in the
// order the server sends them. The general manager has no board of its own, so none comes first.

import type { DecisionCard, DecisionsView, Department } from '../../../shared/types';
import { ago, createLoader, createRoot, dataUrl, el, safeHttp, stamp, type DataView } from './common';

export function renderDecisions(container: HTMLElement, department: Department): DataView {
  const { root, body } = createRoot(container, department, 'dv-decisions');
  const loader = createLoader<DecisionsView>({
    body,
    loading: 'Loading decisions',
    url: () => dataUrl(department, 'decisions'),
    draw: (view) => draw(body, department, view),
  });
  void loader.load();
  return {
    refresh: () => loader.load(),
    dispose() {
      loader.dispose();
      root.remove();
    },
  };
}

function draw(body: HTMLElement, department: Department, view: DecisionsView): void {
  const bar = el('div', 'dv-bar', el('span', 'dv-title', 'Decisions'), el('span', 'dv-dim dv-small', `${view.cards.length} waiting for you`));
  const groups = byBoard(view.cards);

  if (department.kind === 'lobby' || department.trellaBoardId === null) {
    // The general manager, or a department whose board was not created: one group per board of the workspace.
    if (groups.length === 0) {
      body.replaceChildren(bar, group('All boards', [], 'No card with the label decision is open on any board of this project.'));
      return;
    }
    body.replaceChildren(bar, ...groups.map((entry) => group(entry.name, entry.cards)));
    return;
  }
  // The department's own board always has its group (titled with the board's name when a card says it), then the others.
  const own = groups.find((entry) => entry.boardId === department.trellaBoardId);
  const others = groups.filter((entry) => entry !== own);
  body.replaceChildren(
    bar,
    group(own?.name ?? department.name, own?.cards ?? [], 'No card with the label decision is open on this board.'),
    ...(others.length > 0 ? others.map((entry) => group(entry.name, entry.cards)) : [group('Other boards', [], 'No card with the label decision is open on the other boards.')]),
  );
}

interface BoardGroup {
  boardId: string;
  name: string;
  cards: DecisionCard[];
}

/** The cards grouped by board, in the order their boards first appear (the server sends them board by board). */
function byBoard(cards: DecisionCard[]): BoardGroup[] {
  const groups = new Map<string, BoardGroup>();
  for (const card of cards) {
    const entry = groups.get(card.boardId) ?? { boardId: card.boardId, name: card.boardName || card.boardId, cards: [] };
    entry.cards.push(card);
    groups.set(card.boardId, entry);
  }
  return [...groups.values()];
}

function group(title: string, cards: DecisionCard[], empty = ''): HTMLElement {
  const head = el('h3', 'dv-group-head', el('span', '', title), el('span', 'dv-small', String(cards.length)));
  if (cards.length === 0) return el('section', 'dv-group', head, el('p', 'dv-empty', empty));
  const list = el('ul', 'dv-cards');
  for (const card of cards) list.append(el('li', '', cardLink(card)));
  return el('section', 'dv-group', head, list);
}

function column(status: string): string {
  const words = status.replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function cardLink(card: DecisionCard): HTMLElement {
  const time = el('span', 'dv-card-time', ago(card.updatedAt));
  time.title = `Updated ${stamp(card.updatedAt)}`;
  const top = el('div', 'dv-card-top', el('span', 'dv-chip dv-chip-key', card.key), el('span', 'dv-chip', column(card.status)), time);
  const labels = el('div', 'dv-labels');
  for (const label of card.labels) labels.append(el('span', label.toLowerCase() === 'decision' ? 'dv-chip dv-chip-warn' : 'dv-chip', label));

  const title = el('span', 'dv-card-title', card.title);
  title.dir = 'auto';
  const children = [top, title, card.labels.length > 0 ? labels : null];
  const href = safeHttp(card.url);
  if (!href) return el('div', 'dv-card', ...children);
  const link = el('a', 'dv-card', ...children);
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}
