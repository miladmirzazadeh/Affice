// Small DOM helpers for the office chrome. Text always goes in through textContent or text nodes;
// nothing from the server or the user ever passes through innerHTML.

type AttrValue = string | number | boolean | null | undefined;
export type Child = Node | string | null | undefined | false;

/** Creates an element. `class` sets className, `text` sets textContent, `true` sets an empty attribute. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, AttrValue> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (name === 'class') el.className = String(value);
    else if (name === 'text') el.textContent = String(value);
    else el.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children) {
    if (child !== null && child !== undefined && child !== false) el.append(child);
  }
  return el;
}

/** Sets textContent only when it changed, so streaming updates do not churn the DOM. */
export function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

export function setAttr(el: Element, name: string, value: string | null): void {
  if (value === null) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else if (el.getAttribute(name) !== value) {
    el.setAttribute(name, value);
  }
}

const SVG = 'http://www.w3.org/2000/svg';

// 16 by 16 line icons, drawn for this shell.
const ICONS = {
  close: 'M4.5 4.5l7 7M11.5 4.5l-7 7',
  plus: 'M8 3.5v9M3.5 8h9',
  edit: 'M10.2 3.3l2.5 2.5L6 12.5H3.5V10z',
  refresh: 'M12.6 6.2A4.8 4.8 0 1 0 12.8 9.5M12.8 3.4v2.9H9.9',
  send: 'M8 12.5v-9M4.2 7.2L8 3.5l3.8 3.7',
  stop: 'M5 5h6v6H5z',
  stats: 'M3.5 12.5v-3M8 12.5v-9M12.5 12.5v-6',
  more: 'M3.5 8h.01M8 8h.01M12.5 8h.01',
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, size = 16): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', name === 'stop' ? 'currentColor' : 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

const keyedChildren = new WeakMap<HTMLElement, Map<string, HTMLElement>>();

/**
 * Keeps `parent`'s children in step with `items`, keyed by id: new items are created, gone ones
 * removed, existing ones updated in place and moved only when their position changed.
 * `parent` must hold nothing but these children.
 */
export function syncList<T>(
  parent: HTMLElement,
  items: readonly T[],
  keyOf: (item: T) => string,
  create: (item: T) => HTMLElement,
  update: (el: HTMLElement, item: T, index: number) => void,
): void {
  const previous = keyedChildren.get(parent) ?? new Map<string, HTMLElement>();
  const keys = items.map(keyOf);
  const wanted = new Set(keys);
  for (const [key, el] of previous) if (!wanted.has(key)) el.remove();
  const next = new Map<string, HTMLElement>();
  items.forEach((item, index) => {
    const key = keys[index];
    const el = previous.get(key) ?? create(item);
    next.set(key, el);
    update(el, item, index);
    const at = parent.children[index] ?? null;
    if (at !== el) parent.insertBefore(el, at);
  });
  keyedChildren.set(parent, next);
}
