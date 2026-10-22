// Shared by the four data views: DOM helpers, fetching, and the
// load / loading / error cycle (their sheet is client/styles/views.css). Text from files, git or Trella only ever goes through
// textContent, never innerHTML.

import type { Department } from '../../../shared/types';
import { SERVER_DOWN_ADVICE } from '../format';
import { apiFetch } from '../session';

export interface DataView {
  /** Re-fetches and redraws. */
  refresh(): Promise<void>;
  dispose(): void;
}

export const SVG_NS = 'http://www.w3.org/2000/svg';

type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const child of children) if (child) node.append(child);
  return node;
}

export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
  parent?: Element,
  text?: string,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  if (text !== undefined) node.textContent = text;
  parent?.append(node);
  return node;
}

// ---------------------------------------------------------------------------------------------
// Time

const pad = (n: number) => String(n).padStart(2, '0');

export function stamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function localDay(iso: string): string {
  return stamp(iso).slice(0, 10);
}

/** A link target that is http or https, or null: nothing else is ever put in an href. */
export function safeHttp(url: string): string | null {
  try {
    const parsed = new URL(url, window.location.href);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

export function clock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function ago(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (Number.isNaN(seconds)) return '';
  const unit = (n: number, name: string) => `${n} ${name}${n === 1 ? '' : 's'} ago`;
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return unit(Math.max(1, Math.round(seconds / 60)), 'minute');
  if (seconds < 86400) return unit(Math.round(seconds / 3600), 'hour');
  if (seconds < 86400 * 14) return unit(Math.round(seconds / 86400), 'day');
  if (seconds < 86400 * 60) return unit(Math.round(seconds / (86400 * 7)), 'week');
  return unit(Math.round(seconds / (86400 * 30)), 'month');
}

// ---------------------------------------------------------------------------------------------
// Fetching

export class ViewError extends Error {}

function messageFrom(body: unknown): string | null {
  if (typeof body === 'object' && body !== null) {
    const b = body as { error?: unknown; message?: unknown };
    if (typeof b.error === 'string') return b.error;
    if (typeof b.error === 'object' && b.error !== null && typeof (b.error as { message?: unknown }).message === 'string') {
      return (b.error as { message: string }).message;
    }
    if (typeof b.message === 'string') return b.message;
  }
  return null;
}

export async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await apiFetch(url, { signal, headers: { accept: 'application/json' } });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ViewError(`The office server does not answer. ${SERVER_DOWN_ADVICE} Then try again.`);
  }
  if (!response.ok) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // not JSON: keep the generic message
    }
    const said = messageFrom(body);
    if (said) throw new ViewError(said);
    // A server error with nothing to say is usually the dev proxy with no office server behind it.
    if (response.status >= 500) throw new ViewError(`The office server does not answer (status ${response.status}). ${SERVER_DOWN_ADVICE} Then try again.`);
    throw new ViewError(`The office server answered ${response.status}.`);
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new ViewError('The office server sent something that is not data. Is it the office server on this address?');
  }
}

export const dataUrl = (department: Department, view: string, query = '') =>
  `/api/data/${encodeURIComponent(department.id)}/${view}${query}`;

export function reportUrl(department: Department, path: string): string {
  return `${dataUrl(department, 'report')}?path=${encodeURIComponent(path)}`;
}

/**
 * Opens a report in a new tab. A link cannot send the page's token, so the tab is opened inside the click
 * (the browser allows it), a one minute ticket for this one file is asked for with the token, and the tab
 * is pointed at the report with the ticket.
 */
export async function openReport(department: Department, path: string): Promise<void> {
  const tab = window.open('', '_blank');
  if (tab) tab.opener = null;
  try {
    const { ticket } = await fetchJson<{ ticket: string }>(`${dataUrl(department, 'report-ticket')}?path=${encodeURIComponent(path)}`);
    const url = `${reportUrl(department, path)}&ticket=${encodeURIComponent(ticket)}`;
    if (tab) tab.location.href = url;
    else window.open(url, '_blank', 'noopener,noreferrer');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The report could not be opened.';
    if (tab) tab.document.body.textContent = message;
  }
}

// ---------------------------------------------------------------------------------------------
// The shell of a view: a root with the department accent, a body, and the load cycle.

const ACCENTS = ['stone', 'amber', 'moss', 'sky', 'indigo', 'plum', 'rose'];

export function createRoot(container: HTMLElement, department: Department, extra = ''): { root: HTMLElement; body: HTMLElement } {
  const color = ACCENTS.includes(department.color) ? department.color : 'indigo';
  const body = el('div', 'dv-body');
  const root = el('div', `dv ${extra}`.trim(), body);
  root.style.setProperty('--dv-accent', `var(--dept-${color}, #8b8cff)`);
  container.replaceChildren(root);
  return { root, body };
}

export function showLoading(body: HTMLElement, text: string): void {
  const line = el('p', 'dv-state');
  line.setAttribute('role', 'status');
  line.textContent = text;
  body.replaceChildren(line);
}

export function showError(body: HTMLElement, message: string, retry: () => void): void {
  const text = el('p', 'dv-error-text');
  text.textContent = message;
  const button = el('button', 'dv-btn');
  button.type = 'button';
  button.textContent = 'Try again';
  button.addEventListener('click', retry);
  const box = el('div', 'dv-error', text, button);
  box.setAttribute('role', 'alert');
  body.replaceChildren(el('div', 'dv-pad', box));
}

export interface Loader {
  load(refresh?: boolean): Promise<void>;
  dispose(): void;
}

/** Fetches, shows "loading" the first time, hands the data to `draw`, and shows a readable error with a retry. */
export function createLoader<T>(options: {
  body: HTMLElement;
  loading: string;
  url: (refresh: boolean) => string;
  draw: (data: T) => void;
  onBusy?: (busy: boolean) => void;
}): Loader {
  let controller: AbortController | null = null;
  let disposed = false;
  let shown = false;

  async function load(refresh = false): Promise<void> {
    controller?.abort();
    const mine = new AbortController();
    controller = mine;
    if (!shown) showLoading(options.body, options.loading);
    options.onBusy?.(true);
    try {
      const data = await fetchJson<T>(options.url(refresh), mine.signal);
      if (disposed || mine.signal.aborted) return;
      options.draw(data);
      shown = true;
    } catch (error) {
      if (disposed || mine.signal.aborted) return;
      shown = false;
      showError(options.body, error instanceof Error ? error.message : String(error), () => void load(refresh));
    } finally {
      if (controller === mine) options.onBusy?.(false);
    }
  }

  return {
    load,
    dispose() {
      disposed = true;
      controller?.abort();
    },
  };
}
