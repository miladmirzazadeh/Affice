// The seam between the 3D scene (client/scene) and the rest of the client.
// Frozen by the coordinator. The scene reads the store; it never talks to the server.

import type { AppState, ClientCommand, OfficeSnapshot, ServerEvent } from './types';

export type Selection = { kind: 'department'; id: string } | { kind: 'agent'; id: string } | null;

export type Connection = 'mock' | 'connecting' | 'live' | 'offline';

export interface OfficeState extends OfficeSnapshot {
  selected: Selection;
  connection: Connection;
  /** The app around the office (Claude Code, the open project), from app.state; null until the first one arrives. */
  app: AppState | null;
}

export interface OfficeStore {
  getState(): OfficeState;
  /** Called after every change with the new and the previous state. Returns the unsubscribe function. */
  subscribe(listener: (state: OfficeState, previous: OfficeState) => void): () => void;
  /** Applies a server event (the socket client and the mock call this). */
  dispatch(event: ServerEvent): void;
  /** Sends a command to the server (or to the mock). */
  send(command: ClientCommand): void;
  select(selection: Selection): void;
}

export interface SceneStats {
  drawCalls: number;
  triangles: number;
  fps: number;
}

export interface OfficeScene {
  /** Moves the camera to a room or an agent (null: the whole building). */
  focus(selection: Selection, options?: { animate?: boolean }): void;
  /** The container changed size. */
  resize(): void;
  setReducedMotion(on: boolean): void;
  /** Fires when the user clicks a room or an avatar. Returns the unsubscribe function. */
  onSelect(listener: (selection: Selection) => void): () => void;
  stats(): SceneStats;
  dispose(): void;
}

export type CreateOffice = (container: HTMLElement, store: OfficeStore) => OfficeScene;
