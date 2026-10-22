// The commands of bin/affice.js that need the server's code: `affice doctor` and `affice init`. Bundled to
// dist/cli.js; the launcher imports it only for those commands. Each returns the exit code.

import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { doctorReport, formatDoctor } from './doctor';
import { ensureOffice, officeLayout } from './project/index';
import { writeProtocol } from './protocol/index';
import { ensureTrellaWorkspace } from './trella-service';

/** `affice doctor [--json]`: prints every check; exit 1 when one fails. */
export async function runDoctor(options: { json?: boolean; port?: number } = {}): Promise<number> {
  const report = await doctorReport({ port: options.port });
  console.log(options.json ? JSON.stringify(report, null, 2) : formatDoctor(report));
  return report.ok ? 0 : 1;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** `affice init <path>`: creates the project's Office folder as opening the project does, and says what it did. */
export async function runInit(path: string | undefined): Promise<number> {
  if (!path) {
    console.error('Usage: affice init <path to your project folder>');
    return 2;
  }
  const project = resolve(path);
  if (!isDirectory(project)) {
    console.error(`${project} is not a folder. Create it, or give the path of an existing project.`);
    return 1;
  }
  const layout = officeLayout(project);
  const parts: Array<[string, string]> = [
    ['Office folder', layout.officeDir],
    ['affice.json', layout.configFile],
    ['chat/', layout.chatDir],
    ['reports/', layout.reportsDir],
    ['.gitignore', join(layout.officeDir, '.gitignore')],
    ['PROTOCOL.md', layout.protocolFile],
    ['.agentboard/', join(layout.trellaWorkspace, '.agentboard')],
  ];
  const before = new Set(parts.filter(([, file]) => existsSync(file)).map(([, file]) => file));
  try {
    ensureOffice(project);
    writeProtocol(layout);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const trellaProblem = await ensureTrellaWorkspace(layout);

  console.log(`Affice office for ${layout.name}`);
  for (const [label, file] of parts) {
    const now = existsSync(file);
    const state = now ? (before.has(file) ? 'already there' : 'created') : label === '.agentboard/' && trellaProblem ? 'not created' : 'not needed';
    console.log(`  ${label.padEnd(14)} ${state.padEnd(14)} ${file}`);
  }
  if (trellaProblem) console.log(`\nTrella's workspace was not created: ${trellaProblem}\nAffice creates it when the project opens.`);
  console.log(`\nNext: affice --project ${project}`);
  return 0;
}
