import type { ServerResponse } from 'node:http';
import type { BoardEvent, BoardService } from '@trella/core';

const HEARTBEAT_MS = 25_000;

interface Client {
  response: ServerResponse;
  heartbeat: NodeJS.Timeout;
}

/**
 * Server-Sent Events, not WebSockets: the board only ever pushes, SSE reconnects
 * on its own, and it survives a proxy that would drop an upgrade.
 */
export class EventStream {
  readonly #clients = new Set<Client>();
  #unsubscribe: (() => void) | null = null;

  constructor(private readonly board: BoardService) {
    this.#unsubscribe = board.subscribe((event) => this.#broadcast(event));
  }

  get clientCount(): number {
    return this.#clients.size;
  }

  /**
   * Attaches a client. When it reconnects with a cursor it has already fallen
   * behind, it gets a fresh snapshot rather than a partial replay it cannot
   * reconcile.
   */
  attach(response: ServerResponse, cursor: number | null): void {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    response.write(`retry: 2000\n\n`);

    const client: Client = {
      response,
      heartbeat: setInterval(() => {
        // A comment frame keeps intermediaries from closing an idle stream.
        response.write(`: keep-alive\n\n`);
      }, HEARTBEAT_MS),
    };
    client.heartbeat.unref?.();
    this.#clients.add(client);

    const current = this.board.cursor();
    if (cursor !== null && cursor < current) {
      // The client missed events. Rather than guess which board it is watching,
      // tell it to refetch: it knows what it has open, the stream does not.
      this.#write(client, 'resync', { reason: 'missed-events', from: cursor, cursor: current });
    } else {
      this.#write(client, 'ready', { cursor: current });
    }

    const detach = () => {
      clearInterval(client.heartbeat);
      this.#clients.delete(client);
    };
    response.on('close', detach);
    response.on('error', detach);
  }

  #broadcast(event: BoardEvent): void {
    for (const client of this.#clients) this.#write(client, event.type, event);
  }

  #write(client: Client, type: string, payload: unknown): void {
    try {
      client.response.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch {
      clearInterval(client.heartbeat);
      this.#clients.delete(client);
    }
  }

  close(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    for (const client of this.#clients) {
      clearInterval(client.heartbeat);
      try {
        client.response.end();
      } catch {
        // The socket is already gone.
      }
    }
    this.#clients.clear();
  }
}
