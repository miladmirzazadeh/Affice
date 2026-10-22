// Prints what the data readers return for a department, without the server and the browser.
//
//   npx tsx server/data/probe.ts [department-id] [--json]
//
// The department comes from fixtures/office.json. The office root is <AFFICE_PROJECT>/Office, the project is
// <AFFICE_PROJECT>, or both are the current folder. Read-only, like the readers.

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BranchState, OfficeConfig } from '../../shared/types';
import { officeLayout } from '../project/index';
import { readBranches } from './git';
import { readReports } from './reports';
import { readDecisions } from './trella';

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await readFile(resolve(here, '../../fixtures/office.json'), 'utf8')) as OfficeConfig;
const args = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const id = args[0] ?? 'engineering';
const department = config.departments.find((candidate) => candidate.id === id);
if (!department) {
  console.error(`No department "${id}" in fixtures/office.json.`);
  process.exit(1);
}
const layout = process.env.AFFICE_PROJECT ? officeLayout(resolve(process.env.AFFICE_PROJECT)) : null;
const root = layout ? layout.trellaWorkspace : process.cwd();
const project = layout ? layout.project : process.cwd();

const started = Date.now();
const branches = await readBranches(department.repos, project, { refresh: true });
const branchesMs = Date.now() - started;
const reports = await readReports(department.reportDirs, root);
const decisions = await readDecisions(root, config.trellaUrl, department);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ branches, reports, decisions }, null, 2));
  process.exit(0);
}

console.log(`Department ${department.name}, root ${root}`);
console.log(`\nBranches (${branchesMs} ms, stale after ${branches.staleDays} days)`);
const total: Record<BranchState, number> = { base: 0, 'in-flight': 0, leftover: 0, stale: 0 };
for (const repo of branches.repos) {
  if (!repo.ok) {
    console.log(`  ${repo.name.padEnd(13)} NOT OK: ${repo.error}`);
    continue;
  }
  const by: Record<BranchState, number> = { base: 0, 'in-flight': 0, leftover: 0, stale: 0 };
  for (const branch of repo.branches) {
    by[branch.state] += 1;
    total[branch.state] += 1;
  }
  const trees = repo.branches.filter((branch) => branch.worktree).length;
  const dirty = repo.branches.filter((branch) => (branch.dirty ?? 0) > 0).length;
  console.log(
    `  ${repo.name.padEnd(13)} base ${repo.base.padEnd(7)} ${String(repo.branches.length).padStart(2)} branches: ` +
      `${by.base} base, ${by['in-flight']} in flight, ${by.stale} stale, ${by.leftover} leftover; ${trees} worktrees, ${dirty} dirty`,
  );
  for (const branch of repo.branches.filter((entry) => entry.state === 'in-flight' || entry.state === 'stale')) {
    console.log(
      `      ${branch.state.padEnd(9)} ${branch.name}  +${branch.ahead}/-${branch.behind}` +
        `${branch.cardKey ? `  ${branch.cardKey}` : ''}${branch.worktree ? `  worktree dirty=${branch.dirty}` : ''}`,
    );
  }
}
console.log(
  `  total: ${branches.repos.length} repos (${branches.repos.filter((repo) => repo.ok).length} ok), ${total.base} base, ` +
    `${total['in-flight']} in flight, ${total.stale} stale, ${total.leftover} leftover`,
);

console.log(`\nReports: ${reports.reports.length} in ${department.reportDirs.join(', ')}`);
for (const report of reports.reports.slice(0, 5)) {
  console.log(`  ${report.date ?? '          '}  ${(report.cardKey ?? '').padEnd(7)} ${report.title}  (${report.file})`);
}
console.log(`  undated: ${reports.reports.filter((report) => !report.date).length}, with a card key: ${reports.reports.filter((report) => report.cardKey).length}`);

console.log(`\nDecisions: ${decisions.cards.length}`);
for (const card of decisions.cards) {
  console.log(`  ${card.key.padEnd(7)} ${card.status.padEnd(12)} [${card.labels.join(', ')}] ${card.title}`);
}
