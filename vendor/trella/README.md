<div align="center">

# Trella

**A local-first task board shared by a developer and their coding agents.**

One board. A browser for you, an MCP server and a CLI for them, and plain JSON
on disk underneath. No database, no hosted service, no account.

[Getting started](#getting-started) · [Concepts](#concepts) ·
[Connecting an agent](#connecting-an-agent) · [Command line](#command-line) ·
[Data format](#data-format) · [Architecture](#architecture)

</div>

<p align="center">
  <img src="docs/images/trella-board.png" alt="Trella showing a local project board with work across backlog, review, and done" width="1200">
</p>

## In one minute

Trella gives you and your coding agents **one shared task board** inside a
project folder. You see the work in a browser; an agent can read and update the
same cards through MCP, the command line, or simple JSON requests.

Use it when tasks are getting lost between chat, terminal sessions, and
`TODO.md`. Each card has an owner, status, comments, and history, so it is clear
what is being worked on, what changed, and what needs a human decision.

**Start it:** clone the repository, run `./run.sh`, then open the local board.
There is no account to create and no service to sign up for. Your board stays in
`.agentboard/` as plain JSON that you can inspect, commit, or delete.

---

## The problem

A year ago, the work in a repository was done by people, and the tools for
coordinating it assumed as much. That assumption has quietly stopped holding.
A planning agent drafts the backlog, an implementation agent picks something up,
a review agent reads the diff — and the person who owns the repository is meant
to know what all of them are doing.

In practice they do not, because there is nowhere for everyone to look.

The options today are all bad in the same way. **Hosted trackers** — Jira, Linear,
GitHub Projects — are excellent for teams of people and hostile to agents: they
want an account, a network round trip, an API token with a scope somebody has to
approve, and a data model that has no idea what an agent is. **Markdown task
files** go the other way: an agent can read `TODO.md` in one call, but nobody can
see the shape of the work, two writers silently clobber each other, and "who
changed this and when" is whatever `git blame` happens to say. **Chat history**
is not a task list, though a great deal of work is currently tracked there.

So the state of the work ends up split across a person's head, an agent's context
window, and a scrollback buffer — and every handoff between them loses something.

What is missing is small and specific: a shared surface, local to the repository,
that a person can *look at* and an agent can *call*, where every change is
attributed and nothing is lost when two actors move at once.

## What Trella is

Trella is that surface. It runs as a small process in your project directory and
gives you two front doors onto the same data:

- **A Kanban board in the browser**, built as a considered piece of interface
  work rather than an admin panel — drag and drop, live updates, card details,
  full history, light and dark, and complete keyboard access.
- **A programmatic layer for agents** — an MCP server, a CLI, and a file-drop
  adapter — all of which call the same domain service the interface does, and
  obey the same validation.

Everything lives in `.agentboard/` as readable JSON. You can open it, diff it,
commit it, or delete it. There is nothing else to run.

Trella deliberately does **not** launch, schedule, or pay for agents. It is the
workspace they share with you, not a runner.

### Design principles

| Principle | What it means in practice |
| --- | --- |
| **Attribution is not optional** | Every mutation carries an actor. An automated change never appears under your name. |
| **Nothing is lost to a race** | Every card has a revision; a stale write is refused with the current card attached, and the interface makes you choose. |
| **The data is yours** | Plain JSON in your repository. No export feature, because nothing was ever locked in. |
| **Local by default** | Binds to `127.0.0.1`, refuses requests not addressed to localhost, and needs no network at all. |
| **The interface is the product** | See [DESIGN.md](DESIGN.md) — the identity, the token system, and the interaction rules, all measured rather than asserted. |

---

## Getting started

**Requirements:** Node 22.5 or newer. Nothing else — storage is the Node standard
library, so there is no native module to compile and no database to install.

```bash
git clone <your-fork-url> trella && cd trella
```

Then, from that directory:

```bash
./run.sh
```

`run.sh` installs dependencies, builds, creates a workspace, and opens the board.
Subsequent runs skip straight to starting the service. To open a board for a
different project, pass its path:

```bash
./run.sh ~/code/my-app
```

The board is served at `http://127.0.0.1:4174`. Press `Ctrl+C` to stop it.

The address names what is on screen, so a board or a card can be linked to:

```text
http://127.0.0.1:4174/?board=sprint-1
http://127.0.0.1:4174/?board=platform/sprint-1&card=SPR-14
http://127.0.0.1:4174/?card=SPR-14
```

- `board` is a board id, a slug or `project/slug`: the references agents and the
  CLI accept. It picks the board to open.
- `card` is a card key such as `SPR-14`. It opens that card's detail panel. Keys
  are unique across the workspace, so `card` alone is enough and opens the card's
  own board. When both are given and the card is on another board, `board` wins
  and no card opens.
- The page reads both when it loads. After that it keeps them in step as you
  switch boards or open and close cards, by replacing the address: no reload and
  no history entry per click. It writes the board's id, which never changes.
- An unknown board or card is ignored. The page opens as it does without them,
  and shows no error.

> Once Trella is published to npm, the same flow becomes
> `npx trella init && npx trella start`.

---

## Concepts

```text
workspace                       one directory, holding .agentboard/
└── project                     "General", "Platform", "Research"…
    └── board                   its own columns, its own card prefix
        └── card                TRL-1, SPR-14…
```

**Workspace.** One directory — normally the root of a repository. Everything
Trella knows about lives in `.agentboard/` inside it.

**Project.** A grouping of boards. Every workspace has a project called
**General**, which is where a board goes when nobody said where it belongs.

**Board.** The unit an agent works against. A board has a name, a description, and
**its own columns**, so two boards in the same project can model entirely
different workflows. Each board also has a card prefix, so ids never collide.

**Column.** A stage in that board's workflow. New boards start with
**Backlog · To do · In progress · Review · Done · Failed**, where Done and Failed
are both terminal. That set is a default, not a rule: a board can be created with
any columns at all, and columns can be added, renamed, recoloured, reordered or
removed afterwards — from the board, the CLI, or an agent. Removing a column
moves its cards somewhere you choose; it never deletes work.

**Card.** A unit of work: title, description, acceptance criteria, priority,
labels, assignee, comments, and a complete activity history. Card ids are unique
across the workspace (`SPR-14`), so a card can always be found without naming its
board.

---

## Connecting an agent

### Claude Code

From the project directory you want a board for:

```bash
claude mcp add trella -- node /absolute/path/to/trella/packages/cli/bin/trella.js mcp
```

To share it with everyone working on that repository, commit a `.mcp.json` at its
root instead:

```json
{
  "mcpServers": {
    "trella": {
      "command": "node",
      "args": ["/absolute/path/to/trella/packages/cli/bin/trella.js", "mcp"],
      "env": {
        "TRELLA_ACTOR": "{\"type\":\"agent\",\"id\":\"agent:claude-code\",\"name\":\"Claude Code\"}"
      }
    }
  }
}
```

`TRELLA_ACTOR` is what makes an agent's changes appear as the agent rather than
as you. Without it, every automated write is recorded under the human identity in
`.agentboard/config.json`.

This repository ships its own `.mcp.json`, so opening Trella itself in an
MCP-capable editor gives you the tools with no configuration.

Setup for Claude Desktop and other MCP clients is in [docs/mcp.md](docs/mcp.md).

### Then simply ask

> — What's on my Trella board?
> — Add a card for the reconnect bug, high priority, with acceptance criteria.
> — Claim TRL-4, move it to in progress, and leave a note about what you changed.
> — Make me a board called Research with columns Asked, Digging, Answered.

### What the agent is told

The server ships instructions that every client reads on connect:

1. Call `list_boards` first and keep the `board_id` for the session.
2. **Never create a project or board unless the user explicitly asks.** If it is
   unclear which board is meant, ask — do not guess, and do not invent one as a
   workaround.
3. Claim a card before working on it, move it as its state changes, and leave a
   comment carrying enough context for whoever picks it up next.
4. Send `expected_revision` on writes, so a concurrent change surfaces as a
   conflict instead of an overwrite.

### Tools

| Tool | Purpose |
| --- | --- |
| `list_boards` | Every project and board, with the `board_id` everything else needs |
| `get_board` | One board: its columns and its cards |
| `create_board` · `create_project` | New board or project — on explicit request only |
| `update_board` | Rename a board or change its description |
| `add_column` · `remove_column` | Change a board's workflow; removing relocates its cards |
| `list_tasks` · `get_task` | Read cards, filtered or in full |
| `create_task` · `update_task` · `move_task` | Write cards, with optional `expected_revision` |
| `claim_task` | Assign to yourself; fails if another actor already holds it |
| `add_comment` | Leave handoff context |
| `get_activity` | History for one card, or a whole board |

Every tool that writes takes an optional `agent_identity` (`{type, id, name}`), so
several agents can share one server and still be told apart; without it the write
is recorded under the server's identity. `get_activity` returns each actor's `id`
as well as its name.

Read tools are annotated `readOnlyHint`, so clients can distinguish a safe look
from a change. A recommended working process is in
[docs/agent-playbook.md](docs/agent-playbook.md).

### Agents that cannot speak MCP

Drop a JSON request into `.agentboard/inbox/` and read the result from
`.agentboard/outbox/`. The same domain service applies it, with the same
validation and the same activity log. See
[docs/file-adapter.md](docs/file-adapter.md).

---

## Command line

```bash
# Projects and boards
trella boards                                    # everything, with ids
trella board sprint-1                            # one board and its columns
trella new-project "Platform" --description "Under the hood"
trella new-board "Sprint 1" --project Platform --columns "Inbox,Doing,Shipped"
trella add-column sprint-1 "Blocked" --color rose --position 1
trella remove-column sprint-1 inbox --move-to doing

# Cards
trella list --board sprint-1
trella create "Fix the reconnect backoff" --priority high --label api
trella show SPR-1
trella move SPR-1 doing
trella claim SPR-1 --as "Codex"
trella comment SPR-1 "Reproduced with a 3s drop; adding jitter."
trella activity SPR-1
```

Add `--json` to any read command for machine-readable output, and `--board` to
any card command to choose a board. Without one, the first board in **General**
is used.

When the local service is running, CLI commands go through it so an open board
updates immediately. When it is not, the same domain service reads and writes the
files directly.

---

## Data format

Everything is JSON you can read, diff and commit:

```text
.agentboard/
├── config.json                                     workspace settings, your identity
├── state.json                                      change stamp (machine-local)
└── projects/
    └── general/
        ├── project.json
        └── boards/
            └── bd_7fk3n2q1/
                ├── board.json                      name, description, columns
                ├── activity.jsonl                  append-only history
                └── cards/
                    ├── TRL-1.json
                    └── TRL-2.json
```

Plain files give no transactions, so Trella supplies the two guarantees that
would otherwise be lost. Every write goes to a temporary file and is moved into
place, so a reader never observes half a card. Every mutation runs inside a
cross-process lock directory, so two writers cannot interleave; `state.json` is
stamped last, which is how another process knows to reload.

The generated `.agentboard/.gitignore` commits the board and ignores the parts
that are specific to one machine.

Writing to these files directly is not supported. It would bypass validation, the
activity log, the lock, and the live event stream — use the CLI, the MCP server,
or the file adapter.

---

## Architecture

```text
Browser UI ──┐
CLI ─────────┼──▶ domain service (@trella/core) ──▶ JSON files in .agentboard/
MCP server ──┘             │
File adapter ──────────────┤
                           └──▶ event stream (SSE) ──▶ every open board
```

| Package | Responsibility |
| --- | --- |
| `packages/core` | The only place state changes: store, validation, ordering, optimistic concurrency, activity log, events |
| `packages/server` | Local HTTP API, event stream, static hosting, file adapter |
| `packages/cli` | The `trella` command; prefers the running service, falls back to the files |
| `packages/mcp` | MCP tools over the same client |
| `apps/web` | The board interface |

No channel reimplements a mutation. Adding one means adding a caller of
`@trella/core`, not a second copy of the rules.

### Concurrency

Every card carries a `revision`. Supply `expectedRevision` (`--expect` on the
CLI, `expected_revision` over MCP) with a write, and a stale one is refused with a
`409` that includes the current card — enough to diff and retry without a second
read. In the interface this appears as a side-by-side choice between your version
and theirs; text is never silently replaced.

### Design system

Colour is generated, not hand-typed. `scripts/design-tokens.mjs` builds the
OKLCH token file and measures the APCA contrast of every pair the interface
actually renders, in both light and dark, failing the build if one drops below
its threshold.

```bash
npm run tokens        # regenerate apps/web/src/styles/tokens.css
npm run tokens:check  # measure contrast, gamut and elevation
```

---

## Development

```bash
npm install
npm run build
npm test          # domain and API suites
npm run typecheck
```

Two terminals is the usual loop — the service against a scratch workspace, and
the interface with hot reload:

```bash
node scripts/seed.mjs --path /tmp/trella-demo --cards 40 && ./run.sh /tmp/trella-demo
```

```bash
npm run dev --workspace @trella/web
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full loop and what review looks
for, and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for how we work together.

---

## Status

Trella is at `0.1.0` and has not been published to npm yet; installation is by
clone. The domain model, the API, the CLI, the MCP server and the interface are
complete and covered by 71 tests, including end-to-end runs against the real CLI
and MCP binaries. Known open work is tracked on Trella's own board — run
`./run.sh` in this repository to see it.

---

## Third-party components

| Component | Licence | Used for |
| --- | --- | --- |
| [React](https://react.dev) | MIT | Interface |
| [@dnd-kit](https://dndkit.com) | MIT | Accessible drag and drop |
| [Tailwind CSS](https://tailwindcss.com) | MIT | Styling system |
| [Lucide](https://lucide.dev) | ISC | Icons |
| [Motion](https://motion.dev) | MIT | Animation |
| [Vite](https://vite.dev) | MIT | Build tooling |
| [Instrument Sans / Instrument Serif](https://github.com/Instrument/instrument-sans) | OFL-1.1 | Typography |
| [JetBrains Mono](https://www.jetbrains.com/lp/mono/) | OFL-1.1 | Identifiers and timestamps |
| [@modelcontextprotocol/sdk](https://modelcontextprotocol.io) | MIT | MCP server |

Trella uses the Kanban mental model, which long predates any product built on it.
It contains no branding, assets, or code from another task board.

---

## Licence

[MIT](LICENSE).
