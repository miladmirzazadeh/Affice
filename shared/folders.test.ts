import assert from 'node:assert/strict';
import { test } from 'node:test';
import { broadFolder, broadFolderMessage, normalizeFolder } from './folders';

test('normalizeFolder writes a path in one spelling', () => {
  assert.equal(normalizeFolder('/'), '/');
  assert.equal(normalizeFolder('//'), '/');
  assert.equal(normalizeFolder('/a//b/./c/'), '/a/b/c');
  assert.equal(normalizeFolder('/a/b/../..'), '/');
  assert.equal(normalizeFolder('/..'), '/');
  assert.equal(normalizeFolder('C:\\Users\\ada\\'), 'C:/Users/ada');
  assert.equal(normalizeFolder('c:/'), 'C:/');
  assert.equal(normalizeFolder('docs/./x'), 'docs/x');
  assert.equal(normalizeFolder('../x'), '../x');
  assert.equal(normalizeFolder(''), '.');
});

test('the root of the disk is too broad, in every spelling', () => {
  for (const path of ['/', '//', '/.', '/a/..', '/../..', ' / ', 'C:\\', 'c:/', 'D:']) {
    assert.equal(broadFolder(path), 'the root of the disk', path);
    assert.equal(broadFolder(path, '/Users/ada'), 'the root of the disk', path);
  }
});

test('the home folder is too broad: the real one when it is known, the usual places when it is not', () => {
  assert.equal(broadFolder('/Users/ada', '/Users/ada'), 'your home folder');
  assert.equal(broadFolder('/Users/ada/', '/Users/ada'), 'your home folder');
  assert.equal(broadFolder('/Users/ada/code/..', '/Users/ada'), 'your home folder');
  assert.equal(broadFolder('/srv/ada', '/srv/ada'), 'your home folder');
  assert.equal(broadFolder('/Users/ada', '/srv/ada'), null, 'with the real home known, only that is the home');
  assert.equal(broadFolder('/Users/ada'), 'your home folder');
  assert.equal(broadFolder('/home/ada/'), 'your home folder');
  assert.equal(broadFolder('/root'), 'your home folder');
});

test('a folder inside the home folder, a relative path and an ordinary folder are fine', () => {
  for (const path of ['/Users/ada/code', '/home/ada/code/app', '/Users', '/home', '/tmp', '/srv/ada/reports', 'reports', 'Office', '.', '..', '']) {
    assert.equal(broadFolder(path, '/srv/ada'), null, path);
    assert.equal(broadFolder(path), null, path);
  }
});

test('the sentence names the folder and says what to do', () => {
  assert.equal(broadFolderMessage('A report folder', '/', 'the root of the disk'), 'A report folder / is the root of the disk, which is too broad. Name a folder inside your project instead.');
  assert.match(broadFolderMessage('A knowledge folder', `/${'x'.repeat(200)}`, 'your home folder'), /\.\.\. is your home folder/);
});
