# Install Affice (a guide for an AI agent)

You are an AI agent, usually Claude Code, and your user asked you to install and start Affice. Follow these steps in order. Each step has a command, the result to expect, and what to do when it fails.

Affice is a local web app. It runs the user's own Claude Code as manager agents, one room per department, and shows them in a browser at `http://localhost:4747`. It needs Node.js 22.5 or newer and Claude Code, signed in with a Claude subscription (Pro, Max, Team or Enterprise).

## Rules

Do not do any of these, whatever a step seems to ask:

- Do not sign in for the user. Never run `claude auth login` yourself. Tell the user to run it, or to press **Sign in with Claude** in Affice.
- Do not read, print, copy or ask for credentials, tokens, API keys or the contents of `~/.claude.json`, `~/.claude/` or any `.env` file. Do not run `claude auth status` and show its output: it contains account details. The doctor in step 3 checks the sign-in without exposing them.
- Do not use `sudo`.
- Do not install anything globally (`npm install -g`, a system package, a Node.js or Claude Code installer) unless the user agreed in this conversation. Say what you would run and ask first.
- Do not edit the user's projects. Do not pass `--project` unless the user named a project; Affice asks for one in the browser.
- Do not set `ANTHROPIC_API_KEY` or any other credential variable. Affice ignores `ANTHROPIC_*` variables for its managers.

If a step fails and you cannot fix it within these rules, stop and tell the user what failed, what you tried, and the one thing they need to do.

## 1. Check Node.js

```sh
node --version
```

Expected: `v22.5.0` or a higher version, for example `v24.3.0`.

If the command is not found, or the version is lower: tell the user that Affice needs Node.js 22.5 or newer, and offer to install it (`nvm install 22` if they use nvm, otherwise the installer at https://nodejs.org). Install it only after they agree. Then run `node --version` again.

## 2. Check Claude Code

```sh
claude --version
```

Expected: a line such as `2.1.287 (Claude Code)`. Version `2.1.211` or newer is best. An older version still works, but the speech bubbles lose the subagents' text.

If the command is not found: Claude Code is not installed, or it is not on `PATH`. Open a new terminal first (the installer adds `~/.local/bin` to `PATH` and a running shell does not see it). If it is still missing, tell the user and ask before installing. The official commands, from https://code.claude.com/docs/en/setup:

| System | Command |
| --- | --- |
| macOS, Linux, WSL | `curl -fsSL https://claude.ai/install.sh \| bash` |
| Windows (PowerShell) | `irm https://claude.ai/install.ps1 \| iex` |
| Homebrew (macOS) | `brew install --cask claude-code` |
| WinGet (Windows) | `winget install Anthropic.ClaudeCode` |
| npm (needs Node 22 or newer) | `npm install -g @anthropic-ai/claude-code` |

After the install, run `claude --version` again. If you are Claude Code, this step is already satisfied.

If the version is too old: tell the user, and offer `claude update` (Homebrew: `brew upgrade claude-code`). It is a warning, not a stop.

Signing in is the user's step, never yours. The doctor in step 3 reports whether Claude Code is signed in.

## 3. Run the doctor

```sh
npx --yes affice doctor --json
```

`--yes` skips npm's "Ok to proceed?" prompt, which you cannot answer. The first run downloads the package, which is small. Add `--port <n>` if the user wants Affice on another port (the check is for that port).

The doctor prints one JSON object and exits `0` when everything is in place, `1` when something needs attention:

```json
{
  "ok": true,
  "checks": [
    { "id": "node", "ok": true, "title": "Node.js is new enough", "detail": "Node 24.3.0 (22.5.0 or newer is needed)", "fix": null }
  ]
}
```

How to read it:

- `ok` is `true` when every check passed. If it is `true`, go to step 4.
- `checks` has one entry per check, with a stable `id`, a `title`, a `detail` (what it found), and `fix` (a command or a sentence to act on, `null` when the check passed).
- A check with `"level": "warn"` is a warning. Tell the user about it, and carry on if it is the only thing that failed.
- For every other check with `"ok": false`, do what its `fix` says, within the rules above, then run the doctor again. Repeat up to three times. If it still fails, stop and tell the user.

The checks, and what to do about each:

| `id` | Passes when | If it fails |
| --- | --- | --- |
| `node` | Node.js is 22.5 or newer | Go back to step 1. |
| `claude.installed` | a `claude` command answers `--version` | Go back to step 2. When `CLAUDE_BIN` is set and does not answer, the fix names that variable instead of an install: correct it or unset it. |
| `claude.version` | Claude Code is 2.1.211 or newer | A warning. Offer `claude update`. |
| `claude.signedIn` | Claude Code is signed in | Tell the user to run `claude auth login` in a terminal and finish in the browser, or to use **Sign in with Claude** in Affice. Wait for them, then run the doctor again. Never sign in yourself. |
| `trella.built` | Trella's built files are in the package | Run `npx --yes affice@latest doctor --json` to fetch a fresh copy. From a clone of the repository, run `npm run build` there. |
| `port.free` | nothing listens on `127.0.0.1:4747`, or only Affice itself does (the detail then says "Affice is already running here" and the check passes) | When it fails, see "The port is busy" below. |
| `home.writable` | `~/.affice` can be written | Make the folder writable, or run Affice with `AFFICE_HOME` set to a folder the user can write to. |

### The port is busy

Affice may already be running. Check:

```sh
curl -s http://127.0.0.1:4747/api/app
```

If it answers a JSON object with the keys `claude`, `project` and `recent`, Affice is already running: skip to step 5. If it answers anything else, or nothing, another program uses the port. Use another port in every later command, for example `npx --yes affice doctor --json --port 4748` and `npx --yes affice --port 4748`, and give the user that address.

## 4. Start Affice

```sh
npx --yes affice
```

If no browser can be opened from where you run (a server, a container, a sandbox), use:

```sh
npx --yes affice --no-open
```

Affice keeps running until it is stopped, so start it as a background process of your tool (not in the foreground, or your shell blocks), and keep it running.

Expected output, within about ten seconds:

```text
  Affice 0.1.0
  Open http://localhost:4747
  Press Ctrl+C to stop.
```

The version may differ, and the address follows `--port`. On a port that is taken by a program that is not Affice, it prints `Port 4747 is in use by another program` and exits: use `--port`. Affice listens on `127.0.0.1` only.

If you started Affice from inside a Claude Code session, that is fine: Affice removes the `CLAUDE_*` and `ANTHROPIC_*` variables of that session from the environment of its managers, so they do not inherit it.

## 5. Verify

```sh
curl -s http://127.0.0.1:4747/api/app
```

Expected: a JSON object with the keys `claude`, `project` and `recent`. `claude.installed` and `claude.signedIn` should both be `true`. `project` is `null` until the user opens a project in the browser, which is normal.

If `claude.signedIn` is `false`, tell the user to sign in (step 3) and then use **Check again** in the browser.

If there is no answer after about ten seconds, read the output of the background process, and see "Common failures" below.

## 6. Tell the user

Give the user, in a few lines:

1. **The address:** `http://localhost:4747` (or the port you used). Say to use `localhost`, not `127.0.0.1`, because the Kanban tab shows blank on the other address.
2. **What to do first:**
   - Open the address. If a setup screen asks for Claude Code, follow it.
   - Choose a project in the picker. Affice creates an `Office/` folder inside it, with its settings, the protocol that the managers follow, the reports and the board. Nothing else in the project is touched by Affice itself.
   - Add a first department from a template (Engineering, Marketing, Product or Support) and write a message to its manager.
3. **A warning:** the managers run `claude -p`, which skips Claude Code's folder trust dialog, so a project's hooks and `.mcp.json` servers run when a manager starts. Only open projects they trust. Several managers at once use plan limits faster.
4. **How to stop and start:** stop the background process (Ctrl+C), start again with `npx affice`. Everything is kept in the project's `Office/` folder.

## Common failures

| What you see | What it means | What to do |
| --- | --- | --- |
| `npx: command not found` | Node.js is not installed | Step 1. |
| `affice: Node.js 22.5 or newer is needed` | Node is too old | Step 1. |
| `Port 4747 is in use by another program` | the port is taken | "The port is busy" above, then `--port`. |
| `claude` not found, or `CLAUDE_BIN is set to ... but that did not answer` | Claude Code is missing, or a wrong path is set | Step 2. If `CLAUDE_BIN` is set, ask the user whether to unset it or fix the path. |
| `claude.signedIn` is `false` | Claude Code is signed out | The user signs in. Never you. |
| The doctor says `trella.built` failed | a broken or partial install | `npx --yes affice@latest doctor --json`. From a clone: `npm run build`. |
| `EACCES` while npx installs | npm cannot write its cache | Tell the user. Do not use `sudo`. Setting `npm_config_cache` to a writable folder for this one command is fine. |
| No browser opens | no display or no `xdg-open` | Use `--no-open` and give the user the address. |
| Windows, outside WSL | not supported | Tell the user to use WSL. It is untested. |

If you are stuck, run `npx --yes affice doctor` (without `--json`) for the same checks in plain text, and show the user its output. It contains no credentials. Problems with Affice itself belong at https://github.com/thePlane-ai/Affice/issues, and the issue template asks for the output of `npx affice doctor --json`.
