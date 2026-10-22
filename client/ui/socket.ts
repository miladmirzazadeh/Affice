// The WebSocket client: one connection to /ws on the page's own host (Vite proxies it to the office
// server in development), every frame dispatched to the store, commands sent as JSON, and a
// reconnect with backoff. Reports `connecting` for a first attempt, `live` while open, and
// `offline` from the first failure until a connection succeeds again. The page token goes in the
// subprotocol (`affice`, `affice.<token>`), never in the URL; a connection that is refused before it opens
// drops the token, so the next attempt asks the server for the current one (after a restart).
// Owned by the UI shell.

import type { Connection } from '../../shared/scene-api';
import type { ClientCommand, ServerEvent } from '../../shared/types';
import { currentToken, ensureToken, forgetToken, socketProtocols } from './session';

const EVENT_TYPES: ReadonlySet<string> = new Set<ServerEvent['type']>([
  'app.state',
  'office.state',
  'department.created',
  'department.updated',
  'department.removed',
  'session.state',
  'chat.message',
  'chat.delta',
  'chat.done',
  'agent.upsert',
  'agent.removed',
  'tool.started',
  'tool.finished',
  'permission.requested',
  'permission.resolved',
  'turn.result',
  'error',
]);

/** Delays between attempts, in milliseconds; the last one repeats. Each gets 20 percent jitter. */
const BACKOFF = [500, 1000, 2000, 4000, 8000, 15000];

export interface SocketOptions {
  dispatch(event: ServerEvent): void;
  setConnection(connection: Connection): void;
  /** Defaults to /ws on the page's host. */
  url?: string;
}

export interface SocketClient {
  /** False when the socket is not open; nothing is queued. */
  send(command: ClientCommand): boolean;
  /** Tries again now instead of waiting for the next backoff step. */
  reconnect(): void;
  close(): void;
}

export function socketUrl(location: Location = window.location): string {
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
}

/** Every frame is one JSON ServerEvent. Unknown types are dropped: the store has no case for them. */
export function parseFrame(data: unknown): ServerEvent | null {
  if (typeof data !== 'string') return null;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && EVENT_TYPES.has(type) ? (value as ServerEvent) : null;
}

export function connectSocket(options: SocketOptions): SocketClient {
  const url = options.url ?? socketUrl();
  let socket: WebSocket | null = null;
  let attempt = 0;
  let timer: number | undefined;
  let closed = false;
  let reported: Connection | null = null;
  let opening = false;

  function report(connection: Connection) {
    if (connection === reported) return;
    reported = connection;
    options.setConnection(connection);
  }

  async function open() {
    window.clearTimeout(timer);
    timer = undefined;
    if (closed || socket || opening) return;
    opening = true;
    // Once offline, stay offline while retrying, so the label does not flicker every attempt.
    if (reported !== 'offline') report('connecting');
    let next: WebSocket;
    try {
      const token = currentToken() ?? (await ensureToken());
      opening = false;
      if (closed || socket) return;
      next = new WebSocket(url, socketProtocols(token));
    } catch {
      opening = false;
      retry();
      return;
    }
    socket = next;
    let opened = false;
    next.addEventListener('open', () => {
      opened = true;
      attempt = 0;
      report('live');
    });
    next.addEventListener('message', (message) => {
      const event = parseFrame(message.data);
      if (!event) {
        console.warn('office socket: dropped a frame that is not a known ServerEvent');
        return;
      }
      try {
        options.dispatch(event);
      } catch (error) {
        console.error('office socket: the store failed on a frame', event.type, error);
      }
    });
    // An error is always followed by close, so close alone drives the retry.
    next.addEventListener('close', () => {
      if (socket !== next) return;
      socket = null;
      if (!opened) forgetToken(); // refused: the token may be from before a restart
      if (!closed) retry();
    });
  }

  function retry() {
    report('offline');
    const base = BACKOFF[Math.min(attempt, BACKOFF.length - 1)];
    attempt += 1;
    timer = window.setTimeout(() => void open(), base * (0.8 + Math.random() * 0.4));
  }

  function reconnect() {
    if (closed || socket) return;
    attempt = 0;
    void open();
  }

  const onVisible = () => {
    if (document.visibilityState === 'visible') reconnect();
  };
  window.addEventListener('online', reconnect);
  document.addEventListener('visibilitychange', onVisible);
  void open();

  return {
    send(command) {
      if (!socket || socket.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify(command));
      return true;
    },
    reconnect,
    close() {
      closed = true;
      window.clearTimeout(timer);
      window.removeEventListener('online', reconnect);
      document.removeEventListener('visibilitychange', onVisible);
      const current = socket;
      socket = null;
      current?.close();
      report('offline');
    },
  };
}
