// The Branches view: a metro map per repo, drawn by hand as SVG.
//
// One horizontal line per repo is the base branch, named in a pill at its left end. Every other
// branch is a lane that rises from the line and ends in a station: in flight in the department
// accent, stale in amber, leftover dim, nearest lanes first. The station row carries the name,
// ahead and behind the base, a dot when a worktree holds the branch (amber when it has
// uncommitted changes), and the card key. Trunk branches other than the base (main when the
// base is deploy) sit on the line as rings. Hover or focus a station for the last commit.

import type { BranchInfo, BranchState, BranchesView, Department, RepoBranches } from '../../../shared/types';
import { ago, clock, createLoader, createRoot, dataUrl, el, stamp, svgEl, type DataView } from './common';

const FONT = 11.5;
const CHAR = FONT * 0.6; // the labels are monospace
const ROW = 24; // distance between lanes
const STEP = 6; // distance between the risers of two lanes
const CORNER = 7;
const PAD_TOP = 10;
const GAP = 20; // between the line and the nearest lane
const BELOW = 40; // under the line, for trunk labels
const MIN_WIDTH = 520;
const KEY_W = 64;
const TREE_W = 46;
const MET_W = 80;
const TRUNK_SPACING = 190;

const RANK: Record<BranchState, number> = { 'in-flight': 0, stale: 1, leftover: 2, base: 3 };
const WORDS: Record<BranchState, string> = { 'in-flight': 'in flight', stale: 'stale', leftover: 'leftover', base: 'trunk' };

export function renderBranches(container: HTMLElement, department: Department): DataView {
  const { root, body } = createRoot(container, department, 'dv-branches');
  const tip = createTip(root);
  let view: BranchesView | null = null;
  let refreshButton: HTMLButtonElement | null = null;
  let drawnWidth = 0;
  let frame = 0;

  const loader = createLoader<BranchesView>({
    body,
    loading: 'Reading the repositories',
    url: (refresh) => dataUrl(department, 'branches', refresh ? '?refresh=1' : ''),
    draw: (data) => {
      view = data;
      paint();
    },
    onBusy: (busy) => {
      if (!refreshButton) return;
      refreshButton.disabled = busy;
      refreshButton.textContent = busy ? 'Refreshing' : 'Refresh';
    },
  });

  const mapWidth = () => Math.max(MIN_WIDTH, body.clientWidth - 32);

  function paint(): void {
    if (!view) return;
    tip.hide();
    drawnWidth = body.clientWidth;
    const data = view;

    refreshButton = el('button', 'dv-btn');
    refreshButton.type = 'button';
    refreshButton.textContent = 'Refresh';
    refreshButton.addEventListener('click', () => void loader.load(true));
    const updated = el('span', 'dv-stamp', `Updated ${clock(data.generatedAt)}`);
    updated.title = stamp(data.generatedAt);
    const bar = el('div', 'dv-bar', el('span', 'dv-title', 'Branches'), legend(data.staleDays), el('span', 'dv-bar-grow'), updated, refreshButton);

    const repos = el('div', 'dv-repos');
    const width = mapWidth();
    for (const repo of data.repos) repos.append(repoBlock(repo, width, tip));
    body.replaceChildren(bar, repos);
  }

  // The map is as wide as the panel, so it is drawn again when the panel changes width.
  const observer = new ResizeObserver(() => {
    if (!view || Math.abs(body.clientWidth - drawnWidth) < 8) return;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(paint);
  });
  observer.observe(body);

  void loader.load();
  return {
    // Asked for by a person (the shell's Refresh button), so it skips the server's 10 s cache too.
    refresh: () => loader.load(true),
    dispose() {
      cancelAnimationFrame(frame);
      observer.disconnect();
      loader.dispose();
      root.remove();
    },
  };
}

// ---------------------------------------------------------------------------------------------

function legend(staleDays: number): HTMLElement {
  const item = (swatch: string, text: string, title: string) => {
    const entry = el('span', '', el('i', `dv-swatch ${swatch}`), text);
    entry.title = title;
    return entry;
  };
  return el(
    'div',
    'dv-legend',
    item('dv-s-in-flight', 'In flight', `Not merged, and a commit in the last ${staleDays} days or changes in its worktree`),
    item('dv-s-stale', 'Stale', `Not merged, and no commit for ${staleDays} days or more`),
    item('dv-s-leftover', 'Leftover', 'Merged: its commits are already on the base or on another trunk branch'),
    item('dv-swatch-ring', 'Trunk', 'A long-lived branch such as main or deploy, drawn on the line'),
    item('dv-swatch-tree', 'Worktree', 'A folder holds this branch. Amber when it has uncommitted changes'),
  );
}

function repoBlock(repo: RepoBranches, width: number, tip: Tip): HTMLElement {
  const head = el('div', 'dv-repo-head', el('span', 'dv-repo-name', repo.name), el('span', 'dv-chip', `base ${repo.base}`));
  if (!repo.ok) {
    const box = el('div', 'dv-error', el('p', 'dv-error-text', repo.error ?? 'This repository cannot be read.'), el('span', 'dv-dim dv-small dv-mono', repo.path));
    box.setAttribute('role', 'alert');
    return el('section', '', head, box);
  }
  for (const state of ['in-flight', 'stale', 'leftover'] as const) {
    const count = repo.branches.filter((branch) => branch.state === state).length;
    if (count === 0) continue;
    const label = el('span', `dv-repo-count dv-s-${state}`, el('b', '', String(count)), ` ${WORDS[state]}`);
    head.append(label);
  }
  return el('section', '', head, drawMap(repo, width, tip));
}

function laneOrder(a: BranchInfo, b: BranchInfo): number {
  return RANK[a.state] - RANK[b.state] || b.lastCommitAt.localeCompare(a.lastCommitAt) || a.name.localeCompare(b.name);
}

/** Keeps the start and the end of a long name: agent branches differ at the end. */
function shorten(name: string, max: number): string {
  if (name.length <= max) return name;
  const keep = Math.max(2, max - 1);
  const tail = Math.floor(keep * 0.35);
  return `${name.slice(0, keep - tail)}…${name.slice(name.length - tail)}`;
}

function describe(branch: BranchInfo, base: string): string {
  return `${branch.name}, ${WORDS[branch.state]}, ${branch.ahead} ahead, ${branch.behind} behind ${base}`;
}

function drawMap(repo: RepoBranches, width: number, tip: Tip): SVGSVGElement {
  const lanes = repo.branches.filter((branch) => branch.state !== 'base').sort(laneOrder);
  const trunks = repo.branches.filter((branch) => branch.state === 'base');
  const baseBranch = trunks.find((branch) => branch.name === repo.base) ?? null;
  const others = trunks.filter((branch) => branch.name !== repo.base);

  const n = lanes.length;
  // The pill holds the base name, then a worktree dot with its count of changed files.
  const nameW = repo.base.length * CHAR;
  const dirtyText = baseBranch?.worktree && baseBranch.dirty ? String(baseBranch.dirty) : '';
  const treeW = baseBranch?.worktree ? (dirtyText ? 20 + dirtyText.length * 6.6 : 14.5) : 0;
  const pillW = Math.max(56, Math.ceil(nameW + treeW + 22));
  const x0 = 6 + pillW;
  const riserLeft = x0 + 14;
  const xs = riserLeft + Math.max(0, n - 1) * STEP + CORNER + 24; // the column of stations
  const baseY = n > 0 ? PAD_TOP + n * ROW + GAP : PAD_TOP + 16;
  const height = baseY + BELOW;
  const W = Math.max(width, MIN_WIDTH, xs + 12 + 110 + MET_W + TREE_W + KEY_W + 10);

  const xKeyEnd = W - 8;
  const xTree = xKeyEnd - KEY_W - TREE_W;
  const xMet = xTree - MET_W;
  const nameChars = Math.max(6, Math.floor((xMet - (xs + 14) - 8) / CHAR));

  const svg = svgEl('svg', { class: 'dv-svg', width: W, height, viewBox: `0 0 ${W} ${height}`, role: 'group', 'aria-label': `Branches of ${repo.name}` });

  // The base: the line, and its name in a pill.
  svgEl('line', { class: 'dv-trunk-line', x1: x0 - 4, y1: baseY, x2: W - 8, y2: baseY }, svg);

  lanes.forEach((branch, k) => {
    const y = PAD_TOP + (n - 1 - k) * ROW + ROW / 2;
    const riser = riserLeft + (n - 1 - k) * STEP;
    const g = station(svg, `dv-s-${branch.state}`, describe(branch, repo.base), tip, () => branchTip(branch, repo.base));
    svgEl('rect', { class: 'dv-hit', x: xs - 14, y: y - ROW / 2, width: W - xs + 6, height: ROW, rx: 6 }, g);
    svgEl('path', { class: 'dv-lane', d: `M ${riser} ${baseY} V ${y + CORNER} Q ${riser} ${y} ${riser + CORNER} ${y} H ${xs}` }, g);
    const radius = branch.state === 'leftover' ? 3.5 : 5;
    if (branch.state === 'in-flight') svgEl('circle', { class: 'dv-halo', cx: xs, cy: y, r: radius + 4 }, g);
    svgEl('circle', { class: 'dv-station-dot', cx: xs, cy: y, r: radius }, g);
    svgEl('text', { class: 'dv-name', x: xs + 14, y: y + 4 }, g, shorten(branch.name, nameChars));

    svgEl('text', { class: `dv-metric ${branch.ahead > 0 ? 'dv-metric-ahead' : ''}`, x: xMet, y: y + 4 }, g, `↑${branch.ahead}`);
    svgEl('text', { class: 'dv-metric', x: xMet + 40, y: y + 4 }, g, `↓${branch.behind}`);
    treeDot(g, xTree + 4, y, branch);
    if (branch.cardKey) {
      const w = branch.cardKey.length * 6.6 + 10;
      svgEl('rect', { class: 'dv-key-rect', x: xKeyEnd - w, y: y - 8, width: w, height: 16, rx: 4 }, g);
      svgEl('text', { class: 'dv-key-text', x: xKeyEnd - w / 2, y: y + 4, 'text-anchor': 'middle' }, g, branch.cardKey);
    }
  });

  if (n === 0) svgEl('text', { class: 'dv-metric', x: xs, y: baseY - 12 }, svg, 'No other branches');

  // Trunks other than the base sit on the line as rings, labelled underneath.
  others.forEach((branch, i) => {
    const x = xs + i * TRUNK_SPACING;
    const g = station(svg, 'dv-s-base', describe(branch, repo.base), tip, () => branchTip(branch, repo.base));
    svgEl('rect', { class: 'dv-hit', x: x - 14, y: baseY - 12, width: TRUNK_SPACING - 10, height: BELOW + 4, rx: 6 }, g);
    svgEl('circle', { class: 'dv-trunk-dot', cx: x, cy: baseY, r: 6 }, g);
    const label = `${shorten(branch.name, 16)}  ↑${branch.ahead} ↓${branch.behind}`;
    svgEl('text', { class: 'dv-name', x: x - 6, y: baseY + 24 }, g, label);
    treeDot(g, x - 6 + label.length * CHAR + 12, baseY + 21, branch);
  });

  // The pill is drawn last so it sits over the start of the line.
  const pill = station(svg, 'dv-s-base', baseBranch ? describe(baseBranch, repo.base) : `${repo.base}, the base`, tip, () =>
    baseBranch ? branchTip(baseBranch, repo.base) : plainTip(repo.base, 'The base branch is not a local branch here.'),
  );
  svgEl('rect', { class: 'dv-hit', x: 4, y: baseY - 14, width: pillW + 4, height: 28, rx: 8 }, pill);
  svgEl('rect', { class: 'dv-pill', x: 6, y: baseY - 11, width: pillW, height: 22, rx: 11 }, pill);
  const startX = 6 + (pillW - nameW - treeW) / 2;
  svgEl('text', { class: 'dv-pill-text', x: startX, y: baseY + 4 }, pill, repo.base);
  if (baseBranch) treeDot(pill, startX + nameW + 11, baseY, baseBranch);

  return svg;
}

function station(svg: SVGSVGElement, className: string, label: string, tip: Tip, content: () => HTMLElement): SVGGElement {
  const g = svgEl('g', { class: `dv-station ${className}`, tabindex: 0, role: 'img', 'aria-label': label }, svg);
  g.addEventListener('pointerenter', (event) => tip.show(content(), event.clientX, event.clientY));
  g.addEventListener('pointermove', (event) => tip.move(event.clientX, event.clientY));
  g.addEventListener('pointerleave', () => tip.hide());
  g.addEventListener('focus', () => {
    const box = g.getBoundingClientRect();
    tip.show(content(), box.left + Math.min(120, box.width / 2), box.bottom - box.height / 2);
  });
  g.addEventListener('blur', () => tip.hide());
  return g;
}

/** A dot when a worktree holds the branch: green when clean, amber with the number of changed files when not. */
function treeDot(parent: Element, x: number, y: number, branch: BranchInfo): void {
  if (!branch.worktree) return;
  const dirty = branch.dirty;
  if (dirty === null) {
    svgEl('circle', { class: 'dv-tree-unknown', cx: x, cy: y, r: 3.5 }, parent);
    return;
  }
  svgEl('circle', { class: `dv-tree ${dirty > 0 ? 'dv-dirty' : ''}`, cx: x, cy: y, r: 3.5 }, parent);
  if (dirty > 0) svgEl('text', { class: 'dv-metric dv-metric-dirty', x: x + 9, y: y + 4 }, parent, String(dirty));
}

// ---------------------------------------------------------------------------------------------
// The tooltip: one box for the whole view, placed beside the pointer and kept inside the window.

interface Tip {
  show(content: HTMLElement, x: number, y: number): void;
  move(x: number, y: number): void;
  hide(): void;
}

function createTip(root: HTMLElement): Tip {
  const box = el('div', 'dv-tip');
  box.setAttribute('role', 'tooltip');
  root.append(box);

  function place(clientX: number, clientY: number): void {
    const anchor = root.getBoundingClientRect();
    const w = box.offsetWidth;
    const h = box.offsetHeight;
    let x = clientX + 14;
    let y = clientY + 16;
    if (x + w > window.innerWidth - 8) x = Math.max(8, clientX - w - 14);
    if (y + h > window.innerHeight - 8) y = Math.max(8, clientY - h - 12);
    box.style.left = `${x - anchor.left}px`;
    box.style.top = `${y - anchor.top}px`;
  }

  return {
    show(content, x, y) {
      box.replaceChildren(content);
      box.classList.add('dv-tip-on');
      place(x, y);
    },
    move: place,
    hide() {
      box.classList.remove('dv-tip-on');
    },
  };
}

function plainTip(name: string, text: string): HTMLElement {
  return el('div', '', el('div', 'dv-tip-name', name), el('div', 'dv-tip-line', text));
}

function branchTip(branch: BranchInfo, base: string): HTMLElement {
  const state = el('span', `dv-tip-state dv-s-${branch.state}`, WORDS[branch.state]);
  const lines: HTMLElement[] = [el('div', 'dv-tip-name', branch.name, state)];
  const line = (...parts: Array<Node | string>) => lines.push(el('div', 'dv-tip-line', ...parts));

  if (branch.name === base) line('The base: everything on this line is measured against it.');
  else line(el('b', '', `${branch.ahead} ahead`), `, ${branch.behind} behind ${base}`);

  if (branch.subject) {
    const subject = el('div', 'dv-tip-line', el('b', '', branch.subject));
    subject.dir = 'auto';
    lines.push(subject);
  }
  const when = `${branch.author || 'Unknown author'}, ${ago(branch.lastCommitAt)} (${stamp(branch.lastCommitAt)})`;
  line(when);

  if (branch.worktree) {
    const changes = branch.dirty === null ? 'changes unknown' : branch.dirty === 0 ? 'clean' : `${branch.dirty} changed ${branch.dirty === 1 ? 'file' : 'files'}`;
    line(`Worktree ${branch.worktree}, ${changes}`);
  }
  if (branch.cardKey) line(`Card ${branch.cardKey}`);
  if (branch.state === 'leftover') line('Merged: its commits are already on a trunk branch.');
  if (branch.state === 'stale') {
    const days = Math.floor((Date.now() - new Date(branch.lastCommitAt).getTime()) / 86_400_000);
    line(`No commit for ${days} days.`);
  }
  return el('div', '', ...lines);
}
