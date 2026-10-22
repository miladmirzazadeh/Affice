// Short notes that fade on their own: server errors and commands that could not be sent.

import { h } from './dom';

export interface Toasts {
  el: HTMLElement;
  show(text: string, tone?: 'info' | 'error'): void;
}

const LIFETIME_MS = 6000;
const MAX_VISIBLE = 3;

export function createToasts(): Toasts {
  const el = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });

  return {
    el,
    show(text, tone = 'info') {
      const toast = h('div', { class: `toast toast--${tone}`, dir: 'auto', text });
      el.append(toast);
      while (el.children.length > MAX_VISIBLE) el.firstElementChild?.remove();
      window.setTimeout(() => {
        toast.classList.add('is-leaving');
        window.setTimeout(() => toast.remove(), 200);
      }, LIFETIME_MS);
    },
  };
}
