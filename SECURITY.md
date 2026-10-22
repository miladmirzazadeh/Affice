# Security policy

## Reporting a vulnerability

Please report a security problem privately, not in a public issue or a pull request.

1. Open https://github.com/thePlane-ai/Affice/security/advisories/new (the **Security** tab of the repository, then **Report a vulnerability**).
2. If that is not available to you, contact the repository owner, [@miladmirzazadeh](https://github.com/miladmirzazadeh), through GitHub, and say only that you have a security report. Share the details once the owner has replied with a private way to do it.

Include what you found, the version (`npx affice --version`), how to reproduce it, and what an attacker could do with it. Affice is a small volunteer project: reports are handled on a best effort basis, and a fix is released as soon as it is ready. Please give us time to fix a problem before you make it public. Credit is given to whoever wants it.

Only the latest release is supported.

## What Affice is, and who it trusts

Affice runs on your own computer, for one person. It starts your own Claude Code (`claude -p`) once per manager and shows what the managers do in your browser. It trusts you, and it trusts the project you open: a project can carry hooks, MCP servers and an `Office/affice.json`, and Affice treats that last file as data that may be hostile (see "Files Affice reads and writes"). It is not built to be exposed to a network or shared between users.

The sections below say what Affice does to keep a web page, another program or a manager from doing more than you allowed, and then, plainly, what it does not defend against in this beta (see [Known limitations in this beta](#known-limitations-in-this-beta)).

## How Affice defends itself

### Who may call the server

The server binds `127.0.0.1` only. Three checks apply to every request and to the WebSocket upgrade (`server/security.ts`, `server/app.ts`):

- **Host.** The `Host` header must be exactly `localhost:<port>` or `127.0.0.1:<port>`, this server's own port. Anything else (another port, no port, a look-alike name, an IPv6 address) gets a 403. This defeats DNS rebinding.
- **Origin.** A browser `Origin` must be exactly this server's origin: the same scheme (`http`), host (`localhost` or `127.0.0.1`) and port. A page on another port of `localhost` is refused. The one exception is the development page: `AFFICE_DEV_ORIGIN` names one extra origin (`npm run server` and `start.sh` set it to `http://localhost:5190`), and only if it is exactly `http://localhost:<port>` or `http://127.0.0.1:<port>`.
- **Fetch metadata.** Where a browser sends `Sec-Fetch-Site`, `cross-site` and `same-site` are refused (another port of `localhost` counts as same-site). `same-origin` and `none` pass.

A request with no `Origin` is not a browser page (the managers' MCP server, a script); it passes these checks and then needs a token.

### Tokens

Two secrets are made when the process starts. They keep web pages and other localhost ports out; they do not keep local processes out (see the known limitations). They are random, compared in constant time, kept in memory only, and never written to a file, a log or an API answer (except as said here). The WebSocket accepts only the path `/ws`, frames of at most 1 MB, and only a client that offers the page token.

- **The page token** (32 random bytes as hex) belongs to the page. The server puts it into `index.html` as `<meta name="affice-token">` (never cached, left out when the browser says the request is `cross-site` or `same-site`), and `GET /api/session` returns it to a same-origin request. The page sends it as the `x-affice-token` header on every `/api` request and as a WebSocket subprotocol (`affice`, `affice.<token>`; the server answers with `affice`, so the token is not sent back). It is never in a URL, a cookie, a log, an environment variable or a command line of a child process. Every page route and every socket command needs it: opening and closing projects, chat, creating departments, answering approval cards, and switching bypass.
- **An agent token** exists for each department (an HMAC of the department id under a secret of this process). Each manager's office MCP server gets its own, together with the name of its department, and sends them on its requests. It opens only the agent routes: the approval request, wait and cancel, `list_departments`, `office_status` and `ask_manager`. It cannot answer an approval, switch bypass, chat, open a project, create a department or read any page route. The office takes the caller from the token: a `from` or `department` in a request body is ignored, a manager cannot speak for another, and it can only wait for or cancel its own cards.
- **A report ticket** is for the one thing a header cannot do, a link that opens a report in a new tab. The page asks for a ticket with its token; the ticket opens that one file of that one department on the report route for one minute.

### Headers of every answer

Every response (the page, assets, API answers, errors and refusals) carries `Content-Security-Policy` (`default-src 'self'`, scripts and styles from the server itself with no inline script or style and no `eval`, the socket on the same origin, `frame-src` for the Trella board on a local port, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`, `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and `Cross-Origin-Opener-Policy: same-origin`. The page cannot be framed, and the token is never sent to another site in a referrer.

`connect-src` and `frame-src` allow any local `http` port, because Trella's board runs on a port chosen at start.

### The report viewer

Reports are `.md` and `.html` files that agents write, so they are treated as hostile text. The report route serves a file only when its real path (symbolic links resolved) lies inside one of the department's report folders, it serves nothing but `.md` and `.html`, and it refuses files over 5 MB. The listing applies the same test, so a link that leaves the folder is not listed and its target is never read for a title. An HTML report goes out with `Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:`: an opaque origin, no scripts, no forms, no popups, no frames, no network of any kind. It cannot reach the office API or the socket. Page text from the server always goes in through `textContent`, never `innerHTML`.

Report folders of `/` or of your home folder are refused (in the form and when `affice.json` is loaded).

### Files Affice reads and writes

- **Nothing that Affice writes goes through a symbolic link.** (Trella's own files are another matter: see the known limitations.) A project can arrive from a git clone or a zip, and git stores links. Everything Affice writes inside a project goes through one small module (`server/project/safe-fs.ts`): `Office/`, `Office/chat` and `Office/reports` must be real folders whose real path lies directly inside their parent, files are created with `O_EXCL`, replaced atomically through a temporary file with a random name (a rename never follows a link), and chat lines are appended with `O_NOFOLLOW` on a regular file. A link in any of these places is refused with a sentence that names the path. A symlinked project folder or parent (`/tmp` on macOS) is fine: only what is inside the project is checked.
- **A hostile `Office/affice.json` is repaired on load.** The file is committed with a project, so it is validated like input from outside: unknown fields are dropped, a department with an invalid id is skipped, and an invalid model, color, permission, working folder, session id, board id, repo entry or Trella address is replaced by a safe default (permission `ask`, model `sonnet`, no session id, Trella on `localhost`). A session id or model that starts with a hyphen never reaches a command line. Report folders, knowledge folders and repository paths of `/` or of your home folder are dropped. Whenever something was lost the original is kept as `affice.json.corrupt-<time>`, the repaired file is saved once, and the page shows what was repaired. A clean file is never rewritten.
- **Private files.** `Office/affice.json`, the chat history, `~/.affice/projects.json` and the `~/.affice` folder Affice creates are made readable by you only (modes 0600 and 0700), so another account on the same computer cannot read your conversations. The `Office/` folder itself and `reports/` are not made private, because you may share them.
- **Read only views.** The folder browser lists folder names only, never a file or its contents. `~/.claude.json` is read for project paths only and never written.

### Helper programs

- **git** (the Branches view) never fetches and never writes. Every call runs with `--no-optional-locks --no-pager`, `core.fsmonitor=false`, `core.hooksPath=/dev/null`, `core.sshCommand=false` and `protocol.ext.allow=never` on the command line, the clean, smudge and process filters a repository names are blanked, submodules are not entered, and the environment is the minimal one (below). A repository's own config is data from outside, because git runs programs named in it.
- **Trella** is always started with `--host 127.0.0.1`, whatever `.agentboard/config.json` says, and Affice checks where it really listens: a service that answers on another address of the machine is stopped, or not used when Affice did not start it. Before the start, an `.agentboard` that is a symbolic link, and a data, inbox or outbox folder in `config.json` that points outside the Office folder, are refused.
- **Minimal environment.** Trella, the Trella CLI, git, `npm prefix -g` and the browser opener run with an allow list of variables (`PATH`, `HOME`, the locale, the temporary folder, a few desktop variables): no `ANTHROPIC_*`, `AWS_*`, `GITHUB_*`, `NPM_TOKEN`, `SSH_AUTH_SOCK`, `NODE_OPTIONS`, `GIT_*` or anything ending in `_TOKEN`, `_KEY` or `_SECRET`. The `claude` commands (the version and sign-in checks, and the managers) cannot use it, because Claude Code needs your login and settings; they get your environment without `CLAUDE_*` (except `CLAUDE_CONFIG_DIR`), `ANTHROPIC_*` and `MCP_*`. Other variables, such as `GITHUB_TOKEN` or `AWS_*`, reach the managers, because a shell command you allow may need them.
- **No shell.** Affice starts every program with an argument list. A project path, a department name or a field of `affice.json` is never put through a shell. The `--model` and `--resume` values are separate arguments, and a value that starts with a hyphen is not passed.

### Credentials and the network

Affice never reads, stores or asks for your credentials. It runs your own, unmodified `claude`, and only asks it whether it is signed in and by which method (no email, organization or plan is read, kept or shown). It has no telemetry and makes no requests except to your own machine. What your managers send to Anthropic is what Claude Code sends, under your settings.

### What a manager may do

Each department has a permission policy. In `ask` and `accept-edits` Claude Code asks the office, through an MCP server, before anything that needs permission, and the page shows a card with the tool, the folder, the file and the whole command or edit (everything after the first line is shown, long text scrolls, an over 8,192 character part is cut and the card says how much, control and bidirectional characters are written out). You allow or deny it.

- **Runs without asking:** reads inside the project folder (the Office folder included) and inside the department's knowledge folders, subagents (`Agent`, `Task`), the todo list, Trella's board tools (`mcp__trella__*`), and the three office tools (`list_departments`, `office_status`, `ask_manager`).
- **Always asks (a card in `ask` and `accept-edits`):** writes and edits (except in `accept-edits`, where edits pass), shell commands, web access (`WebFetch` and `WebSearch`, which are in no allowed list and carry `ask` rules, so that the documentation sites Claude Code may fetch on its own ask too), reading anything outside the project and the knowledge folders, and a question to a manager that accepts edits.
- **`read-only`** has no way to ask, so everything outside the first list is refused: no web, no reads outside the project, no writes, no commands, and no todo list.
- **`ask_manager`:** a manager can ask another only if the target is not in bypass, is not itself waiting for an answer (which rules out every cycle), and the chain is at most two deep. A question to a manager that accepts edits waits for your card first, with the whole message on it (such a message is at most 8,192 characters, so none is approved half seen). The target's chat labels every question with who asked.
- **Bypass** is per session and off at every start. The page asks you to confirm it the first time in a session, it restarts the session with the same conversation and every permission check skipped, it is never saved, and a stop, a crash or a restart turns it off. See the known limitations below on what enforces that confirmation.

The point of the read rules is that a manager which reads a hostile file, web page or board card cannot quietly send some other file out: sending needs the web or a command, and both ask. Claude Code's own rules and your own Claude Code settings still apply underneath: an allow rule you wrote there lets a manager do that without a card.

## Known limitations in this beta

These are known, they are not fixed in this beta, and you should read them before you open a project. In plain words:

1. **A local process can read the page token and drive your office.** The page token is in the page, and a plain `GET /` on `127.0.0.1` from a program that sends no browser headers (`curl`, another user's process, a manager you allowed one shell command) gets the page with its token, because the server cannot tell that program from your browser. With it that program can use the socket the way the page does: open projects, chat, answer approval cards and switch bypass on. The confirmation for bypass is asked by the page only; the server does not demand it. The token protects you against web pages and other localhost ports. It does not protect you against local processes. Treat anything that can reach `127.0.0.1` on this port as able to drive your office.
2. **The agent tokens are in the `claude` command line.** The managers' MCP configuration is part of the `claude` arguments, so another local user who can list processes (`ps`) can read every department's agent token and act as that department on the agent routes: forge an approval card in its name, or ask other managers as it. That token cannot answer a card or change bypass. The page token is never on a command line.
3. **A project's `Office/.agentboard/service.json` can redirect the managers' board traffic.** Affice reuses a `service.json` it did not write when the port in it answers, and Trella's client sends its requests to the `url` written in that file. A hostile project that commits such a file can send the managers' Trella requests, and the text of the cards they write, to another address, and what that address answers is text the managers read. Trella's tools run without a card.
4. **Trella follows symbolic links inside `.agentboard`.** Affice refuses links in `Office`, `chat`, `reports`, `affice.json` and in `.agentboard` itself, but not the files inside `.agentboard`, which Trella writes: a project can make Trella write its service or board files somewhere else you can write. A hard link (which a tar or zip file can carry, and git cannot) in `Office/chat` is written to as the regular file it is.
5. **A git filter name that contains `=` can still run its command.** The Branches view blanks the clean, smudge and process filters a repository names, but it cannot blank a name with an equals sign in it, so a repository whose `.git/config` and attributes are hostile can run that command when `git status` runs. It needs control of the repository's config (a downloaded archive, a shared folder, a manager that can edit it).
6. **Some things in a project's files are read as they are.** `Office/PROTOCOL.md` is read through a symbolic link, and its text goes into every manager's prompt, so a link there can put the text of any file you can read into it. The knowledge folders, the working folder (`cwd`) and the report folders written into `Office/affice.json` are not restricted to the project: only `/` and your home folder are refused. A department that lists a folder reads it without a card, and a report folder is served to the page. Look at the folders of a department you did not create.
7. **Some behavior is Claude Code's, and has not been verified here.** Which shell commands Claude Code counts as read only, how it matches a `Read(...)` rule against a symbolic link or a path with parentheses, whether your own `permissions.allow` overrides Affice's `ask` rules for the web tools, and whether Claude Code writes the managers' MCP settings into its own files, were not tested against every version of Claude Code. Affice's own command lines were checked, what Claude Code does with them was not, in every case.

Smaller limits:

- A link inside an HTML report works when you click it. The sandbox stops scripts, images, styles, frames, forms and automatic navigation, but data in a link's address can leave on one click.
- The page token is in the page, so a browser extension that can read pages on `localhost` can read it. No design stops that.

### What follows from this

**Open only projects you trust, and treat a repository from a stranger like code you are about to run.** The managers run `claude -p`, Claude Code's non-interactive mode. It does not show the folder trust dialog, so the hooks in a project's Claude Code settings and the servers in its `.mcp.json` run as soon as a manager starts, and a project's `Office/affice.json`, `Office/.agentboard` and `Office/PROTOCOL.md` are read as in the list above. Open a project from someone else in Claude Code yourself first, read its hooks, its `.mcp.json` and its `Office` folder, and only then open it in Affice. Do not run Affice on a computer where other people have accounts and you do not want them to be able to act as you in it.

## What is in scope

Problems in Affice's own code and package, for example:

- A way for a web page, another origin or another port to use the server: a bypass of the `Host`, `Origin` or `Sec-Fetch-Site` checks, of the token checks, or of the local-only binding.
- A way to get the page token from a web page, or to use an agent token for anything but the agent routes.
- A way to run a manager's tool without the approval its policy requires, to turn on bypass without the user's confirmation from a web page, or to get around the `ask_manager` rules (depth, cycles, bypass, the accept-edits card).
- A write that follows a symbolic link, a path traversal or a link escape in the report viewer, the static file server or the folder browser.
- Script injection into the page from text that comes from a manager, a file, a department field or a chat message.
- A way for HTML in a report to reach the office API or the socket, or to load anything.
- Command or argument injection through a project path, a department name, a field of `affice.json` or a repository's config.
- Credentials, tokens or account details reaching the page, the logs, a file or a child process that should not have them.
- Something in the published npm package that should not be there, or a dependency problem that Affice can actually be exploited through.

## What is out of scope

- Vulnerabilities in Claude Code itself: report them to Anthropic.
- Vulnerabilities in Trella itself: `vendor/trella` is an unmodified copy, so report them to Trella's repository. If they can be exploited through Affice in a way that Trella alone does not allow, report that here too.
- The documented behavior of Claude Code's non-interactive mode: it skips the folder trust dialog, so a project's hooks and `.mcp.json` servers run when a manager starts (see the advice above).
- What a manager does after you allow a tool, or while bypass is on. That is what those settings are for.
- Anything the known limitations above describe: they are listed so you know them, and a report of the same thing is not a new finding. A way past a part of Affice that is not listed there is in scope.
- Exposing Affice to a network yourself, for example through a reverse proxy, a tunnel or a changed bind address. Affice is not built for that.
- Missing hardening that has no way to be exploited, and reports from automated scanners without a working proof.
