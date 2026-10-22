// reports.ts on a temporary folder: names, dates, titles, order, and what is left out.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { ReportInfo } from '../../shared/types';
import { dateFromName, htmlTitle, markdownTitle, readReports } from './reports';

describe('reports of a department', () => {
  let dir = '';
  let reports: ReportInfo[] = [];
  const report = (file: string): ReportInfo => {
    const found = reports.find((candidate) => candidate.file === file);
    assert.ok(found, `${file} is listed`);
    return found;
  };

  before(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'office-reports-')));
    mkdirSync(join(dir, 'agent-reports'));
    mkdirSync(join(dir, 'Management', 'reports'), { recursive: true });
    mkdirSync(join(dir, 'agent-reports', 'nested'));
    const put = (path: string, text: string, mtime?: string) => {
      writeFileSync(join(dir, path), text);
      if (mtime) utimesSync(join(dir, path), new Date(mtime), new Date(mtime));
    };
    put('agent-reports/2026-10-17-ENG-5-office-data.md', '# Office data views\n\nText.\n', '2026-10-17T09:00:00Z');
    put('agent-reports/2026-10-12-prompt-review.md', '---\ntitle: front matter\n# a comment in the front matter\n---\n```sh\n# not a title\n```\n# `The` real **title** ##\n', '2026-10-12T09:00:00Z');
    put('agent-reports/2026-09-28-page.html', '<!doctype html><title>\n  The &amp; page &#8211; one </title><body><h1>Other</h1>', '2026-09-28T09:00:00Z');
    put('agent-reports/notes.md', 'No heading here.\n## Only a second level\n', '2026-09-30T12:00:00Z');
    put('agent-reports/2026-13-45-bad-date.md', '# Bad date\n', '2026-09-01T12:00:00Z');
    put('agent-reports/data.json', '{}');
    put('agent-reports/picture.png', 'x');
    put('agent-reports/.hidden.md', '# Hidden\n');
    put('agent-reports/nested/2026-10-17-inner.md', '# Inner\n');
    put('Management/reports/2026-10-17-git-census.md', '# Git census, 2026-10-17\n', '2026-10-17T11:00:00Z');
    reports = (await readReports(['agent-reports', join(dir, 'Management', 'reports'), 'does-not-exist', 'agent-reports'], dir)).reports;
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it('lists .md and .html files of every directory, not recursive, without hidden files or other types', () => {
    assert.deepEqual(
      reports.map((r) => r.file).sort(),
      ['2026-09-28-page.html', '2026-10-12-prompt-review.md', '2026-10-17-ENG-5-office-data.md', '2026-10-17-git-census.md', '2026-13-45-bad-date.md', 'notes.md'],
    );
  });

  it('takes the date and the card key from the file name', () => {
    const first = report('2026-10-17-ENG-5-office-data.md');
    assert.equal(first.date, '2026-10-17');
    assert.equal(first.cardKey, 'ENG-5');
    assert.equal(first.path, join(dir, 'agent-reports', '2026-10-17-ENG-5-office-data.md'));
    assert.equal(report('notes.md').date, null);
    assert.equal(report('2026-13-45-bad-date.md').date, null);
    assert.equal(report('2026-10-12-prompt-review.md').cardKey, null);
    assert.equal(dateFromName('2026-02-30-x.md'), null);
  });

  it('takes the title from the first heading, or the html title, or the file name', () => {
    assert.equal(report('2026-10-17-ENG-5-office-data.md').title, 'Office data views');
    assert.equal(report('2026-10-12-prompt-review.md').title, 'The real title');
    assert.equal(report('2026-09-28-page.html').title, `The & page ${String.fromCharCode(0x2013)} one`);
    assert.equal(report('notes.md').title, 'notes.md');
    assert.equal(markdownTitle('#hashtag\n# Real\n'), 'Real');
    assert.equal(htmlTitle('<p>no title</p>'), null);
  });

  it('orders newest first by date, then modification time, dating an undated file by its modification day', () => {
    assert.deepEqual(
      reports.map((r) => r.file),
      [
        '2026-10-17-git-census.md', // same day as the next, modified later
        '2026-10-17-ENG-5-office-data.md',
        '2026-10-12-prompt-review.md',
        'notes.md', // undated, modified 2026-09-30
        '2026-09-28-page.html',
        '2026-13-45-bad-date.md', // an invalid date counts as undated, modified 2026-09-01
      ],
    );
  });
});

describe('reports and symbolic links (SEC-13)', () => {
  let dir = '';
  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'office-reports-links-')));
    mkdirSync(join(dir, 'reports'));
    mkdirSync(join(dir, 'outside'));
    writeFileSync(join(dir, 'outside', 'secret.md'), '# secret outside\n');
    writeFileSync(join(dir, 'outside', 'notes.txt'), '# not a report\n');
    writeFileSync(join(dir, 'reports', 'real.md'), '# Real report\n');
    writeFileSync(join(dir, 'reports', 'plain.txt'), '# a text file\n');
    symlinkSync(join(dir, 'outside', 'secret.md'), join(dir, 'reports', 'link-out.md'));
    symlinkSync(join(dir, 'outside'), join(dir, 'reports', 'folder-out.md'));
    symlinkSync(join(dir, 'outside', 'missing.md'), join(dir, 'reports', 'dangling.md'));
    symlinkSync(join(dir, 'reports', 'plain.txt'), join(dir, 'reports', 'text-as-report.md'));
    symlinkSync(join(dir, 'reports', 'real.md'), join(dir, 'reports', 'alias.md'));
    symlinkSync('/etc/hosts', join(dir, 'reports', 'hosts.md'));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('skips a link that leaves the report folder, so its target\'s first line never becomes a title', async () => {
    const { reports } = await readReports(['reports'], dir);
    assert.deepEqual(reports.map((r) => r.file).sort(), ['alias.md', 'real.md'], 'only files whose real path is inside the folder and still a report');
    assert.ok(!JSON.stringify(reports).includes('secret outside'));
  });

  it('lists the files of a report folder that is itself a link, as the route serves them', async () => {
    symlinkSync(join(dir, 'reports'), join(dir, 'reports-link'));
    const { reports } = await readReports(['reports-link'], dir);
    assert.deepEqual(reports.map((r) => r.file).sort(), ['alias.md', 'real.md']);
  });
});
