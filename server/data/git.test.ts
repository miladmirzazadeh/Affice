// git.ts on a throwaway repository: a merged branch, a patch-equivalent one, one merged only into
// another trunk, an in-flight branch with a dirty worktree, a stale one, and the repos that cannot be read.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { BranchInfo, BranchesView, RepoRef } from '../../shared/types';
import { clearGitCaches, GIT_HARDENING, gitEnv, readBranches } from './git';

const NOW = new Date('2026-10-17T12:00:00Z');

function git(cwd: string, args: string[], date?: string): string {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[name];
  if (date) {
    env.GIT_AUTHOR_DATE = date;
    env.GIT_COMMITTER_DATE = date;
  }
  return execFileSync('git', ['-c', 'user.name=Test Author', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function commit(cwd: string, file: string, message: string, date: string): void {
  writeFileSync(join(cwd, file), `${message}\n`);
  git(cwd, ['add', file]);
  git(cwd, ['commit', '-m', message], date);
}

describe('branches of a repo', () => {
  let dir = '';
  let repo = '';
  let demoTree = '';
  let view: BranchesView;
  let repos: RepoRef[];
  const branch = (name: string): BranchInfo => {
    const found = view.repos[0]!.branches.find((candidate) => candidate.name === name);
    assert.ok(found, `branch ${name} is listed`);
    return found;
  };

  before(async () => {
    clearGitCaches();
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'office-git-')));
    repo = join(dir, 'repo');
    demoTree = join(dir, 'wt-demo');
    mkdirSync(repo);
    git(repo, ['init', '-b', 'main']);
    commit(repo, 'a.txt', 'first', '2026-09-01T10:00:00Z');
    commit(repo, 'b.txt', 'second', '2026-09-02T10:00:00Z');
    for (const name of ['deploy', 'stale-one', 'picked', 'merged-one', 'only-in-deploy']) git(repo, ['branch', name]);

    git(repo, ['checkout', 'stale-one']);
    commit(repo, 's.txt', 'stale work', '2026-09-20T10:00:00Z');
    git(repo, ['checkout', 'picked']);
    commit(repo, 'p.txt', 'picked work', '2026-10-05T10:00:00Z');
    git(repo, ['checkout', 'merged-one']);
    commit(repo, 'm.txt', 'merged work', '2026-09-03T10:00:00Z');
    git(repo, ['checkout', 'only-in-deploy']);
    commit(repo, 'd.txt', 'deploy work', '2026-10-01T10:00:00Z');

    git(repo, ['checkout', 'main']);
    git(repo, ['merge', '--no-ff', 'merged-one', '-m', 'Merge merged-one'], '2026-09-04T10:00:00Z');
    git(repo, ['cherry-pick', 'picked'], '2026-10-06T10:00:00Z');
    commit(repo, 'c.txt', 'third', '2026-10-10T10:00:00Z');
    git(repo, ['branch', '-f', 'deploy', 'only-in-deploy']);

    git(repo, ['checkout', '-b', 'task/ENG-12-demo']);
    commit(repo, 't1.txt', 'task one', '2026-10-15T10:00:00Z');
    commit(repo, 't2.txt', 'task two', '2026-10-16T10:00:00Z');
    git(repo, ['checkout', 'main']);
    git(repo, ['worktree', 'add', demoTree, 'task/ENG-12-demo']);
    writeFileSync(join(demoTree, 'scratch.txt'), 'not committed');
    git(repo, ['branch', 'task/ENG-13-fresh']); // on the base tip, no worktree
    git(repo, ['worktree', 'add', '-b', 'task/ENG-14-cut', join(dir, 'wt-cut')]); // on the base tip, with a worktree

    mkdirSync(join(dir, 'plain'));
    mkdirSync(join(repo, 'sub'));
    repos = [
      { name: 'repo', path: repo, base: 'main' },
      { name: 'missing', path: join(dir, 'nope'), base: 'main' },
      { name: 'plain', path: join(dir, 'plain'), base: 'main' },
      { name: 'inside', path: join(repo, 'sub'), base: 'main' },
      { name: 'nobase', path: repo, base: 'develop-x' },
    ];
    view = await readBranches(repos, dir, { refresh: true, now: NOW });
  });

  after(() => {
    clearGitCaches();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists every local branch, the base first, with its state', () => {
    const repoView = view.repos[0]!;
    assert.equal(repoView.ok, true);
    assert.equal(repoView.error, null);
    assert.deepEqual(repoView.branches.map((b) => b.name)[0], 'main');
    assert.equal(repoView.branches.length, 9);
    assert.equal(view.staleDays, 7);
    assert.deepEqual(
      Object.fromEntries(repoView.branches.map((b) => [b.name, b.state])),
      {
        main: 'base',
        deploy: 'base',
        'task/ENG-12-demo': 'in-flight',
        'stale-one': 'stale',
        picked: 'leftover',
        'merged-one': 'leftover',
        'only-in-deploy': 'leftover',
        'task/ENG-13-fresh': 'leftover', // nothing of its own and no worktree: nothing is going on there
        'task/ENG-14-cut': 'in-flight', // just cut for a task: no commit yet, but a worktree waits for it
      },
    );
  });

  it('counts ahead and behind the base and reads the last commit', () => {
    const task = branch('task/ENG-12-demo');
    assert.equal(task.ahead, 2);
    assert.equal(task.behind, 0);
    assert.equal(task.subject, 'task two');
    assert.equal(task.author, 'Test Author');
    assert.equal(task.lastCommitAt, '2026-10-16T10:00:00.000Z');
    assert.equal(task.cardKey, 'ENG-12');

    const stale = branch('stale-one');
    assert.equal(stale.ahead, 1);
    assert.ok(stale.behind >= 3);
    assert.equal(stale.cardKey, null);

    const main = branch('main');
    assert.deepEqual([main.ahead, main.behind, main.merged], [0, 0, true]);
    assert.equal(branch('deploy').ahead, 1);
  });

  it('finds merged branches by ancestry, by patch, and by another trunk', () => {
    const ancestor = branch('merged-one');
    assert.equal(ancestor.ahead, 0);
    assert.equal(ancestor.merged, true);

    const patched = branch('picked');
    assert.equal(patched.ahead, 1, 'its commit is not an ancestor of main');
    assert.equal(patched.merged, true, 'but git cherry finds the same patch on main');

    const viaTrunk = branch('only-in-deploy');
    assert.equal(viaTrunk.ahead, 1);
    assert.equal(viaTrunk.merged, true, 'it is inside deploy, a trunk of the repo');

    assert.equal(branch('stale-one').merged, false);
    assert.equal(branch('task/ENG-12-demo').merged, false);
  });

  it('reports the worktree of a branch and how many files changed in it', () => {
    const task = branch('task/ENG-12-demo');
    assert.equal(task.worktree, demoTree);
    assert.equal(task.dirty, 1);
    const main = branch('main');
    assert.equal(main.worktree, repo);
    assert.equal(main.dirty, 0);
    assert.equal(branch('stale-one').worktree, null);
    assert.equal(branch('stale-one').dirty, null);
  });

  it('keeps unreadable repos in the list with a message, and the others render', () => {
    const [good, missing, plain, inside, nobase] = view.repos;
    assert.equal(good!.ok, true);
    assert.equal(missing!.ok, false);
    assert.match(missing!.error ?? '', /does not exist/);
    assert.equal(plain!.ok, false);
    assert.match(plain!.error ?? '', /not a git repository/);
    assert.equal(nobase!.ok, false);
    assert.match(nobase!.error ?? '', /develop-x/);
    assert.deepEqual([missing, plain, nobase].map((repo) => repo!.branches.length), [0, 0, 0]);
  });

  it('reads a folder inside a repository as that repository, found upward, and shows the path it read', () => {
    const inside = view.repos[3]!;
    assert.equal(inside.ok, true, inside.error ?? '');
    assert.equal(inside.error, null);
    assert.equal(inside.path, repo, 'the repository root, not the subfolder');
    assert.deepEqual(inside.branches.map((b) => b.name), view.repos[0]!.branches.map((b) => b.name));
  });

  it('serves the same snapshot for 10 seconds and recomputes on refresh', async () => {
    const cached = await readBranches(repos, dir, { now: NOW });
    assert.equal(cached.repos[0], view.repos[0], 'the cached snapshot is returned as it was');
    const fresh = await readBranches(repos, dir, { refresh: true, now: NOW });
    assert.notEqual(fresh.repos[0], view.repos[0]);
    assert.deepEqual(fresh.repos[0], view.repos[0]);
  });
});

// Relative repository paths start at the project, not at the Office folder -----------------------------------

describe('repository paths relative to the project', () => {
  let project = '';
  let office = '';

  before(() => {
    clearGitCaches();
    project = realpathSync(mkdtempSync(join(tmpdir(), 'office-git-project-')));
    office = join(project, 'Office');
    mkdirSync(office);
    git(project, ['init', '-b', 'main']);
    commit(project, 'README.md', 'first', '2026-09-01T10:00:00Z');
    mkdirSync(join(project, 'services', 'api'), { recursive: true });
    git(join(project, 'services', 'api'), ['init', '-b', 'trunk']);
    commit(join(project, 'services', 'api'), 'api.txt', 'api first', '2026-09-02T10:00:00Z');
  });
  after(() => rmSync(project, { recursive: true, force: true }));

  const first = async (path: string, base: string) =>
    (await readBranches([{ name: 'r', path, base }], project, { refresh: true, now: NOW })).repos[0]!;

  it('takes . for the project itself', async () => {
    const view = await first('.', 'main');
    assert.equal(view.ok, true, view.error ?? '');
    assert.equal(view.path, project);
    assert.equal(view.branches[0]!.name, 'main');
  });

  it('starts other relative paths at the project too, and keeps a repository of its own inside it as it is', async () => {
    const view = await first('services/api', 'trunk');
    assert.equal(view.ok, true, view.error ?? '');
    assert.equal(view.path, join(project, 'services', 'api'));
  });

  it('finds the repository upward from the Office folder or any folder in the project, instead of an error', async () => {
    for (const path of ['Office', join(office, '.'), 'services']) {
      const view = await first(path, 'main');
      assert.equal(view.ok, true, `${path}: ${view.error ?? ''}`);
      assert.equal(view.error, null);
      assert.equal(view.path, project, path);
    }
  });

  it('still says a folder that is not in any repository is not one, and that a missing folder is missing', async () => {
    const lone = realpathSync(mkdtempSync(join(tmpdir(), 'office-git-lone-')));
    try {
      const view = (await readBranches([{ name: 'lone', path: lone, base: 'main' }, { name: 'gone', path: 'nope', base: 'main' }], project, { refresh: true, now: NOW })).repos;
      assert.match(view[0]!.error ?? '', /not a git repository/);
      assert.match(view[1]!.error ?? '', /does not exist/);
    } finally {
      rmSync(lone, { recursive: true, force: true });
    }
  });

  it('does not climb to a repository at the home folder: that is a dotfiles repository, not the department\'s', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'office-git-home-')));
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      git(home, ['init', '-b', 'main']);
      commit(home, '.zshrc', 'dotfiles', '2026-09-01T10:00:00Z');
      mkdirSync(join(home, 'notes'));
      clearGitCaches();
      const view = (await readBranches([{ name: 'notes', path: join(home, 'notes'), base: 'main' }], home, { refresh: true, now: NOW })).repos[0]!;
      assert.equal(view.ok, false);
      assert.match(view.error ?? '', /your home folder/);
      assert.match(view.error ?? '', /Name the repository's own folder/);
    } finally {
      if (saved === undefined) delete process.env.HOME;
      else process.env.HOME = saved;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// SEC-16: the repository's own config does not start programs -------------------------------------------

describe('git runs with the hardened config (SEC-16)', () => {
  let dir = '';
  let repo = '';

  before(() => {
    clearGitCaches();
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'office-git-hardened-')));
    repo = join(dir, 'repo');
    mkdirSync(repo);
    git(repo, ['init', '-b', 'main']);
    commit(repo, 'f.txt', 'one', '2026-09-01T10:00:00Z');
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  /** A program that leaves a marker file when git runs it. */
  function trap(name: string, body = ''): { script: string; marker: string; ran: () => boolean; reset: () => void } {
    const script = join(dir, `${name}.sh`);
    const marker = join(dir, `${name}.marker`);
    writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\n${body}`);
    chmodSync(script, 0o755);
    return { script, marker, ran: () => existsSync(marker), reset: () => rmSync(marker, { force: true }) };
  }

  it('does not run core.fsmonitor from the repository config (the experiment of the review)', async () => {
    const monitor = trap('fsmonitor');
    git(repo, ['config', 'core.fsmonitor', monitor.script]);
    // The precondition: plain git does run it, so the test can fail.
    git(repo, ['status', '--porcelain']);
    assert.ok(monitor.ran(), 'plain git status runs the configured fsmonitor');
    monitor.reset();

    clearGitCaches();
    const view = await readBranches([{ name: 'repo', path: repo, base: 'main' }], dir, { refresh: true, now: NOW });
    assert.equal(view.repos[0]!.ok, true, view.repos[0]!.error ?? '');
    assert.equal(monitor.ran(), false, 'the Branches view did not run it');
    git(repo, ['config', '--unset', 'core.fsmonitor']);
  });

  it('does not run a clean filter that the repository config and its attributes name', async () => {
    const filter = trap('filter', 'cat\n');
    git(repo, ['config', 'filter.evil.clean', filter.script]);
    writeFileSync(join(repo, '.git', 'info', 'attributes'), 'f.txt filter=evil\n');
    // Same size as before, so git has to run the clean filter to know whether the file changed.
    writeFileSync(join(repo, 'f.txt'), 'xxx\n');
    git(repo, ['status', '--porcelain']);
    assert.ok(filter.ran(), 'plain git status runs the configured clean filter');
    filter.reset();

    writeFileSync(join(repo, 'f.txt'), 'yyy\n');
    clearGitCaches();
    const view = await readBranches([{ name: 'repo', path: repo, base: 'main' }], dir, { refresh: true, now: NOW });
    assert.equal(view.repos[0]!.ok, true, view.repos[0]!.error ?? '');
    assert.equal((view.repos[0]!.branches.find((b) => b.name === 'main')?.dirty ?? 0) > 0, true, 'the dirty count still works');
    assert.equal(filter.ran(), false, 'the Branches view did not run it');
  });

  it('does not run an include.path file\'s fsmonitor or a hooks path either', async () => {
    const monitor = trap('included-fsmonitor');
    const included = join(dir, 'included.config');
    writeFileSync(included, `[core]\n\tfsmonitor = ${monitor.script}\n\thooksPath = ${dir}\n`);
    git(repo, ['config', 'include.path', included]);
    clearGitCaches();
    const view = await readBranches([{ name: 'repo', path: repo, base: 'main' }], dir, { refresh: true, now: NOW });
    assert.equal(view.repos[0]!.ok, true, view.repos[0]!.error ?? '');
    assert.equal(monitor.ran(), false);
    git(repo, ['config', '--unset', 'include.path']);
  });

  it('treats a base branch that starts with a hyphen as missing, not as an option', async () => {
    clearGitCaches();
    const view = await readBranches([{ name: 'repo', path: repo, base: '--upload-pack=touch x' }], dir, { refresh: true, now: NOW });
    assert.equal(view.repos[0]!.ok, false);
    assert.match(view.repos[0]!.error ?? '', /base branch .* does not exist/);
  });

  it('runs git with the allow listed environment and the read-only settings only', () => {
    const saved = { token: process.env.GITHUB_TOKEN, key: process.env.AFFICE_GIT_TEST_API_KEY, cfg: process.env.GIT_CONFIG_GLOBAL, ssh: process.env.GIT_SSH_COMMAND };
    process.env.GITHUB_TOKEN = 'canary';
    process.env.AFFICE_GIT_TEST_API_KEY = 'canary';
    process.env.GIT_SSH_COMMAND = 'evil';
    try {
      const env = gitEnv();
      assert.deepEqual(
        Object.keys(env).filter((name) => /TOKEN|KEY|SECRET|SSH/.test(name)),
        [],
      );
      assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
      assert.equal(env.GIT_TERMINAL_PROMPT, '0');
      assert.equal(env.GIT_OPTIONAL_LOCKS, '0');
      assert.equal(env.GIT_PAGER, 'cat');
      assert.equal(env.PATH, process.env.PATH);
      assert.deepEqual(GIT_HARDENING.filter((_, i) => GIT_HARDENING[i - 1] === '-c'), ['core.fsmonitor=false', 'core.hooksPath=/dev/null', 'core.sshCommand=false', 'protocol.ext.allow=never']);
      assert.ok(GIT_HARDENING.includes('--no-optional-locks') && GIT_HARDENING.includes('--no-pager'));
    } finally {
      for (const [name, value] of [['GITHUB_TOKEN', saved.token], ['AFFICE_GIT_TEST_API_KEY', saved.key], ['GIT_CONFIG_GLOBAL', saved.cfg], ['GIT_SSH_COMMAND', saved.ssh]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
