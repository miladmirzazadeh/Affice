// `affice doctor`: the checks that tell a person, or their agent, whether Affice can run here. Each check is
// a DoctorCheck (shared/server-api.ts) with a stable id and, when it fails, a `fix` to act on. The Claude
// Code checks come from server/doctor-claude.ts; this file adds Node, Trella's built files, the
// port and the home folder.

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import type { DoctorCheck } from '../shared/server-api';
import { checkClaude } from './doctor-claude';
import { afficeHome } from './project/index';
import { afficeAnswers } from './running';
import { afficeVersion, packageRoot, serverPort } from './runtime';
import { trellaProblem } from './trella-cli';
import { trellaCli } from './trella-service';

/** The oldest Node that runs Trella (node:sqlite) and the bundle. */
export const MIN_NODE = '22.5.0';

function atLeast(version: string, minimum: string): boolean {
  const a = version.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const b = minimum.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

export function nodeCheck(version: string = process.versions.node): DoctorCheck {
  const ok = atLeast(version, MIN_NODE);
  return {
    id: 'node',
    ok,
    title: 'Node.js is new enough',
    detail: `Node ${version} (${MIN_NODE} or newer is needed)`,
    fix: ok ? null : `Install Node.js 22.5 or newer (https://nodejs.org), then run affice again. Found ${version}.`,
  };
}

/** Where Trella's built web UI is, for a given Trella CLI path: next to the bundled CLI, or in the vendored apps/web. */
export function trellaWebRoot(cli: string): string | null {
  const candidates = [join(dirname(cli), '..', 'web'), resolve(dirname(cli), '../../../apps/web/dist')];
  return candidates.find((candidate) => existsSync(join(candidate, 'index.html'))) ?? null;
}

export function trellaCheck(cli: string = trellaCli(), clone: boolean = existsSync(join(packageRoot(), 'server', 'index.ts'))): DoctorCheck {
  // npx first: a clone is the exception, and the one place where building is the fix.
  const fix = clone ? `This is a clone of the repository: run npm run build in ${packageRoot()}.` : 'Run npx --yes affice@latest to fetch a fresh copy.';
  const problem = trellaProblem(cli);
  if (problem) return { id: 'trella.built', ok: false, title: "Trella's built files are present", detail: problem, fix };
  if (!trellaWebRoot(cli)) {
    return { id: 'trella.built', ok: false, title: "Trella's built files are present", detail: `Trella's web UI is not built next to ${cli}.`, fix };
  }
  return { id: 'trella.built', ok: true, title: "Trella's built files are present", detail: cli, fix: null };
}

function canListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

export async function portCheck(port: number): Promise<DoctorCheck> {
  const free = await canListen(port);
  // Affice itself on the port is not a problem: starting Affice again just opens that one.
  if (!free && (await afficeAnswers(port))) {
    return { id: 'port.free', ok: true, title: 'The port is free or Affice is on it', detail: `Affice is already running here: http://localhost:${port}`, fix: null };
  }
  return {
    id: 'port.free',
    ok: free,
    title: 'The port is free',
    detail: free ? `127.0.0.1:${port} is free` : `Something already listens on 127.0.0.1:${port}.`,
    fix: free ? null : `Stop what uses port ${port} (it may be Affice already: open http://localhost:${port}), or start Affice on another port: affice --port <number>.`,
  };
}

export function homeCheck(home: string = afficeHome()): DoctorCheck {
  const probe = join(home, `.doctor-${process.pid}`);
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(probe, 'ok', { mode: 0o600 });
    rmSync(probe, { force: true });
    return { id: 'home.writable', ok: true, title: 'The home folder is writable', detail: home, fix: null };
  } catch (error) {
    return {
      id: 'home.writable',
      ok: false,
      title: 'The home folder is writable',
      detail: `${home} cannot be written: ${error instanceof Error ? error.message : String(error)}`,
      fix: `Make ${home} writable, or set AFFICE_HOME to a folder you can write to.`,
    };
  }
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

/** Runs every check. A check that throws becomes a failed check rather than hiding the others. */
export async function doctorReport(options: { port?: number } = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [nodeCheck()];
  try {
    checks.push(...(await checkClaude()));
  } catch (error) {
    checks.push({
      id: 'claude.installed',
      ok: false,
      title: 'Claude Code is installed',
      detail: `Claude Code could not be checked: ${error instanceof Error ? error.message : String(error)}`,
      fix: 'Install Claude Code: https://code.claude.com/docs/en/setup',
    });
  }
  checks.push(trellaCheck(), await portCheck(options.port ?? serverPort()), homeCheck());
  return { ok: checks.every(passes), checks };
}

/** A check passes when it is ok, or when it only fails as a warning. */
export function passes(check: DoctorCheck): boolean {
  return check.ok || check.level === 'warn';
}

/** The report for a terminal. A failing check of level `warn` is printed as a warning and does not fail the report. */
export function formatDoctor(report: DoctorReport): string {
  const lines = [`Affice ${afficeVersion()} doctor`, ''];
  for (const check of report.checks) {
    lines.push(`${check.ok ? 'ok  ' : check.level === 'warn' ? 'warn' : 'FAIL'}  ${check.title}`);
    lines.push(`      ${check.detail}`);
    if (!check.ok && check.fix) lines.push(`      fix: ${check.fix}`);
  }
  const warnings = report.checks.filter((check) => !check.ok && check.level === 'warn').length;
  const warned = warnings === 0 ? '' : ` ${warnings === 1 ? 'One warning is' : `${warnings} warnings are`} listed above; Affice still runs.`;
  lines.push('', report.ok ? `Everything Affice needs is in place.${warned}` : 'Something needs attention: see the fix lines above.');
  return lines.join('\n');
}
