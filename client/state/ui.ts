// UI-only state for the office chrome: the room tab, the department form and the stats toggle,
// plus the unsent chat drafts. Owned by the UI shell. The office itself lives in store.ts;
// the room panel is open while something is selected there, so it needs no flag of its own here.

import type { DataViewKind, Department } from '../../shared/types';

export type RoomTab = 'office' | DataViewKind;

export const ROOM_TABS: ReadonlyArray<{ id: RoomTab; label: string }> = [
  { id: 'office', label: 'Office' },
  { id: 'kanban', label: 'Kanban' },
  { id: 'branches', label: 'Branches' },
  { id: 'reports', label: 'Reports' },
  { id: 'decisions', label: 'Decisions' },
];

/** The tabs a department's panel offers. Branches only makes sense for a department with repos. */
export function tabsFor(department: Department): typeof ROOM_TABS {
  return ROOM_TABS.filter((tab) => tab.id !== 'branches' || department.repos.length > 0);
}

/** `template` is the id of a client/ui/templates.ts template the add form starts from (the lobby's quick buttons). */
export type FormState = { mode: 'add'; template?: string } | { mode: 'edit'; id: string } | null;

export interface UiState {
  /** The open tab of the room panel. Office keeps the scene in view; the others mount a data view. */
  tab: RoomTab;
  /** The department form, while it is open. */
  form: FormState;
  /** Shows the scene's draw calls, triangles and fps in the top bar. */
  stats: boolean;
}

export interface UiStore {
  get(): UiState;
  set(patch: Partial<UiState>): void;
  subscribe(listener: (state: UiState, previous: UiState) => void): () => void;
  /** Unsent chat text per department. Not reactive: the composer reads and writes it directly. */
  drafts: Map<string, string>;
}

export function createUiStore(initial: Partial<UiState> = {}): UiStore {
  let state: UiState = { tab: 'office', form: null, stats: false, ...initial };
  const listeners = new Set<(state: UiState, previous: UiState) => void>();

  return {
    get: () => state,
    set(patch) {
      const keys = Object.keys(patch) as (keyof UiState)[];
      if (keys.every((key) => patch[key] === state[key])) return;
      const previous = state;
      state = { ...state, ...patch };
      for (const listener of listeners) listener(state, previous);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    drafts: new Map(),
  };
}

export interface Emitter<T> {
  on(listener: (value: T) => void): () => void;
  emit(value: T): void;
}

/** A tiny event bus. main.ts uses it to let the chrome see every ServerEvent, errors included. */
export function createEmitter<T>(): Emitter<T> {
  const listeners = new Set<(value: T) => void>();
  return {
    on(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(value) {
      for (const listener of listeners) listener(value);
    },
  };
}
