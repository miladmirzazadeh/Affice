# Agent playbook

Optional. Trella works without it — the tools are self-describing, and nothing
here is enforced. Hand this to an agent when you want a house style for how the
boards get worked.

The examples use the MCP tool names. The CLI takes the same arguments
(`trella move SPR-12 review --as "Codex"`), and the file adapter takes the same
`op` names.

---

## 0. Find the board before anything else

```
list_boards()
```

A workspace holds projects, a project holds boards, a board holds columns and
cards. `list_boards` returns every board with its `board_id`, project, name and
description. Pick the one the user is talking about and keep that id for the
session — every card tool takes it.

If two boards could plausibly be the one they meant, **ask**. Working the wrong
board is worse than a question.

**Do not create a project or a board unless the user explicitly asks for one.**
Not knowing which board to use is never a reason to make a new one.

When they do ask:

```
create_board({
  name: "Sprint 1",
  project_id: "platform",              // omit for "general"
  description: "Two weeks of platform work",
  columns: [{ name: "Inbox" }, { name: "Doing" }, { name: "Shipped", terminal: true }]
})
```

Leave `columns` out for the default workflow: Backlog, To do, In progress,
Review, Done, Failed.

## 1. Read the board, not your memory of it

```
get_board({ board_id: "bd_7fk3n2q1" })
```

Columns are per board. The board you are on may have no column called
"In progress" at all. Read them before you move anything.

## 2. Claim before you work

```
claim_task({ task_id: "SPR-12" })
```

A claim assigns the card to you. If another actor already holds it, the call
fails with a conflict — that is the point. Do not work a card you could not
claim; pick another, or ask.

## 3. Move the card as its state changes

```
move_task({ task_id: "SPR-12", destination_status: "doing" })
```

The human is watching the board. A card that sits in To do while you write code
tells them nothing. Move it when you start, and again when you finish.

## 4. Read the whole card before you change it

```
get_task({ task_id: "SPR-12" })
```

The description and acceptance criteria are the brief. The comments are the
handoff notes from whoever touched it last. The `revision` is what you send back.

## 5. Send the revision you read

```
update_task({
  task_id: "SPR-12",
  fields: { acceptance_criteria: "- [x] Reconnect with backoff\n- [ ] Add a test" },
  expected_revision: 7
})
```

If somebody changed the card while you were working, this returns a conflict with
their current version instead of overwriting them. Re-read, merge, and try again.
Never retry a conflict by dropping `expected_revision`.

## 6. Leave the handoff context

```
add_comment({
  task_id: "SPR-12",
  body: "Added jitter to the retry. The reconnect test is still flaky under load — see the note in server/stream.ts."
})
```

Write what the next actor needs: what you did, what is left, and anything
surprising. "Done" is not a handoff.

## 7. Submit, do not self-approve

```
move_task({ task_id: "SPR-12", destination_status: "review" })
```

Move finished work to the review column and stop. Moving your own card to Done
removes the one checkpoint the human has. If the work failed and is not coming
back, that is what a Failed column is for — with a comment saying why.

---

## Planning agents

When you turn a conversation into cards:

- Ask which board, or use the one the user named. Do not spread one piece of work
  across several boards.
- One card per thing that can be finished and reviewed on its own.
- Verb-first titles that name the change: "Reconnect the event stream with
  backoff", not "Reconnect issues".
- Put the detail in `description`, and put the finish line in
  `acceptance_criteria` as a `- [ ]` checklist. The board shows the progress.
- Set `priority` honestly. If everything is urgent, nothing is.
- Leave `status` as the default first column unless the work is genuinely ready
  to pick up.

## Review agents

- Read `get_activity` before deciding. Who changed what, and when, is usually the
  whole story.
- Record the decision as a comment, then move the card: the terminal column if it
  holds, back to the working column if it does not, with the reason in the
  comment.
- Never move a card to a terminal column without saying what you checked.

## Changing a board's shape

Columns are the user's workflow. Add or remove one when they ask, not because it
would suit your process:

```
add_column({ board_id: "bd_7fk3n2q1", name: "Blocked", position: 2 })
remove_column({ board_id: "bd_7fk3n2q1", column_id: "blocked", move_cards_to: "doing" })
```

Removing a column never deletes cards; they move to `move_cards_to`, or to the
first column if you do not say.

---

## Identity

Every write is attributed. Say who you are:

```bash
export TRELLA_ACTOR='{"type":"agent","id":"agent:codex","name":"Codex"}'
```

The MCP server also reads `TRELLA_AGENT_NAME` / `TRELLA_AGENT_ID`, and the CLI
takes `--as "Codex"`. Without one of these you will be recorded as the human who
owns the project, which is the one thing Trella tries hard never to do.

## Errors worth handling

| Code | What happened | What to do |
| --- | --- | --- |
| `conflict` | Somebody changed the card since you read it | Re-read, merge, retry with the new revision |
| `invalid_status` | That column does not exist on this board | The error lists the ones that do |
| `not_found` | No card, board or project with that id | Re-run `list_boards` or `list_tasks` |
| `invalid_input` | A field failed validation, or a name was ambiguous | The message names the field, or lists the candidates |
| `service_unavailable` | The local service is not running | Ask the human to run `trella start` |
