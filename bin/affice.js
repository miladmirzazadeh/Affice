#!/usr/bin/env node
// The launcher of Affice: plain JavaScript, no dependencies, so it also runs (and explains itself) on a
// Node that is too old. The work is in dist/ (built from server/ by npm run build):
//   dist/server.js  the office server (starts on import, reads its settings from the environment)
//   dist/cli.js     the doctor and init commands
//
//   affice [start] [--port <n>] [--no-open] [--project <path>]
//   affice doctor [--json] [--port <n>]
//   affice init <path>
//   affice --version | --help

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = (name) => new URL(`../dist/${name}`, import.meta.url);

const HELP = `affice: a local 3D office for your Claude Code agents

Usage
  affice [start] [options]    Start Affice and open it in your browser (the default)
  affice doctor [--json]      Check Node, Claude Code, Trella, the port and the home folder
  affice init <path>          Create the Office folder of a project without starting Affice
  affice --version            Print the version
  affice --help               Print this help

Options
  --port <n>        Port of the office (default 4747, or AFFICE_PORT). Affice listens on 127.0.0.1 only.
  --no-open         Do not open the browser
  --project <path>  Open this project when Affice starts (otherwise the browser asks for one)
  --json            With doctor: print { "ok": boolean, "checks": [...] } and exit 1 when a check fails

Environment
  AFFICE_PORT, AFFICE_PROJECT, AFFICE_HOME (default ~/.affice, the recent projects), CLAUDE_BIN,
  AFFICE_TRELLA_PORT (where Trella's service starts looking for a free port)
`;

function version() {
  try {
    return JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

function fail(message, code = 2) {
  console.error(`affice: ${message}\nTry: affice --help`);
  process.exit(code);
}

// Parses the arguments after the command. `value` options take the next argument or --name=value.
function parse(args, { flags = [], values = [] }) {
  const out = { flags: {}, values: {}, rest: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      out.rest.push(arg);
      continue;
    }
    const equals = arg.indexOf('=');
    const name = equals === -1 ? arg.slice(2) : arg.slice(2, equals);
    if (flags.includes(name) && equals === -1) {
      out.flags[name] = true;
    } else if (values.includes(name)) {
      const value = equals === -1 ? args[(i += 1)] : arg.slice(equals + 1);
      if (value === undefined || value === '' || value.startsWith('--')) fail(`--${name} needs a value`);
      out.values[name] = value;
    } else {
      fail(`unknown option ${arg}`);
    }
  }
  return out;
}

function portOf(value) {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) fail(`${value} is not a port (1 to 65535)`);
  return String(port);
}

function nodeTooOld() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return major < 22 || (major === 22 && minor < 5);
}

function needBuild() {
  if (existsSync(dist('server.js'))) return;
  console.error(`affice: Affice is not built in ${root}. Run npx --yes affice@latest to fetch a fresh copy. In a clone of the repository, run npm run build there.`);
  process.exit(1);
}

const [first = 'start', ...tail] = process.argv.slice(2);
const command = first.startsWith('-') && first !== '--version' && first !== '-v' && first !== '--help' && first !== '-h' ? 'start' : first;
const args = command === 'start' && first.startsWith('-') ? [first, ...tail] : tail;

switch (command) {
  case '--version':
  case '-v':
  case 'version':
    console.log(version());
    break;

  case '--help':
  case '-h':
  case 'help':
    process.stdout.write(HELP);
    break;

  case 'doctor': {
    const { flags, values, rest } = parse(args, { flags: ['json'], values: ['port'] });
    if (rest.length > 0) fail(`doctor takes no argument (got ${rest[0]})`);
    const port = portOf(values.port);
    if (port) process.env.AFFICE_PORT = port;
    if (nodeTooOld()) {
      // The compiled doctor needs a current Node; this check needs nothing.
      const check = {
        id: 'node',
        ok: false,
        title: 'Node.js is new enough',
        detail: `Node ${process.versions.node} (22.5.0 or newer is needed)`,
        fix: `Install Node.js 22.5 or newer (https://nodejs.org), then run affice again. Found ${process.versions.node}.`,
      };
      console.log(
        flags.json
          ? JSON.stringify({ ok: false, checks: [check] }, null, 2)
          : `Affice ${version()} doctor\n\nFAIL  ${check.title}\n      ${check.detail}\n      fix: ${check.fix}\n`,
      );
      process.exit(1);
    }
    if (!existsSync(dist('cli.js'))) needBuild();
    const { runDoctor } = await import(dist('cli.js'));
    process.exitCode = await runDoctor({ json: Boolean(flags.json) });
    break;
  }

  case 'init': {
    const { rest } = parse(args, {});
    if (rest.length !== 1) fail('init takes one argument: the path of your project folder');
    if (nodeTooOld()) fail(`Node.js 22.5 or newer is needed (found ${process.versions.node}). Install it from https://nodejs.org`, 1);
    if (!existsSync(dist('cli.js'))) needBuild();
    const { runInit } = await import(dist('cli.js'));
    process.exitCode = await runInit(rest[0]);
    break;
  }

  case 'start': {
    const { flags, values, rest } = parse(args, { flags: ['no-open'], values: ['port', 'project'] });
    if (rest.length > 0) fail(`unknown argument ${rest[0]}`);
    if (nodeTooOld()) fail(`Node.js 22.5 or newer is needed (found ${process.versions.node}). Install it from https://nodejs.org, or run: affice doctor`, 1);
    needBuild();
    const port = portOf(values.port);
    if (port) process.env.AFFICE_PORT = port;
    if (values.project) process.env.AFFICE_PROJECT = resolve(values.project);
    if (!flags['no-open']) process.env.AFFICE_OPEN_BROWSER = '1';
    await import(dist('server.js'));
    break;
  }

  default:
    fail(`unknown command ${first}`);
}
