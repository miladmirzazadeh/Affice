import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_REPORT_DIR } from '../../shared/folders';
import { broadFolderErrors, parseRepos } from './form';
import { DEPARTMENT_TEMPLATES } from './templates';

test('the form refuses the root of the disk and the home folder for repos, reports and knowledge', () => {
  const found = broadFolderErrors({
    repos: parseRepos('/ main').repos,
    reportDirs: ['reports', '/'],
    knowledgeDirs: ['docs', '/Users/ada'],
  });
  assert.match(found.repos!, /A repository path \/ is the root of the disk/);
  assert.match(found.reports!, /A report folder \/ is the root of the disk/);
  assert.match(found.knowledge!, /A knowledge folder \/Users\/ada is your home folder/);
  assert.match(found.knowledge!, /Name a folder inside your project instead/);
});

test('ordinary folders, relative folders and folders inside the home folder pass the form', () => {
  assert.deepEqual(
    broadFolderErrors({
      repos: parseRepos('/Users/ada/code/api main\nweb main').repos,
      reportDirs: ['reports', '/Users/ada/code/api/reports', '.'],
      knowledgeDirs: ['docs', 'Office', '/Users/ada/notes'],
    }),
    {},
  );
});

test('every department template starts with the default report folder, which is the folder the protocol writes to', () => {
  assert.equal(DEFAULT_REPORT_DIR, 'reports');
  assert.ok(DEPARTMENT_TEMPLATES.length >= 4);
  for (const template of DEPARTMENT_TEMPLATES) assert.deepEqual(template.reportDirs, [DEFAULT_REPORT_DIR], template.id);
});
