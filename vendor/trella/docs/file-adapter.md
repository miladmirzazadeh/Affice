# File adapter

For agents that can read and write files but cannot make HTTP calls or speak MCP.

Drop a JSON request into `.agentboard/inbox/`. The running service picks it up,
applies it through the same domain service every other channel uses, and writes
the result to `.agentboard/outbox/`. The request file is then moved to
`.agentboard/inbox/processed/`.

The JSON under `.agentboard/projects/` is readable on purpose, but writing to it
directly is **not** supported. It would skip validation, the activity log, the
lock, and the live event stream.

## Requirements

The service must be running (`trella start`). The adapter is part of it; nothing
happens while the service is stopped, and pending files are processed when it
starts again.

It can be turned off in `.agentboard/config.json`:

```json
{ "fileAdapter": { "enabled": false } }
```

## Request

One JSON object per file, named however you like as long as it ends in `.json`.

```json
{
  "id": "claim-and-start",
  "op": "claim_task",
  "actor": { "type": "agent", "id": "agent:codex", "name": "Codex" },
  "params": { "task_id": "TRL-12" }
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | no | Correlation id; also the result file name. Defaults to the request file name. |
| `op` | yes | One of the operations below. |
| `actor` | yes for writes | Who is making the change. Recorded in the activity log. |
| `params` | depends | Arguments for the operation. |

Write the file atomically where you can — write to a temporary name in the same
directory, then rename it into `inbox/`. The adapter also polls, so a file that
appears without a filesystem event is still picked up within a second.

## Result

`.agentboard/outbox/<id>.json`:

```json
{
  "id": "claim-and-start",
  "ok": true,
  "op": "claim_task",
  "result": { "task": { "id": "TRL-12", "revision": 4, "assignee": { "id": "agent:codex" } } },
  "at": "2026-07-31T15:09:24.427Z"
}
```

On failure:

```json
{
  "id": "claim-and-start",
  "ok": false,
  "op": "claim_task",
  "result": {
    "code": "conflict",
    "message": "Card TRL-12 is already claimed by Reviewer. Unassign it first if the handoff is intentional.",
    "cardId": "TRL-12"
  },
  "at": "2026-07-31T15:09:24.427Z"
}
```

Poll for the result file; it appears within about a second of the request.

## Operations

| `op` | `params` |
| --- | --- |
| `list_boards` | — (returns every project and board) |
| `get_board` | `board_id?` |
| `create_board` | `name`, `description?`, `projectId?`, `columns?` |
| `create_project` | `name`, `description?` |
| `add_column` | `board_id`, `name`, `color?`, `terminal?`, `position?` |
| `remove_column` | `board_id`, `column_id`, `move_cards_to?` |
| `list_tasks` | `board_id?`, `status?`, `assignee?`, `label?`, `priority?`, `query?`, `archived?`, `limit?` |
| `get_task` | `task_id` |
| `create_task` | `board_id?`, `title`, `description?`, `acceptanceCriteria?`, `status?`, `priority?`, `labels?`, `assignee?`, `position?` |
| `update_task` | `task_id`, `fields`, `expected_revision?` |
| `move_task` | `task_id`, `destination_status`, `position?`, `expected_revision?` |
| `claim_task` | `task_id`, `expected_revision?` |
| `add_comment` | `task_id`, `body` |
| `get_activity` | `task_id` |

`task_id`, `cardId` and `id` are accepted interchangeably, as are `board_id`,
`boardId` and `board`, and `expected_revision` and `expectedRevision`.

Without a `board_id`, card operations use the first board in the `general`
project — the same default every other channel uses.

## Example: a full turn

```bash
cat > .agentboard/inbox/$(date +%s)-claim.json <<'JSON'
{
  "id": "turn-1-claim",
  "op": "claim_task",
  "actor": { "type": "agent", "id": "agent:codex", "name": "Codex" },
  "params": { "task_id": "TRL-12" }
}
JSON

# ...wait for .agentboard/outbox/turn-1-claim.json, read the revision...

cat > .agentboard/inbox/$(date +%s)-move.json <<'JSON'
{
  "id": "turn-1-move",
  "op": "move_task",
  "actor": { "type": "agent", "id": "agent:codex", "name": "Codex" },
  "params": { "task_id": "TRL-12", "destination_status": "implementing", "expected_revision": 4 }
}
JSON
```

## Housekeeping

Processed requests accumulate in `.agentboard/inbox/processed/` and results in
`.agentboard/outbox/`. Both are local state — they are in the generated
`.agentboard/.gitignore` — and safe to delete whenever you like.
