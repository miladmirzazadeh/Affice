import type { CardSummary } from './types.js';

export type TrellaErrorCode =
  | 'not_found'
  | 'invalid_input'
  | 'invalid_status'
  | 'conflict'
  | 'not_initialized'
  | 'service_unavailable';

/**
 * Every failure a caller can act on. The message is written for a human reading
 * a terminal; `code` is what a program should branch on.
 */
export class TrellaError extends Error {
  readonly code: TrellaErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(
    code: TrellaErrorCode,
    message: string,
    options: { status?: number; details?: Record<string, unknown>; cause?: unknown } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'TrellaError';
    this.code = code;
    this.status = options.status ?? defaultStatus(code);
    this.details = options.details ?? {};
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, ...this.details } };
  }
}

function defaultStatus(code: TrellaErrorCode): number {
  switch (code) {
    case 'not_found':
      return 404;
    case 'conflict':
      return 409;
    case 'invalid_input':
    case 'invalid_status':
      return 400;
    case 'not_initialized':
      return 412;
    case 'service_unavailable':
      return 503;
  }
}

export function notFound(what: string, id: string): TrellaError {
  return new TrellaError('not_found', `No ${what} with id "${id}".`, { details: { id } });
}

export function invalidInput(message: string, details?: Record<string, unknown>): TrellaError {
  return new TrellaError('invalid_input', message, { details: details ?? {} });
}

export function invalidStatus(status: string, available: string[]): TrellaError {
  return new TrellaError(
    'invalid_status',
    `"${status}" is not a column on this board. Available: ${available.join(', ')}.`,
    { details: { status, available } }
  );
}

/**
 * Raised when a caller's `expectedRevision` no longer matches. The current card
 * travels with the error so the caller can diff and retry without a second read.
 */
export function conflict(card: CardSummary, expectedRevision: number): TrellaError {
  return new TrellaError(
    'conflict',
    `Card ${card.id} has moved on to revision ${card.revision}; you sent ${expectedRevision}. ` +
      `Last changed by ${card.lastActor?.name ?? 'someone'} at ${card.updatedAt}.`,
    {
      details: {
        cardId: card.id,
        expectedRevision,
        currentRevision: card.revision,
        current: card,
      },
    }
  );
}

export function isTrellaError(value: unknown): value is TrellaError {
  return value instanceof TrellaError;
}
