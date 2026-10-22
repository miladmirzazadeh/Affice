# Contributing to Affice

Thank you for helping. Affice is a small project, and issues, ideas and pull requests are all welcome. Please follow the [Code of Conduct](CODE_OF_CONDUCT.md). To report a security problem, see [SECURITY.md](SECURITY.md) and do not open a public issue.

## Set up

You need Node.js 22.5 or newer and git. Claude Code is only needed to try Affice yourself: the tests never start a real Claude session.

```sh
git clone https://github.com/thePlane-ai/Affice.git
cd affice
npm install
npm run build
npm test
```

`npm install` also installs the vendored Trella (`vendor/trella`) as npm workspaces. Do not edit files under `vendor/trella`: it is an unmodified copy of Trella, and changes belong in Trella's own repository.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run build` | Cleans `dist/`, typechecks, builds Trella, builds the page with Vite, and bundles the server and its commands with esbuild |
| `npm run typecheck` | `tsc --noEmit` over `client`, `server` and `shared` |
| `npm test` | Runs every `*.test.ts` file with Node's built-in test runner |
| `npm start` | `node bin/affice.js`: runs Affice as a user would, from the built `dist/` (run `npm run build` first) |
| `npm run dev:all` | Development: the office server (`tsx watch`, port 4747) and the Vite page (port 5190), through `start.sh` |
| `npm run dev` | The Vite page alone, on port 5190, proxying the API and the socket to port 4747 |
| `npm run server` | The office server alone, with `tsx watch` |
| `npm run trella -- <args>` | Runs the vendored Trella CLI |
| `npm run build:trella`, `build:client`, `build:server` | The parts of `build` on their own |

While `npm run dev` runs, `http://localhost:5190/?mock=1` replays a scripted office without a server, which is the quickest way to work on the scene, the chat and the panels. `&speed=3` plays it faster.

## Where things are

```text
bin/affice.js        the launcher (plain JavaScript)
server/              the Node server: host, office, sessions, approvals, data views, doctor
server/claude/       the Claude Code driver, the status and sign-in, the office MCP server
server/protocol/     PROTOCOL.md, the manager prompts, the MCP servers of a manager
shared/              the contract between server and page (types.ts and the two API files)
client/              the page: state, the 3D scene (three.js), the panels, the setup screens
fixtures/            the seed office, the mock timeline, a recorded Claude Code session
vendor/trella/       Trella, vendored and unmodified
docs/ARCHITECTURE.md how the parts fit together
```

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before a larger change. The files in `shared/` are the contract: a change there touches both sides, so keep it small and say why in the pull request.

## Tests

`npm test` runs `node --import tsx --test` over `server/**/*.test.ts`, `client/**/*.test.ts` and `shared/**/*.test.ts`. A few rules:

- **Never start a real Claude session.** Tests use fake `claude` scripts in a temporary folder (set with `CLAUDE_BIN`, or a `PATH` of fakes), recorded events (`fixtures/recorded-session.jsonl`) and fake sessions.
- **Never touch your real home.** Tests set `AFFICE_HOME`, `HOME` and `CLAUDE_CONFIG_DIR` to temporary folders, and so should any test you add.
- **Ports.** Tests that start a server use spare ports in the 5340s (see the top of each test file). Do not use 4747, 5190 or 4174 in a test.
- **Needs a build.** The launcher and Trella service tests run against the built files and are skipped while `dist/` is missing, so run `npm run build` first to run them all. CI does.
- **git.** The branch view tests create throwaway repositories, so `git` must be installed. `TMPDIR=<dir> npm test` moves them.

A change that is hard to test should say how you checked it in the pull request. A change to a screen should say how it looks at a phone width and in the 3D office.

## Code style

- **Plain TypeScript and the DOM.** No UI framework on the page and none on the server. Elements are made with the helper `h()` in `client/ui/dom.ts`.
- **Text from a server, a manager, a file or a user goes in only as `textContent`** (or a text node), never as `innerHTML`. This keeps a hostile report or chat message from running in the page.
- **No new dependencies** without opening an issue first. The runtime has one (`ws`); everything else is a dev dependency that gets bundled.
- **Strict TypeScript.** `npm run typecheck` must pass. Export types from `shared/` when both sides use them.
- **No em dashes or en dashes anywhere**: not in code, comments, UI text, docs or commit messages. Use a comma, a colon, a period or parentheses. Draw a separator in CSS rather than typing one.
- **English UI copy,** short and plain, in the voice of the existing screens. A server error message is a sentence a person can act on.
- **Comments say why,** not what. Keep the ones at the top of a file that say what it owns.
- **Local only.** Anything that listens, serves a file or reads a path must keep the checks in `server/app.ts` and the rules in [SECURITY.md](SECURITY.md).

## Cards, branches and commits (suggestions)

These are how the project has been built so far, and they are suggestions, not requirements for outside contributors.

- One change per branch and pull request, named for what it does. The maintainers use `task/short-slug`, for example `task/search-box`.
- A commit message is one imperative line that says what changed and why it matters. If the work belongs to a card, end the message with a `Card: <KEY>` line.
- Keep the working tree clean of generated files: `dist/`, `node_modules/` and `.agentboard/` are ignored.

## Pull requests

Before you open one: `npm run typecheck` and `npm test` pass, the build is green, and the pull request template is filled in. Describe what changed, why, and what you ran to check it. Small, focused pull requests get reviewed fastest.

## Reporting a bug or asking for a feature

Use the issue templates. For a bug, include the output of `npx affice doctor --json`: it lists your Node.js and Claude Code versions and what Affice found, and it contains no credentials.
