import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  COLUMN_COLORS,
  TrellaError,
  findWorkspace,
  initWorkspace,
  isTrellaError,
  openClient,
  slugify,
  type Actor,
  type BoardClient,
  type CardSummary,
  type ColumnColor,
  type Priority,
} from '@trella/core';

const PRIORITY = z.enum(['low', 'medium', 'high', 'urgent']);
const COLOR = z.enum(COLUMN_COLORS as unknown as [ColumnColor, ...ColumnColor[]]);
const ACTOR = z.object({
  type: z.enum(['human', 'agent']),
  id: z.string(),
  name: z.string(),
});

/**
 * Taken by every tool that writes, so several agents can share one server and
 * still be told apart in the activity. Without it the server's own identity is used.
 */
const AGENT_IDENTITY = ACTOR.optional().describe(
  "Who is making this change: {type, id, name}. Defaults to this server's configured identity. " +
    'Pass your own when several agents share this server, so the activity shows who did what.'
);

const COLUMN = z.object({
  name: z.string().min(1).max(40),
  color: COLOR.optional(),
  terminal: z.boolean().optional().describe('True for a column that means "no further work".'),
});

export interface McpOptions {
  cwd?: string;
  version?: string;
  /** Identity used when a tool call does not carry one. */
  actor?: Actor;
}

const INSTRUCTIONS = `Trella is the shared task board for this project. A workspace holds projects, a project holds boards, and a board holds columns and cards.

Start every session by calling list_boards. It returns every board with its id, project, name and description. Pick the board the user is talking about and keep its board_id for the rest of the session — every card tool takes it.

Rules that matter:

1. Do not create a project or a board unless the user explicitly asks for one. If you cannot tell which board they mean, ask them; do not guess, and do not invent a new board as a workaround. If list_boards reports that this directory has no workspace at all, say so and wait — creating a board is what sets one up, and that is the user's call.
2. When the user does ask for a new board, put it in the project they name. If they name none, leave project_id empty and it lands in "general".
3. Claim a card before you work on it, move it as its state changes, and leave a comment with enough context for whoever picks it up next.
4. Pass expected_revision on writes, using the revision from your last read. A mismatch comes back as a conflict with the current card, which is what stops you overwriting someone else's edit.

Columns are per board and fully configurable: a board can be created with any workflow, and columns can be added or removed later. Never assume the default six columns exist on a board you have not read.`;

function summarize(card: CardSummary) {
  return {
    id: card.id,
    board_id: card.boardId,
    title: card.title,
    status: card.status,
    priority: card.priority,
    revision: card.revision,
    labels: card.labels,
    assignee: card.assignee ? { id: card.assignee.id, name: card.assignee.name } : null,
    updated_at: card.updatedAt,
    ...(card.archived ? { archived: true } : {}),
  };
}

function ok(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

function fail(error: unknown) {
  const body = isTrellaError(error)
    ? { error: error.code, message: error.message, ...error.details }
    : { error: 'internal', message: error instanceof Error ? error.message : String(error) };
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }],
  };
}

async function guard<T>(work: () => Promise<T> | T) {
  try {
    return ok(await work());
  } catch (error) {
    return fail(error);
  }
}

/** Resolves the agent identity from the environment; every write is attributed. */
function resolveActor(explicit?: Actor): Actor {
  if (explicit) return explicit;
  const raw = process.env.TRELLA_ACTOR;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Actor;
      if (parsed?.type && parsed?.id) return { ...parsed, name: parsed.name ?? parsed.id };
    } catch {
      // Fall through to the name-based form below.
    }
  }
  const name = process.env.TRELLA_AGENT_NAME ?? 'MCP agent';
  return { type: 'agent', id: process.env.TRELLA_AGENT_ID ?? `agent:${slugify(name)}`, name };
}

/**
 * The workspace is resolved on the first call, not at startup.
 *
 * This server is usually registered once and then started in whatever directory
 * the editor happens to have open. Failing at launch in every project that has no
 * board would make it look broken; instead, reads explain the situation and only
 * an explicit "create a board" sets a workspace up.
 */
class LazyClient implements BoardClient {
  #client: BoardClient | null = null;

  constructor(private readonly cwd: string) {}

  get mode() {
    return this.#client?.mode ?? 'local';
  }

  get url() {
    return this.#client?.url ?? null;
  }

  #resolve(create = false): BoardClient {
    if (this.#client) return this.#client;
    const workspace = findWorkspace(this.cwd);
    if (!workspace) {
      if (!create) {
        throw new TrellaError(
          'not_initialized',
          `There is no Trella workspace in ${this.cwd}. Ask the user to run \`trella init\` ` +
            `here, or — only if they ask you for a board — call create_board, which will set ` +
            `one up in this directory.`,
          { details: { directory: this.cwd } }
        );
      }
      initWorkspace(this.cwd);
    }
    this.#client = openClient(findWorkspace(this.cwd)!.root).client;
    return this.#client;
  }

  workspace() {
    return this.#resolve().workspace();
  }
  board(boardId?: string) {
    return this.#resolve().board(boardId);
  }
  createProject(...args: Parameters<BoardClient['createProject']>) {
    return this.#resolve(true).createProject(...args);
  }
  createBoard(...args: Parameters<BoardClient['createBoard']>) {
    return this.#resolve(true).createBoard(...args);
  }
  updateBoard(...args: Parameters<BoardClient['updateBoard']>) {
    return this.#resolve().updateBoard(...args);
  }
  deleteBoard(...args: Parameters<BoardClient['deleteBoard']>) {
    return this.#resolve().deleteBoard(...args);
  }
  addColumn(...args: Parameters<BoardClient['addColumn']>) {
    return this.#resolve().addColumn(...args);
  }
  updateColumn(...args: Parameters<BoardClient['updateColumn']>) {
    return this.#resolve().updateColumn(...args);
  }
  removeColumn(...args: Parameters<BoardClient['removeColumn']>) {
    return this.#resolve().removeColumn(...args);
  }
  listCards(...args: Parameters<BoardClient['listCards']>) {
    return this.#resolve().listCards(...args);
  }
  getCard(...args: Parameters<BoardClient['getCard']>) {
    return this.#resolve().getCard(...args);
  }
  createCard(...args: Parameters<BoardClient['createCard']>) {
    return this.#resolve().createCard(...args);
  }
  updateCard(...args: Parameters<BoardClient['updateCard']>) {
    return this.#resolve().updateCard(...args);
  }
  moveCard(...args: Parameters<BoardClient['moveCard']>) {
    return this.#resolve().moveCard(...args);
  }
  claimCard(...args: Parameters<BoardClient['claimCard']>) {
    return this.#resolve().claimCard(...args);
  }
  setArchived(...args: Parameters<BoardClient['setArchived']>) {
    return this.#resolve().setArchived(...args);
  }
  addComment(...args: Parameters<BoardClient['addComment']>) {
    return this.#resolve().addComment(...args);
  }
  getActivity(...args: Parameters<BoardClient['getActivity']>) {
    return this.#resolve().getActivity(...args);
  }
  close(): void {
    this.#client?.close();
  }
}

export function createMcpServer(access: BoardClient, options: McpOptions = {}): McpServer {
  const actor = resolveActor(options.actor);
  /** The identity a write is recorded under: the one named in the call, else the server's. */
  const who = (identity?: Actor) => identity ?? actor;
  const server = new McpServer(
    { name: 'trella', version: options.version ?? '0.1.0' },
    { instructions: INSTRUCTIONS }
  );

  /* --------------------------------------------------- discovery and setup */

  server.registerTool(
    'list_boards',
    {
      annotations: { readOnlyHint: true, openWorldHint: false },
      title: 'List boards',
      description:
        'Every project and board in this workspace, with the board_id you need for every other ' +
        'tool. Call this first. Do not create anything based on what you see here unless the ' +
        'user asked you to.',
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const workspace = await access.workspace();
        return {
          projects: workspace.projects.map((project) => ({
            id: project.id,
            name: project.name,
            description: project.description,
          })),
          boards: workspace.boards.map((board) => ({
            board_id: board.id,
            project_id: board.projectId,
            name: board.name,
            slug: board.slug,
            description: board.description,
            card_prefix: board.cardPrefix,
            columns: board.columns.map((column) => column.id),
            open_cards: board.openCount,
            total_cards: board.cardCount,
          })),
          note:
            'Use board_id for every card tool. If more than one board could be the one the user ' +
            'means, ask them rather than guessing.',
        };
      })
  );

  server.registerTool(
    'get_board',
    {
      annotations: { readOnlyHint: true, openWorldHint: false },
      title: 'Get board',
      description:
        'One board with its columns and its cards. Read this before moving anything: columns are ' +
        'per board, so the statuses on this board may not be the ones you expect.',
      inputSchema: {
        board_id: z.string().optional().describe('Board id, slug, or "project/slug".'),
      },
    },
    async ({ board_id }) =>
      guard(async () => {
        const snapshot = await access.board(board_id);
        return {
          board_id: snapshot.board.id,
          project: { id: snapshot.project.id, name: snapshot.project.name },
          name: snapshot.board.name,
          description: snapshot.board.description,
          columns: snapshot.board.columns.map((column) => ({
            id: column.id,
            name: column.name,
            terminal: column.terminal,
          })),
          tasks: snapshot.cards.map(summarize),
        };
      })
  );

  server.registerTool(
    'create_board',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      title: 'Create board',
      description:
        'Create a board. ONLY call this when the user explicitly asks for a new board — never as ' +
        'a way to deal with not knowing which board they meant. Pass columns to define a custom ' +
        'workflow; leave it out for Backlog, To do, In progress, Review, Done, Failed.',
      inputSchema: {
        name: z.string().min(1).max(60),
        description: z.string().max(2000).optional().describe('What this board is for.'),
        project_id: z
          .string()
          .optional()
          .describe('Existing project id or name. Defaults to "general".'),
        columns: z.array(COLUMN).max(20).optional(),
        agent_identity: AGENT_IDENTITY,
      },
    },
    async ({ name, description, project_id, columns, agent_identity }) =>
      guard(async () => {
        const board = await access.createBoard(
          { name, description, projectId: project_id, columns },
          who(agent_identity)
        );
        return {
          board_id: board.id,
          project_id: board.projectId,
          name: board.name,
          card_prefix: board.cardPrefix,
          columns: board.columns.map((column) => column.id),
        };
      })
  );

  server.registerTool(
    'create_project',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      title: 'Create project',
      description:
        'Create a project to group boards. ONLY call this when the user explicitly asks for one.',
      inputSchema: {
        name: z.string().min(1).max(60),
        description: z.string().max(2000).optional(),
        agent_identity: AGENT_IDENTITY,
      },
    },
    async ({ name, description, agent_identity }) =>
      guard(async () => {
        const project = await access.createProject({ name, description }, who(agent_identity));
        return { project_id: project.id, name: project.name };
      })
  );

  server.registerTool(
    'update_board',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      title: 'Update board',
      description: "Change a board's name or description.",
      inputSchema: {
        board_id: z.string(),
        name: z.string().min(1).max(60).optional(),
        description: z.string().max(2000).optional(),
        agent_identity: AGENT_IDENTITY,
      },
    },
    async ({ board_id, name, description, agent_identity }) =>
      guard(async () => {
        const board = await access.updateBoard(board_id, { name, description }, who(agent_identity));
        return { board_id: board.id, name: board.name, description: board.description };
      })
  );

  server.registerTool(
    'add_column',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      title: 'Add column',
      description:
        'Add a column to an existing board, optionally at a position (0 is first). Columns are ' +
        "part of the user's workflow — only change them when they ask.",
      inputSchema: {
        board_id: z.string(),
        name: z.string().min(1).max(40),
        color: COLOR.optional(),
        terminal: z.boolean().optional(),
        position: z.number().int().nonnegative().optional(),
        agent_identity: AGENT_IDENTITY,
      },
    },
    async ({ board_id, name, color, terminal, position, agent_identity }) =>
      guard(async () => {
        const board = await access.addColumn(
          board_id,
          { name, color, terminal, position },
          who(agent_identity)
        );
        return { board_id: board.id, columns: board.columns.map((column) => column.id) };
      })
  );

  server.registerTool(
    'remove_column',
    {
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      title: 'Remove column',
      description:
        'Remove a column. Its cards are moved to move_cards_to, or to the first column when that ' +
        'is not given. Cards are never deleted by this.',
      inputSchema: {
        board_id: z.string(),
        column_id: z.string(),
        move_cards_to: z.string().optional(),
        agent_identity: AGENT_IDENTITY,
      },
    },
    async ({ board_id, column_id, move_cards_to, agent_identity }) =>
      guard(async () => {
        const board = await access.removeColumn(board_id, column_id, who(agent_identity), {
          moveCardsTo: move_cards_to,
        });
        return { board_id: board.id, columns: board.columns.map((column) => column.id) };
      })
  );

  /* ------------------------------------------------------------------ cards */

  server.registerTool(
    'list_tasks',
    {
      annotations: { readOnlyHint: true, openWorldHint: false },
      title: 'List tasks',
      description:
        'Cards on a board, in board order. Filter by status (a column id on that board), ' +
        'assignee, label, priority or free text.',
      inputSchema: {
        board_id: z.string().optional().describe('Defaults to the first board in "general".'),
        status: z.string().optional(),
        assignee: z.string().optional().describe('Actor id, e.g. "agent:codex".'),
        label: z.string().optional(),
        priority: PRIORITY.optional(),
        query: z.string().optional(),
        include_archived: z.boolean().optional(),
        limit: z.number().int().positive().max(500).optional(),
      },
    },
    async (input) =>
      guard(async () => {
        const snapshot = await access.board(input.board_id);
        const cards = await access.listCards({
          boardId: snapshot.board.id,
          status: input.status,
          assignee: input.assignee,
          label: input.label,
          priority: input.priority as Priority | undefined,
          query: input.query,
          archived: input.include_archived ? undefined : false,
          limit: input.limit,
        });
        return {
          board_id: snapshot.board.id,
          board_name: snapshot.board.name,
          columns: snapshot.board.columns.map((column) => ({ id: column.id, name: column.name })),
          tasks: cards.map(summarize),
        };
      })
  );

  server.registerTool(
    'get_task',
    {
      annotations: { readOnlyHint: true, openWorldHint: false },
      title: 'Get task',
      description:
        'Full card with description, acceptance criteria, comments and activity. Card ids are ' +
        'unique across the workspace, so no board_id is needed. Use the returned revision as ' +
        'expected_revision when you write back.',
      inputSchema: { task_id: z.string().describe('Card id, e.g. "TRL-12".') },
    },
    async ({ task_id }) =>
      guard(async () => {
        const detail = await access.getCard(task_id);
        return {
          task: {
            ...summarize({ ...detail.card, commentCount: detail.card.comments.length }),
            description: detail.card.description,
            acceptance_criteria: detail.card.acceptanceCriteria,
            creator: detail.card.creator,
            last_actor: detail.card.lastActor,
            created_at: detail.card.createdAt,
          },
          comments: detail.card.comments.map((comment) => ({
            author: comment.actor.name,
            type: comment.actor.type,
            at: comment.createdAt,
            body: comment.body,
          })),
          activity: detail.activity.map((entry) => ({
            at: entry.createdAt,
            actor: entry.actor.name,
            actor_id: entry.actor.id,
            action: entry.action,
            changes: entry.changes,
          })),
        };
      })
  );

  server.registerTool(
    'create_task',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      title: 'Create task',
      description:
        'Add a card to a board. Give it a specific, verb-first title and put the implementation ' +
        'detail in description and acceptance_criteria so the next actor does not have to guess.',
      inputSchema: {
        board_id: z.string().optional(),
        title: z.string().min(1).max(200),
        description: z.string().max(20_000).optional(),
        acceptance_criteria: z.string().max(20_000).optional(),
        status: z.string().optional().describe('Column id. Defaults to the first column.'),
        priority: PRIORITY.optional(),
        labels: z.array(z.string()).max(12).optional(),
        assignee: ACTOR.optional(),
        position: z.number().int().nonnegative().optional(),
        agent_identity: AGENT_IDENTITY,
      },
    },
    async (input) =>
      guard(async () => ({
        task: summarize(
          await access.createCard(
            {
              boardId: input.board_id,
              title: input.title,
              description: input.description,
              acceptanceCriteria: input.acceptance_criteria,
              status: input.status,
              priority: input.priority,
              labels: input.labels,
              assignee: input.assignee ?? null,
              position: input.position,
            },
            who(input.agent_identity)
          )
        ),
      }))
  );

  server.registerTool(
    'update_task',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      title: 'Update task',
      description:
        "Change a card's fields. Send expected_revision from your last read; a mismatch returns " +
        'a conflict with the current card instead of overwriting another actor.',
      inputSchema: {
        task_id: z.string(),
        fields: z.object({
          title: z.string().min(1).max(200).optional(),
          description: z.string().max(20_000).optional(),
          acceptance_criteria: z.string().max(20_000).optional(),
          priority: PRIORITY.optional(),
          labels: z.array(z.string()).max(12).optional(),
          assignee: ACTOR.nullable().optional(),
        }),
        expected_revision: z.number().int().optional(),
        agent_identity: AGENT_IDENTITY,
      },
    },
    async ({ task_id, fields, expected_revision, agent_identity }) =>
      guard(async () => {
        const patch: Record<string, unknown> = { ...fields };
        if ('acceptance_criteria' in patch) {
          patch.acceptanceCriteria = patch.acceptance_criteria;
          delete patch.acceptance_criteria;
        }
        return {
          task: summarize(
            await access.updateCard(task_id, patch, who(agent_identity), expected_revision)
          ),
        };
      })
  );

  server.registerTool(
    'move_task',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      title: 'Move task',
      description:
        'Move a card to another column on its own board, optionally at a specific index (0 is the ' +
        'top). Use this to signal progress: claim, then move to the working column, then to review.',
      inputSchema: {
        task_id: z.string(),
        destination_status: z.string().describe('A column id on that card\'s board.'),
        position: z.number().int().nonnegative().optional(),
        expected_revision: z.number().int().optional(),
        agent_identity: AGENT_IDENTITY,
      },
    },
    async ({ task_id, destination_status, position, expected_revision, agent_identity }) =>
      guard(async () => ({
        task: summarize(
          await access.moveCard(
            task_id,
            destination_status,
            position,
            who(agent_identity),
            expected_revision
          )
        ),
      }))
  );

  server.registerTool(
    'claim_task',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      title: 'Claim task',
      description:
        'Assign a card to yourself before working on it. Fails with a conflict if another actor ' +
        'already holds it, so two agents never work the same card.',
      inputSchema: {
        task_id: z.string(),
        agent_identity: AGENT_IDENTITY,
        expected_revision: z.number().int().optional(),
      },
    },
    async ({ task_id, agent_identity, expected_revision }) =>
      guard(async () => ({
        task: summarize(await access.claimCard(task_id, who(agent_identity), expected_revision)),
      }))
  );

  server.registerTool(
    'add_comment',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      title: 'Add comment',
      description:
        'Leave a note on a card. Write the handoff context the next actor needs: what you did, ' +
        'what is left, and anything surprising.',
      inputSchema: {
        task_id: z.string(),
        body: z.string().min(1).max(10_000),
        agent_identity: AGENT_IDENTITY,
      },
    },
    async ({ task_id, body, agent_identity }) =>
      guard(async () => {
        const comment = await access.addComment(task_id, body, who(agent_identity));
        return { comment: { id: comment.id, task_id, at: comment.createdAt } };
      })
  );

  server.registerTool(
    'get_activity',
    {
      annotations: { readOnlyHint: true, openWorldHint: false },
      title: 'Get activity',
      description:
        'History for one card, or for a whole board when you pass board_id instead: who changed ' +
        'what, and when. Each entry carries the actor\'s name and actor_id.',
      inputSchema: {
        task_id: z.string().optional(),
        board_id: z.string().optional(),
        limit: z.number().int().positive().max(500).optional(),
      },
    },
    async ({ task_id, board_id, limit }) =>
      guard(async () => ({
        activity: (
          await access.getActivity({ cardId: task_id, boardId: board_id, limit: limit ?? 100 })
        ).map((entry) => ({
          at: entry.createdAt,
          board_id: entry.boardId,
          task_id: entry.cardId,
          actor: entry.actor.name,
          actor_id: entry.actor.id,
          actor_type: entry.actor.type,
          action: entry.action,
          changes: entry.changes,
        })),
      }))
  );

  return server;
}

export async function runMcpServer(options: McpOptions = {}): Promise<void> {
  // Resolved in one place so every entry point behaves the same. TRELLA_PROJECT
  // is how a client that cannot choose a working directory — the Claude desktop
  // app, and most GUI clients — says which workspace it means.
  const cwd = options.cwd ?? process.env.TRELLA_PROJECT ?? process.cwd();
  const access = new LazyClient(cwd);
  const server = createMcpServer(access, options);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = () => {
    access.close();
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
