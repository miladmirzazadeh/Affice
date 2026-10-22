import type { IncomingMessage } from 'node:http';
import {
  TrellaError,
  requireActor,
  type Actor,
  type BoardService,
  type CardFilter,
  type ColumnColor,
  type ColumnInput,
  type Priority,
  type ProjectConfig,
} from '@trella/core';
import { Router, type RequestContext } from './http.js';
import type { EventStream } from './stream.js';

export interface ApiOptions {
  board: BoardService;
  stream: EventStream;
  config: ProjectConfig;
  version: string;
}

/**
 * Resolves who is making the change.
 *
 * The browser sends nothing and is therefore the configured local human. CLI and
 * MCP callers send an explicit agent identity. There is no path that lets an
 * automated change land under the human's name by accident.
 */
function actorFrom(request: IncomingMessage, body: unknown, fallback: Actor): Actor {
  const header = request.headers['x-trella-actor'];
  if (typeof header === 'string' && header.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(header);
    } catch (cause) {
      throw new TrellaError('invalid_input', 'x-trella-actor must be JSON: {type,id,name}.', {
        cause,
      });
    }
    return requireActor(parsed);
  }
  if (body && typeof body === 'object' && 'actor' in body && (body as { actor: unknown }).actor) {
    return requireActor((body as { actor: unknown }).actor);
  }
  return fallback;
}

function asObject(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new TrellaError('invalid_input', 'Request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}

function revisionFrom(body: Record<string, unknown>, url: URL): number | undefined {
  const raw =
    body.expectedRevision ?? body.expected_revision ?? url.searchParams.get('expectedRevision');
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new TrellaError('invalid_input', 'expectedRevision must be an integer.');
  }
  return value;
}

function positionFrom(body: Record<string, unknown>): number | undefined {
  const raw = body.position;
  if (raw === undefined || raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new TrellaError('invalid_input', 'position must be a non-negative integer index.');
  }
  return value;
}

function columnsFrom(value: unknown): ColumnInput[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new TrellaError('invalid_input', 'columns must be an array.');
  return value.map((entry) => {
    if (typeof entry === 'string') return { name: entry };
    const column = asObject(entry);
    return {
      name: String(column.name ?? ''),
      color: column.color as ColumnColor | undefined,
      terminal: column.terminal === undefined ? undefined : Boolean(column.terminal),
    };
  });
}

function filterFrom(url: URL): CardFilter {
  const filter: CardFilter = {};
  const board = url.searchParams.get('board');
  const status = url.searchParams.get('status');
  const assignee = url.searchParams.get('assignee');
  const label = url.searchParams.get('label');
  const priority = url.searchParams.get('priority');
  const query = url.searchParams.get('q') ?? url.searchParams.get('query');
  const limit = url.searchParams.get('limit');
  const archived = url.searchParams.get('archived');

  if (board) filter.boardId = board;
  if (status) filter.status = status;
  if (assignee) filter.assignee = assignee;
  if (label) filter.label = label;
  if (priority) filter.priority = priority as Priority;
  if (query) filter.query = query;
  if (limit) filter.limit = Number(limit);
  if (archived === 'true') filter.archived = true;
  else if (archived === 'all') filter.archived = undefined;
  else filter.archived = false;
  return filter;
}

export function createApi({ board, stream, config, version }: ApiOptions): Router {
  const router = new Router();
  const identity = config.identity;
  const actor = (context: RequestContext) => actorFrom(context.request, context.body, identity);

  router.get('/api/health', () => ({
    ok: true,
    version,
    workspace: board.workspaceName,
    boards: board.listBoards().length,
    cursor: board.cursor(),
    clients: stream.clientCount,
  }));

  router.get('/api/config', () => ({
    version,
    workspace: { name: board.workspaceName },
    identity,
    fileAdapter: { enabled: config.fileAdapter.enabled, inbox: config.fileAdapter.inbox },
  }));

  /* ------------------------------------------------------ projects & boards */

  router.get('/api/workspace', () => board.workspace());

  router.post('/api/projects', (context) => {
    const body = asObject(context.body);
    context.response.statusCode = 201;
    return {
      project: board.createProject(
        { name: String(body.name ?? ''), description: body.description as string | undefined },
        actor(context)
      ),
    };
  });

  router.patch('/api/projects/:id', (context) => {
    const body = asObject(context.body);
    return {
      project: board.updateProject(
        context.params.id!,
        {
          name: body.name as string | undefined,
          description: body.description as string | undefined,
        },
        actor(context)
      ),
    };
  });

  router.post('/api/boards', (context) => {
    const body = asObject(context.body);
    context.response.statusCode = 201;
    return {
      board: board.createBoard(
        {
          name: String(body.name ?? ''),
          description: body.description as string | undefined,
          projectId: (body.projectId ?? body.project) as string | undefined,
          columns: columnsFrom(body.columns),
          cardPrefix: (body.cardPrefix ?? body.card_prefix) as string | undefined,
        },
        actor(context)
      ),
    };
  });

  router.patch('/api/boards/:id', (context) => {
    const body = asObject(context.body);
    return {
      board: board.updateBoard(
        context.params.id!,
        {
          name: body.name as string | undefined,
          description: body.description as string | undefined,
        },
        actor(context)
      ),
    };
  });

  router.post('/api/boards/:id/delete', (context) => board.deleteBoard(context.params.id!, actor(context)));

  router.post('/api/boards/:id/columns', (context) => {
    const body = asObject(context.body);
    context.response.statusCode = 201;
    return {
      board: board.addColumn(
        context.params.id!,
        {
          name: String(body.name ?? ''),
          color: body.color as ColumnColor | undefined,
          terminal: body.terminal === undefined ? undefined : Boolean(body.terminal),
          position: positionFrom(body),
        },
        actor(context)
      ),
    };
  });

  router.patch('/api/boards/:id/columns/:columnId', (context) => {
    const body = asObject(context.body);
    return {
      board: board.updateColumn(
        context.params.id!,
        context.params.columnId!,
        {
          name: body.name as string | undefined,
          color: body.color as ColumnColor | undefined,
          terminal: body.terminal === undefined ? undefined : Boolean(body.terminal),
          position: positionFrom(body),
        },
        actor(context)
      ),
    };
  });

  router.post('/api/boards/:id/columns/:columnId/delete', (context) => {
    const body = asObject(context.body);
    return {
      board: board.removeColumn(context.params.id!, context.params.columnId!, actor(context), {
        moveCardsTo: (body.moveCardsTo ?? body.move_cards_to) as string | undefined,
      }),
    };
  });

  router.get('/api/board', ({ url }) =>
    board.boardSnapshot(url.searchParams.get('board') ?? undefined, {
      includeArchived: url.searchParams.get('archived') === 'all',
    })
  );

  /* ------------------------------------------------------------------ cards */

  router.get('/api/cards', ({ url }) => ({ cards: board.listCards(filterFrom(url)) }));

  router.post('/api/cards', (context) => {
    const body = asObject(context.body);
    const card = board.createCard(
      {
        boardId: (body.boardId ?? body.board_id ?? body.board) as string | undefined,
        title: String(body.title ?? ''),
        description: body.description as string | undefined,
        acceptanceCriteria: (body.acceptanceCriteria ?? body.acceptance_criteria) as
          | string
          | undefined,
        status: body.status as string | undefined,
        priority: body.priority as Priority | undefined,
        labels: body.labels as string[] | undefined,
        assignee: (body.assignee ?? null) as Actor | null,
        position: positionFrom(body),
      },
      actor(context)
    );
    context.response.statusCode = 201;
    return { card };
  });

  router.get('/api/cards/:id', ({ params }) => {
    const card = board.getCard(params.id!);
    return { card, activity: board.getActivity({ cardId: card.id }) };
  });

  router.patch('/api/cards/:id', (context) => {
    const body = asObject(context.body);
    const patch: Record<string, unknown> = {};
    for (const key of ['title', 'description', 'priority', 'labels', 'assignee'] as const) {
      if (key in body) patch[key] = body[key];
    }
    if ('acceptanceCriteria' in body) patch.acceptanceCriteria = body.acceptanceCriteria;
    else if ('acceptance_criteria' in body) patch.acceptanceCriteria = body.acceptance_criteria;

    return {
      card: board.updateCard(
        context.params.id!,
        patch,
        actor(context),
        revisionFrom(body, context.url)
      ),
    };
  });

  router.post('/api/cards/:id/move', (context) => {
    const body = asObject(context.body);
    const status = body.status ?? body.destination_status;
    if (typeof status !== 'string' || !status) {
      throw new TrellaError('invalid_input', 'Provide the destination column as "status".');
    }
    return {
      card: board.moveCard(
        context.params.id!,
        { status, position: positionFrom(body) },
        actor(context),
        revisionFrom(body, context.url)
      ),
    };
  });

  router.post('/api/cards/:id/claim', (context) => {
    const body = asObject(context.body);
    return {
      card: board.claimCard(context.params.id!, actor(context), revisionFrom(body, context.url)),
    };
  });

  router.post('/api/cards/:id/archive', (context) => {
    const body = asObject(context.body);
    const archived = body.archived === undefined ? true : Boolean(body.archived);
    return {
      card: board.setArchived(
        context.params.id!,
        archived,
        actor(context),
        revisionFrom(body, context.url)
      ),
    };
  });

  router.get('/api/cards/:id/comments', ({ params }) => ({
    comments: board.listComments(params.id!),
  }));

  router.post('/api/cards/:id/comments', (context) => {
    const body = asObject(context.body);
    const comment = board.addComment(context.params.id!, String(body.body ?? ''), actor(context));
    context.response.statusCode = 201;
    return { comment, card: board.getCard(context.params.id!) };
  });

  router.get('/api/cards/:id/activity', ({ params, url }) => ({
    activity: board.getActivity({
      cardId: params.id!,
      limit: Number(url.searchParams.get('limit')) || 200,
    }),
  }));

  router.get('/api/activity', ({ url }) => {
    const since = url.searchParams.get('since');
    if (since !== null) return { activity: board.activitySince(Number(since) || 0) };
    return {
      activity: board.getActivity({
        boardId: url.searchParams.get('board') ?? undefined,
        limit: Number(url.searchParams.get('limit')) || 100,
      }),
    };
  });

  router.get(
    '/api/events',
    ({ url, response }) => {
      const raw = url.searchParams.get('cursor');
      const cursor = raw === null || raw === '' ? null : Number(raw);
      stream.attach(response, Number.isFinite(cursor) ? cursor : null);
      return undefined;
    },
    { streaming: true }
  );

  return router;
}
