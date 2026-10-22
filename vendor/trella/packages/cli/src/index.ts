import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TrellaError,
  findWorkspace,
  initWorkspace,
  isTrellaError,
  openClient,
  readRuntime,
  requireWorkspace,
  slugify,
  type Actor,
  type BoardClient,
  type CardFilter,
  type ColumnColor,
  type ColumnInput,
  type Priority,
} from '@trella/core';
import { startServer } from '@trella/server';
import { flagBoolean, flagList, flagNumber, flagString, parseArgs } from './args.js';
import {
  formatActivityLine,
  formatBoard,
  formatCardDetail,
  formatCardLine,
  style,
} from './format.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const version = readVersion();

const HELP = `${style.bold('trella')} — a local-first task board for humans and AI agents

${style.bold('Getting started')}
  trella init [--name <name>] [--port <port>]   Create .agentboard/ and a first board
  trella start [--port <port>] [--no-open]      Run the local service and open the board

${style.bold('Projects and boards')}
  trella boards                                 List every project and board, with ids
  trella board [<board>]                        Show one board and its columns
  trella new-project <name> [--description <t>] Create a project
  trella new-board <name> [options]             Create a board
      --project <project>       Where it belongs. Defaults to "general".
      --columns "A,B,C"         Custom workflow. Defaults to the standard six.
      --description <text>
  trella rename-board <board> <name>            Rename a board
  trella describe-board <board> <text>          Set a board's description
  trella delete-board <board>                   Delete a board and its cards
  trella add-column <board> <name> [--color <c>] [--position <n>] [--terminal]
  trella remove-column <board> <column> [--move-to <column>]
  trella rename-column <board> <column> <name> [--color <c>] [--position <n>]

${style.bold('Working with cards')}
  trella list [filters]                         Show a board, grouped by column
  trella show <id>                              Show one card with comments and activity
  trella create <title> [options]               Add a card
  trella update <id> [options]                  Change a card
  trella move <id> <status> [--position <n>]    Move a card to another column
  trella claim <id>                             Assign a card to yourself
  trella comment <id> <body>                    Add a comment
  trella archive <id> | trella restore <id>     Archive or bring a card back
  trella activity [<id>] [--board <b>] [--limit <n>]

${style.bold('Agents')}
  trella mcp                                    Run the MCP server on stdio

${style.bold('Choosing a board')}
  --board <id|slug|project/slug>   Every card command takes it. Without one, the
                                   first board in "general" is used.

${style.bold('Filters')} (list)
  --status <column>  --assignee <actor-id>  --label <label>  --priority <level>
  --query <text>     --archived             --all            --json

${style.bold('Card options')} (create, update)
  --description <text>   --acceptance <text>   --priority low|medium|high|urgent
  --label <label>        --status <column>     --position <index>
  --assign <actor-id>    --unassign            --expect <revision>

${style.bold('Identity')}
  --as <name>            Act as an agent with this display name
  --agent-id <id>        Override the agent id (default: agent:<slug of --as>)
  TRELLA_ACTOR           JSON identity, e.g. {"type":"agent","id":"agent:codex","name":"Codex"}
  TRELLA_URL             Talk to a service at this address instead of discovering it

Every change is attributed. Without an explicit identity, the CLI acts as the
human configured in .agentboard/config.json — so agents should always pass --as
or set TRELLA_ACTOR.
`;

async function main(argv: string[]): Promise<number> {
  const { command, positional, flags } = parseArgs(argv);

  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(`${HELP}\n`);
      return 0;
    case 'version':
    case '--version':
    case '-v':
      process.stdout.write(`${version}\n`);
      return 0;
    case 'init':
      return commandInit(flags);
    case 'start':
      return commandStart(flags);
    case 'mcp':
      return commandMcp();

    case 'boards':
      return withClient(flags, (client) => commandBoards(client, flags));
    case 'board':
      return withClient(flags, (client) => commandBoard(client, positional, flags));
    case 'new-project':
      return withClient(flags, (client) => commandNewProject(client, positional, flags));
    case 'new-board':
      return withClient(flags, (client) => commandNewBoard(client, positional, flags));
    case 'rename-board':
      return withClient(flags, (client) =>
        commandUpdateBoard(client, positional, flags, 'name')
      );
    case 'describe-board':
      return withClient(flags, (client) =>
        commandUpdateBoard(client, positional, flags, 'description')
      );
    case 'delete-board':
      return withClient(flags, (client) => commandDeleteBoard(client, positional, flags));
    case 'add-column':
      return withClient(flags, (client) => commandAddColumn(client, positional, flags));
    case 'remove-column':
      return withClient(flags, (client) => commandRemoveColumn(client, positional, flags));
    case 'rename-column':
      return withClient(flags, (client) => commandRenameColumn(client, positional, flags));

    case 'list':
    case 'ls':
      return withClient(flags, (client) => commandList(client, flags));
    case 'show':
    case 'get':
      return withClient(flags, (client) => commandShow(client, positional, flags));
    case 'create':
    case 'add':
      return withClient(flags, (client) => commandCreate(client, positional, flags));
    case 'update':
    case 'edit':
      return withClient(flags, (client) => commandUpdate(client, positional, flags));
    case 'move':
      return withClient(flags, (client) => commandMove(client, positional, flags));
    case 'claim':
      return withClient(flags, (client) => commandClaim(client, positional, flags));
    case 'comment':
      return withClient(flags, (client) => commandComment(client, positional, flags));
    case 'archive':
      return withClient(flags, (client) => commandArchive(client, positional, flags, true));
    case 'restore':
      return withClient(flags, (client) => commandArchive(client, positional, flags, false));
    case 'activity':
      return withClient(flags, (client) => commandActivity(client, positional, flags));

    default:
      process.stderr.write(
        `Unknown command "${command}". Run \`trella help\` to see what is available.\n`
      );
      return 1;
  }
}

type Flags = Record<string, unknown>;

async function withClient(
  _flags: Flags,
  body: (client: BoardClient) => Promise<number>
): Promise<number> {
  const { client } = openClient();
  try {
    return await body(client);
  } finally {
    client.close();
  }
}

/* ------------------------------------------------------------------ identity */

/**
 * Resolves who is acting. Explicit flags win, then the environment, then the
 * project's configured human. An agent that forgets to identify itself shows up
 * as the human, which is why `--as` is documented everywhere it matters.
 */
function resolveActor(flags: Flags, cwd = process.cwd()): Actor {
  const as = flagString(flags as never, 'as');
  if (as) {
    const id = flagString(flags as never, 'agent-id') ?? `agent:${slugify(as)}`;
    return { type: 'agent', id, name: as };
  }

  const fromEnv = process.env.TRELLA_ACTOR;
  if (fromEnv) {
    try {
      const parsed = JSON.parse(fromEnv) as Actor;
      if (parsed?.type && parsed?.id) return { ...parsed, name: parsed.name ?? parsed.id };
    } catch {
      throw new TrellaError(
        'invalid_input',
        'TRELLA_ACTOR must be JSON, e.g. {"type":"agent","id":"agent:codex","name":"Codex"}.'
      );
    }
  }
  if (process.env.TRELLA_AGENT_NAME) {
    const name = process.env.TRELLA_AGENT_NAME;
    return { type: 'agent', id: process.env.TRELLA_AGENT_ID ?? `agent:${slugify(name)}`, name };
  }

  return requireWorkspace(cwd).config.identity;
}

const boardFlag = (flags: Flags) =>
  flagString(flags as never, 'board') ?? process.env.TRELLA_BOARD ?? undefined;

/* ---------------------------------------------------------- setup commands */

async function commandInit(flags: Flags): Promise<number> {
  const root = resolve(flagString(flags as never, 'path') ?? process.cwd());
  const existing = findWorkspace(root);
  if (existing && existing.root === root && !flagBoolean(flags as never, 'force')) {
    process.stdout.write(
      `This project already has a Trella workspace at ${style.dim(existing.dir)}.\n` +
        `Run \`trella start\` to open it, or \`trella init --force\` to rewrite the config.\n`
    );
    return 0;
  }

  const workspace = initWorkspace(root, {
    workspaceName: flagString(flags as never, 'name'),
    port: flagNumber(flags as never, 'port'),
    force: flagBoolean(flags as never, 'force') ?? false,
  });

  const { client } = openClient(root);
  try {
    const summary = await client.workspace();
    const first = summary.boards[0]!;
    process.stdout.write(
      [
        `${style.bold('Created a Trella workspace')} in ${style.dim(workspace.dir)}`,
        '',
        `  workspace  ${workspace.config.workspace.name}`,
        `  project    general`,
        `  board      ${first.name}  ${style.dim(first.id)}`,
        `  columns    ${first.columns.map((column) => column.name).join(' → ')}`,
        `  identity   ${workspace.config.identity.name} (${workspace.config.identity.id})`,
        '',
        `Everything is plain JSON under ${style.dim('.agentboard/projects/')}.`,
        '',
        `Next: ${style.accent('trella start')}`,
        '',
      ].join('\n')
    );
    return 0;
  } finally {
    client.close();
  }
}

async function commandStart(flags: Flags): Promise<number> {
  const workspace = requireWorkspace();
  const running = readRuntime(workspace);
  if (running && !flagBoolean(flags as never, 'force')) {
    process.stdout.write(
      `A Trella service is already running for this project at ${style.accent(running.url)} (pid ${running.pid}).\n`
    );
    if (flagBoolean(flags as never, 'open') !== false) openBrowser(running.url);
    return 0;
  }

  const service = await startServer({
    workspace,
    webRoot: findWebRoot(),
    port: flagNumber(flags as never, 'port'),
    host: flagString(flags as never, 'host'),
    version,
  });

  const summary = service.board.workspace();
  const cards = summary.boards.reduce((total, board) => total + board.cardCount, 0);
  process.stdout.write(
    [
      '',
      `  ${style.bold('Trella')} ${style.dim(version)}`,
      `  ${workspace.config.workspace.name} · ${summary.boards.length} board${summary.boards.length === 1 ? '' : 's'} · ${cards} card${cards === 1 ? '' : 's'}`,
      '',
      `  Board      ${style.accent(service.url)}`,
      `  API        ${style.dim(`${service.url}/api/workspace`)}`,
      `  Data       ${style.dim(join(workspace.config.data, 'projects'))}`,
      `  Agents     ${style.dim('trella mcp  ·  trella boards')}`,
      '',
      `  ${style.dim('Press Ctrl+C to stop.')}`,
      '',
      '',
    ].join('\n')
  );

  if (!findWebRoot()) {
    process.stdout.write(
      `${style.warn('The interface is not built yet.')} Run \`npm run build\` in the Trella repository,\n` +
        `or use the API directly at ${service.url}/api/board.\n\n`
    );
  }

  if (flagBoolean(flags as never, 'open') !== false && workspace.config.server.open) {
    openBrowser(service.url);
  }

  await new Promise<void>((resolvePromise) => {
    const shutdown = () => {
      process.stdout.write(`\n${style.dim('Stopping Trella…')}\n`);
      void service.stop().then(resolvePromise);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
  return 0;
}

async function commandMcp(): Promise<number> {
  const { runMcpServer } = await import('@trella/mcp');
  // No cwd here on purpose: runMcpServer resolves TRELLA_PROJECT first, and a
  // GUI client that launches `trella mcp` has no useful working directory.
  await runMcpServer({ version });
  return 0;
}

/* --------------------------------------------------- project and board commands */

async function commandBoards(client: BoardClient, flags: Flags): Promise<number> {
  const summary = await client.workspace();
  if (flagBoolean(flags as never, 'json')) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  }

  for (const project of summary.projects) {
    const boards = summary.boards.filter((board) => board.projectId === project.id);
    process.stdout.write(
      `${style.bold(project.name)} ${style.dim(project.id)}${project.description ? style.dim(` — ${project.description}`) : ''}\n`
    );
    if (boards.length === 0) {
      process.stdout.write(`${style.dim('  no boards yet')}\n`);
    }
    for (const board of boards) {
      process.stdout.write(
        `  ${style.accent(board.id.padEnd(16))} ${board.name.padEnd(22)} ` +
          `${style.dim(`${board.openCount} open / ${board.cardCount} cards · ${board.columns.length} columns · ${board.cardPrefix}-n`)}\n`
      );
      if (board.description) process.stdout.write(`  ${' '.repeat(16)} ${style.dim(board.description)}\n`);
    }
    process.stdout.write('\n');
  }
  return 0;
}

async function commandBoard(
  client: BoardClient,
  positional: string[],
  flags: Flags
): Promise<number> {
  const snapshot = await client.board(positional[0] ?? boardFlag(flags));
  if (flagBoolean(flags as never, 'json')) {
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(
    [
      `${style.bold(snapshot.board.name)} ${style.dim(snapshot.board.id)}`,
      `${style.dim(`${snapshot.project.name} · cards are ${snapshot.board.cardPrefix}-n`)}`,
      snapshot.board.description ? `\n${snapshot.board.description}` : '',
      '',
      ...snapshot.board.columns.map((column) => {
        const count = snapshot.cards.filter((card) => card.status === column.id).length;
        return `  ${style.accent(column.id.padEnd(16))} ${column.name.padEnd(18)} ${style.dim(
          `${count} card${count === 1 ? '' : 's'} · ${column.color}${column.terminal ? ' · terminal' : ''}`
        )}`;
      }),
      '',
    ].join('\n')
  );
  return 0;
}

async function commandNewProject(
  client: BoardClient,
  positional: string[],
  flags: Flags
): Promise<number> {
  const name = requireArgument(positional.join(' ').trim(), 'a project name');
  const project = await client.createProject(
    { name, description: flagString(flags as never, 'description') },
    resolveActor(flags)
  );
  if (flagBoolean(flags as never, 'json')) {
    process.stdout.write(`${JSON.stringify({ project }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`Created project ${style.accent(project.id)} (${project.name}).\n`);
  return 0;
}

async function commandNewBoard(
  client: BoardClient,
  positional: string[],
  flags: Flags
): Promise<number> {
  const name = requireArgument(positional.join(' ').trim(), 'a board name');
  const columnNames = flagList(flags as never, 'columns');
  const columns: ColumnInput[] | undefined = columnNames?.map((column) => ({ name: column }));

  const board = await client.createBoard(
    {
      name,
      description: flagString(flags as never, 'description'),
      projectId: flagString(flags as never, 'project'),
      columns,
    },
    resolveActor(flags)
  );

  if (flagBoolean(flags as never, 'json')) {
    process.stdout.write(`${JSON.stringify({ board }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(
    [
      `Created board ${style.accent(board.id)} (${board.name}) in ${board.projectId}.`,
      `  columns  ${board.columns.map((column) => column.name).join(' → ')}`,
      `  cards    ${board.cardPrefix}-1, ${board.cardPrefix}-2, …`,
      `  use it   ${style.dim(`trella list --board ${board.id}`)}`,
      '',
    ].join('\n')
  );
  return 0;
}

async function commandUpdateBoard(
  client: BoardClient,
  positional: string[],
  flags: Flags,
  field: 'name' | 'description'
): Promise<number> {
  const target = requireArgument(positional[0], 'a board');
  const value = requireArgument(
    positional.slice(1).join(' ').trim(),
    field === 'name' ? 'a new name' : 'a description'
  );
  const board = await client.updateBoard(target, { [field]: value }, resolveActor(flags));
  process.stdout.write(`Updated ${style.accent(board.id)}: ${board.name}\n`);
  return 0;
}

async function commandDeleteBoard(
  client: BoardClient,
  positional: string[],
  flags: Flags
): Promise<number> {
  const target = requireArgument(positional[0], 'a board');
  const snapshot = await client.board(target);
  if (!flagBoolean(flags as never, 'yes')) {
    process.stderr.write(
      `${style.warn(`This deletes "${snapshot.board.name}" and its ${snapshot.cards.length} card(s).`)}\n` +
        `Run it again with --yes to confirm.\n`
    );
    return 1;
  }
  const removed = await client.deleteBoard(target, resolveActor(flags));
  process.stdout.write(`Deleted board ${style.accent(removed.id)}.\n`);
  return 0;
}

async function commandAddColumn(
  client: BoardClient,
  positional: string[],
  flags: Flags
): Promise<number> {
  const target = requireArgument(positional[0], 'a board');
  const name = requireArgument(positional.slice(1).join(' ').trim(), 'a column name');
  const board = await client.addColumn(
    target,
    {
      name,
      color: flagString(flags as never, 'color') as ColumnColor | undefined,
      terminal: flagBoolean(flags as never, 'terminal'),
      position: flagNumber(flags as never, 'position'),
    },
    resolveActor(flags)
  );
  process.stdout.write(
    `Added "${name}". Columns: ${board.columns.map((column) => column.name).join(' → ')}\n`
  );
  return 0;
}

async function commandRemoveColumn(
  client: BoardClient,
  positional: string[],
  flags: Flags
): Promise<number> {
  const target = requireArgument(positional[0], 'a board');
  const column = requireArgument(positional[1], 'a column id');
  const board = await client.removeColumn(target, column, resolveActor(flags), {
    moveCardsTo: flagString(flags as never, 'move-to'),
  });
  process.stdout.write(
    `Removed "${column}". Columns: ${board.columns.map((entry) => entry.name).join(' → ')}\n`
  );
  return 0;
}

async function commandRenameColumn(
  client: BoardClient,
  positional: string[],
  flags: Flags
): Promise<number> {
  const target = requireArgument(positional[0], 'a board');
  const column = requireArgument(positional[1], 'a column id');
  const name = positional.slice(2).join(' ').trim() || undefined;
  const board = await client.updateColumn(
    target,
    column,
    {
      name,
      color: flagString(flags as never, 'color') as ColumnColor | undefined,
      terminal: flagBoolean(flags as never, 'terminal'),
      position: flagNumber(flags as never, 'position'),
    },
    resolveActor(flags)
  );
  process.stdout.write(`Columns: ${board.columns.map((entry) => entry.name).join(' → ')}\n`);
  return 0;
}

/* --------------------------------------------------------------- card commands */

async function commandList(client: BoardClient, flags: Flags): Promise<number> {
  const snapshot = await client.board(boardFlag(flags));

  const filter: CardFilter = { boardId: snapshot.board.id };
  const status = flagString(flags as never, 'status');
  const assignee = flagString(flags as never, 'assignee');
  const label = flagString(flags as never, 'label');
  const priority = flagString(flags as never, 'priority') as Priority | undefined;
  const query = flagString(flags as never, 'query') ?? flagString(flags as never, 'q');
  if (status) filter.status = status;
  if (assignee) filter.assignee = assignee;
  if (label) filter.label = label;
  if (priority) filter.priority = priority;
  if (query) filter.query = query;
  if (flagBoolean(flags as never, 'archived')) filter.archived = true;
  else if (flagBoolean(flags as never, 'all')) filter.archived = undefined;
  else filter.archived = false;

  const cards = await client.listCards(filter);

  if (flagBoolean(flags as never, 'json')) {
    process.stdout.write(`${JSON.stringify({ board: snapshot.board, cards }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(
    `${style.bold(snapshot.board.name)} ${style.dim(`${snapshot.board.id} · ${snapshot.project.name}`)}\n\n`
  );
  if (cards.length === 0) {
    process.stdout.write(
      `No cards match. ${style.dim('Add one with `trella create "Your first card"`.')}\n`
    );
    return 0;
  }
  process.stdout.write(`${formatBoard(snapshot.board.columns, cards)}\n`);
  return 0;
}

async function commandShow(
  client: BoardClient,
  positional: string[],
  flags: Flags
): Promise<number> {
  const id = requireArgument(positional[0], 'a card id, e.g. TRL-12');
  const detail = await client.getCard(id);
  if (flagBoolean(flags as never, 'json')) {
    process.stdout.write(`${JSON.stringify(detail, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(
    `${formatCardDetail(detail.card, detail.card.comments, detail.activity)}\n`
  );
  return 0;
}

async function commandCreate(
  client: BoardClient,
  positional: string[],
  flags: Flags
): Promise<number> {
  const title = positional.join(' ').trim() || flagString(flags as never, 'title');
  requireArgument(title, 'a title, e.g. trella create "Fix the reconnect backoff"');

  const card = await client.createCard(
    {
      boardId: boardFlag(flags),
      title,
      description: flagString(flags as never, 'description'),
      acceptanceCriteria: flagString(flags as never, 'acceptance'),
      status: flagString(flags as never, 'status'),
      priority: flagString(flags as never, 'priority'),
      labels: flagList(flags as never, 'label'),
      position: flagNumber(flags as never, 'position'),
    },
    resolveActor(flags)
  );
  return report(card, flags, `Created ${style.accent(card.id)}`);
}

async function commandUpdate(
  client: BoardClient,
  positional: string[],
  flags: Flags
): Promise<number> {
  const id = requireArgument(positional[0], 'a card id, e.g. TRL-12');
  const patch: Record<string, unknown> = {};
  const title = flagString(flags as never, 'title');
  const description = flagString(flags as never, 'description');
  const acceptance = flagString(flags as never, 'acceptance');
  const priority = flagString(flags as never, 'priority');
  const labels = flagList(flags as never, 'label');
  const assign = flagString(flags as never, 'assign');

  if (title !== undefined) patch.title = title;
  if (description !== undefined) patch.description = description;
  if (acceptance !== undefined) patch.acceptanceCriteria = acceptance;
  if (priority !== undefined) patch.priority = priority;
  if (labels !== undefined) patch.labels = labels;
  if (flagBoolean(flags as never, 'unassign')) patch.assignee = null;
  else if (assign) {
    patch.assignee = {
      type: assign.startsWith('agent:') ? 'agent' : 'human',
      id: assign,
      name: flagString(flags as never, 'assign-name') ?? assign,
    };
  }

  if (Object.keys(patch).length === 0) {
    throw new TrellaError(
      'invalid_input',
      'Nothing to update. Pass at least one of --title, --description, --acceptance, --priority, --label, --assign or --unassign.'
    );
  }

  const card = await client.updateCard(
    id,
    patch,
    resolveActor(flags),
    flagNumber(flags as never, 'expect')
  );
  return report(card, flags, `Updated ${style.accent(card.id)} to revision ${card.revision}`);
}

async function commandMove(
  client: BoardClient,
  positional: string[],
  flags: Flags
): Promise<number> {
  const id = requireArgument(positional[0], 'a card id, e.g. TRL-12');
  const status = requireArgument(
    positional[1] ?? flagString(flags as never, 'status'),
    'a destination column, e.g. trella move TRL-12 review'
  );
  const card = await client.moveCard(
    id,
    status,
    flagNumber(flags as never, 'position'),
    resolveActor(flags),
    flagNumber(flags as never, 'expect')
  );
  return report(card, flags, `Moved ${style.accent(card.id)} to ${card.status}`);
}

async function commandClaim(
  client: BoardClient,
  positional: string[],
  flags: Flags
): Promise<number> {
  const id = requireArgument(positional[0], 'a card id, e.g. TRL-12');
  const actor = resolveActor(flags);
  const card = await client.claimCard(id, actor, flagNumber(flags as never, 'expect'));
  return report(card, flags, `${actor.name} claimed ${style.accent(card.id)}`);
}

async function commandComment(
  client: BoardClient,
  positional: string[],
  flags: Flags
): Promise<number> {
  const id = requireArgument(positional[0], 'a card id, e.g. TRL-12');
  const body = positional.slice(1).join(' ').trim() || flagString(flags as never, 'body') || '';
  requireArgument(body, 'a comment body');

  const comment = await client.addComment(id, body, resolveActor(flags));
  if (flagBoolean(flags as never, 'json')) {
    process.stdout.write(`${JSON.stringify({ comment }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`Added a comment to ${style.accent(id)}.\n`);
  return 0;
}

async function commandArchive(
  client: BoardClient,
  positional: string[],
  flags: Flags,
  archived: boolean
): Promise<number> {
  const id = requireArgument(positional[0], 'a card id, e.g. TRL-12');
  const card = await client.setArchived(
    id,
    archived,
    resolveActor(flags),
    flagNumber(flags as never, 'expect')
  );
  return report(
    card,
    flags,
    archived ? `Archived ${style.accent(card.id)}` : `Restored ${style.accent(card.id)}`
  );
}

async function commandActivity(
  client: BoardClient,
  positional: string[],
  flags: Flags
): Promise<number> {
  const activity = await client.getActivity({
    cardId: positional[0],
    boardId: positional[0] ? undefined : boardFlag(flags),
    limit: flagNumber(flags as never, 'limit') ?? 30,
  });
  if (flagBoolean(flags as never, 'json')) {
    process.stdout.write(`${JSON.stringify({ activity }, null, 2)}\n`);
    return 0;
  }
  if (activity.length === 0) {
    process.stdout.write(`No activity yet.\n`);
    return 0;
  }
  for (const entry of activity) {
    const card = entry.cardId ? style.accent(entry.cardId.padEnd(9)) : ' '.repeat(9);
    process.stdout.write(`${card} ${formatActivityLine(entry)}\n`);
  }
  return 0;
}

/* ------------------------------------------------------------------- helpers */

function report(card: unknown, flags: Flags, message: string): number {
  if (flagBoolean(flags as never, 'json')) {
    process.stdout.write(`${JSON.stringify({ card }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`${message}\n  ${formatCardLine(card as never)}\n`);
  return 0;
}

function requireArgument<T>(value: T | undefined, expected: string): T {
  if (value === undefined || value === null || value === '') {
    throw new TrellaError('invalid_input', `Provide ${expected}.`);
  }
  return value;
}

function readVersion(): string {
  try {
    return (
      JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { version: string }
    ).version;
  } catch {
    return '0.0.0';
  }
}

/** The built interface: bundled next to the CLI when published, in apps/web during development. */
function findWebRoot(): string | null {
  const candidates = [join(packageRoot, 'web'), resolve(packageRoot, '../../apps/web/dist')];
  return candidates.find((candidate) => existsSync(join(candidate, 'index.html'))) ?? null;
}

function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  const args = process.platform === 'win32' ? ['', url] : [url];
  try {
    const child = spawn(command, args, {
      stdio: 'ignore',
      detached: true,
      shell: process.platform === 'win32',
    });
    child.unref();
  } catch {
    // Opening a browser is a convenience; the URL is already printed.
  }
}

const exitCode = await main(process.argv.slice(2)).catch((error: unknown) => {
  if (isTrellaError(error)) {
    process.stderr.write(`${style.danger(error.message)}\n`);
    if (error.code === 'conflict' && error.details.currentRevision) {
      process.stderr.write(
        `${style.dim(`Re-read the card with \`trella show ${String(error.details.cardId)}\` and retry with --expect ${String(error.details.currentRevision)}.`)}\n`
      );
    }
    return error.code === 'conflict' ? 2 : 1;
  }
  process.stderr.write(`${style.danger(error instanceof Error ? error.message : String(error))}\n`);
  return 1;
});

process.exitCode = exitCode;
