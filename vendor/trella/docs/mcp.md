# Connecting an agent over MCP

Trella ships an MCP server that speaks over stdio. It is optional — the board and
the CLI work without it — but it is the smoothest route for an MCP-capable agent.

The server reads the workspace from whichever directory it starts in, so the
`cwd` (or `TRELLA_PROJECT`) is what selects the workspace.

## Run it

```bash
trella mcp
```

From this repository before publishing, the same thing is:

```bash
node /absolute/path/to/Trella/packages/cli/bin/trella.js mcp
```

Nothing to configure. If the local service is running the tools go through it, so
an open board sees changes immediately; if it is not, they read and write the
JSON files directly.

## Identity

Set an identity, or every agent write is recorded as the human who owns the
project:

```bash
TRELLA_ACTOR='{"type":"agent","id":"agent:codex","name":"Codex"}'
```

`TRELLA_AGENT_NAME` and `TRELLA_AGENT_ID` work too, if a single JSON value is
awkward in your client's config.

### Several agents on one server

That identity is the default for every write. When several agents share one
server (a coordinator and its subagents, say), each passes its own as
`agent_identity` on the call, in the same shape as `TRELLA_ACTOR`:

```json
{
  "task_id": "SPR-4",
  "destination_status": "review",
  "agent_identity": { "type": "agent", "id": "agent:sonnet-api", "name": "Sonnet API" }
}
```

Every tool that writes takes it: `create_board`, `create_project`,
`update_board`, `add_column`, `remove_column`, `create_task`, `update_task`,
`move_task`, `claim_task` and `add_comment`. The card's last actor, the comment
and the activity entry are recorded under that identity. Without the field
nothing changes: the call is recorded under the server's identity. Names in any
script work. There is no archive or restore tool over MCP, so there is nothing to
pass there.

Trella records the identity a caller declares; it does not authenticate it.

`get_activity`, and the activity inside `get_task`, return `actor_id` next to
`actor`, so two agents with the same display name can still be told apart.

## Claude Code

```bash
claude mcp add trella -- node /absolute/path/to/Trella/packages/cli/bin/trella.js mcp
```

Or in `.mcp.json` at your project root, so the whole team gets it:

```json
{
  "mcpServers": {
    "trella": {
      "command": "node",
      "args": ["/absolute/path/to/Trella/packages/cli/bin/trella.js", "mcp"],
      "env": {
        "TRELLA_ACTOR": "{\"type\":\"agent\",\"id\":\"agent:claude-code\",\"name\":\"Claude Code\"}"
      }
    }
  }
}
```

Once Trella is published to npm, `command` becomes `npx` and `args` becomes
`["-y", "trella", "mcp"]`.

### The Code tab in the Claude desktop app

The Code surface in the desktop app **is** Claude Code, so it reads the same two
places: `.mcp.json` at the root of the project you have open (project scope), and
`mcpServers` in `~/.claude.json` (user scope, every project). The chat side of the
app is separate — that reads `claude_desktop_config.json` and is configured under
Settings → Connectors.

For every project you open:

```bash
claude mcp add --scope user trella -- node /absolute/path/to/Trella/packages/cli/bin/trella.js mcp
```

A project-scoped server asks for approval the first time you open that project.

## Claude Desktop (chat, not Code)

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`, then
restart the app completely — quit it, do not just close the window.

```json
{
  "mcpServers": {
    "trella": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/absolute/path/to/Trella/packages/cli/bin/trella.js", "mcp"],
      "env": {
        "TRELLA_PROJECT": "/absolute/path/to/your/project",
        "TRELLA_ACTOR": "{\"type\":\"agent\",\"id\":\"agent:claude\",\"name\":\"Claude\"}"
      }
    }
  }
}
```

Two things differ from a terminal-launched client, and both cause silent
failures:

**Use an absolute path to `node`.** A macOS application launched from the Dock
does not inherit your shell's `PATH`, so a bare `"node"` is often not found.
Run `command -v node` and paste the result. If that path contains `nvm`, `fnm`,
`volta` or `asdf`, it will also move the next time you change Node version —
point at a stable install instead.

**Set `TRELLA_PROJECT`.** A desktop client has no project directory to start in,
so there is nothing for the server to infer a workspace from. It selects the
workspace; without it the server starts fine but every read reports that there
is no board here.

## Any other stdio MCP client

| Field | Value |
| --- | --- |
| Command | `node` (or `npx` once published) |
| Arguments | the path to `packages/cli/bin/trella.js`, then `mcp` |
| Working directory | your project root, or set `TRELLA_PROJECT` |
| Environment | `TRELLA_ACTOR` (recommended), `TRELLA_URL` (optional) |

`TRELLA_URL` points the tools at a service on a specific address instead of
discovering it from `.agentboard/service.json`.

## What the agent is told to do

The server ships instructions that the client reads on connect:

1. Call `list_boards` first, and keep the `board_id` for the session.
2. **Do not create a project or a board unless the user explicitly asks.** If it
   is not clear which board is meant, ask — do not invent one as a workaround.
3. Claim a card before working on it, move it as its state changes, and leave a
   comment with handoff context.
4. Send `expected_revision` on writes so a concurrent change surfaces as a
   conflict rather than an overwrite.

## Tools

| Tool | Purpose |
| --- | --- |
| `list_boards` | Every project and board, with the `board_id` everything else needs |
| `get_board` | One board: its columns and its cards |
| `create_board` | A new board, with default or custom columns — on request only |
| `create_project` | A new project — on request only |
| `update_board` | Rename a board or change its description |
| `add_column` / `remove_column` | Change a board's workflow; removing moves its cards, never deletes them |
| `list_tasks` | Cards on a board, filtered |
| `get_task` | One card with description, criteria, comments and activity |
| `create_task` | Add a card to a board |
| `update_task` | Change fields, with optional `expected_revision` |
| `move_task` | Move to another column, optionally at an index |
| `claim_task` | Assign to yourself; fails if someone else holds it |
| `add_comment` | Leave handoff context |
| `get_activity` | History for a card or a whole board, with each actor's name and `actor_id` |

Every tool that writes also takes an optional `agent_identity`; see
[Identity](#several-agents-on-one-server).

See [the agent playbook](agent-playbook.md) for a recommended process, and
[the file adapter](file-adapter.md) for agents that cannot speak MCP.

## Troubleshooting

**"No Trella workspace here yet."** The server started outside a project that has
been initialised. Run `trella init` there, or set `TRELLA_PROJECT`.

**Every change is attributed to the human.** `TRELLA_ACTOR` is not reaching the
process. Check that your client passes `env` through.

**The agent keeps creating boards.** It should not. Tell it which board to use by
name; the tools accept a board id, a slug, or `project/slug`.

**Writes fail with `conflict`.** That is the feature working: somebody changed
the card since the agent read it. It should re-read and retry with the new
revision.
