import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { PRIVATE_FILE, PRIVATE_FOLDER, UnsafePathError, appendFileSafe, ensureFolder, refuseUnlessPlainFile, writeFileAtomic, writeNewFile } from './safe-fs';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'affice-safe-fs-')));
after(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
function scratch(): string {
  const dir = join(root, `s${(n += 1)}`);
  mkdirSync(dir);
  return dir;
}

test('writeNewFile creates a file, leaves an existing one and a link (even a dangling one) alone', () => {
  const dir = scratch();
  assert.equal(writeNewFile(join(dir, 'a.txt'), 'one'), true);
  assert.equal(writeNewFile(join(dir, 'a.txt'), 'two'), false);
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'one');
  symlinkSync(join(dir, 'nowhere.txt'), join(dir, 'link.txt'));
  assert.equal(writeNewFile(join(dir, 'link.txt'), 'x'), false);
  assert.ok(!existsSync(join(dir, 'nowhere.txt')));
});

test('writeFileAtomic replaces a file, leaves no temporary file, and never writes through a link', () => {
  const dir = scratch();
  const file = join(dir, 'config.json');
  writeFileAtomic(file, 'first');
  writeFileAtomic(file, 'second');
  assert.equal(readFileSync(file, 'utf8'), 'second');
  assert.deepEqual(readdirSync(dir), ['config.json']);

  const target = join(dir, 'target.txt');
  writeFileSync(target, 'KEEP');
  const link = join(dir, 'linked.json');
  symlinkSync(target, link);
  assert.throws(() => writeFileAtomic(link, 'overwrite'), UnsafePathError);
  assert.equal(readFileSync(target, 'utf8'), 'KEEP');
  mkdirSync(join(dir, 'a-folder'));
  assert.throws(() => writeFileAtomic(join(dir, 'a-folder'), 'x'), /not a regular file/);
});

test('writeFileAtomic cleans its temporary file when the rename cannot happen', () => {
  const dir = scratch();
  assert.throws(() => writeFileAtomic(join(dir, 'missing-folder', 'x.json'), 'x'));
  assert.deepEqual(readdirSync(dir), []);
});

test('appendFileSafe appends, creates, and refuses a link in place of the file', () => {
  const dir = scratch();
  const file = join(dir, 'chat.jsonl');
  appendFileSafe(file, 'one\n');
  appendFileSafe(file, 'two\n');
  assert.equal(readFileSync(file, 'utf8'), 'one\ntwo\n');

  const target = join(dir, 'target.txt');
  writeFileSync(target, 'KEEP');
  symlinkSync(target, join(dir, 'live.jsonl'));
  assert.throws(() => appendFileSafe(join(dir, 'live.jsonl'), 'x\n'), /symbolic link/);
  assert.equal(readFileSync(target, 'utf8'), 'KEEP');

  symlinkSync(join(dir, 'created-by-affice.txt'), join(dir, 'dangling.jsonl'));
  assert.throws(() => appendFileSafe(join(dir, 'dangling.jsonl'), 'x\n'), /symbolic link/);
  assert.ok(!existsSync(join(dir, 'created-by-affice.txt')));
});

test('ensureFolder makes a folder, keeps a real one, and refuses a link or a folder that leads elsewhere', () => {
  const dir = scratch();
  const made = ensureFolder(join(dir, 'chat'), dir, 'chat');
  assert.equal(made, join(dir, 'chat'));
  assert.equal(ensureFolder(join(dir, 'chat'), dir, 'chat'), made, 'a real folder is kept');

  const elsewhere = scratch();
  symlinkSync(elsewhere, join(dir, 'link'));
  assert.throws(() => ensureFolder(join(dir, 'link'), dir, 'The link folder'), /The link folder .* is a symbolic link/);
  assert.ok(lstatSync(join(dir, 'link')).isSymbolicLink());
  assert.deepEqual(readdirSync(elsewhere), []);

  writeFileSync(join(dir, 'file'), 'x');
  assert.throws(() => ensureFolder(join(dir, 'file'), dir, 'file'), (error: NodeJS.ErrnoException) => error.code === 'EEXIST', 'a file in the way is the mkdir error');
  assert.throws(() => ensureFolder(join(dir, 'chat'), elsewhere, 'chat'), /leads outside the project/);
});

test('refuseUnlessPlainFile accepts a missing file and a regular file only', () => {
  const dir = scratch();
  refuseUnlessPlainFile(join(dir, 'missing'), 'missing');
  writeFileSync(join(dir, 'plain'), 'x');
  refuseUnlessPlainFile(join(dir, 'plain'), 'plain');
  symlinkSync(join(dir, 'plain'), join(dir, 'link'));
  assert.throws(() => refuseUnlessPlainFile(join(dir, 'link'), 'The link'), /The link .* is a symbolic link/);
});

test('private modes: a new file and a new folder get the mode asked for, a file replaced atomically takes it too, and the default stays 0644 and 0755', { skip: process.platform === 'win32' }, () => {
  const mode = (path: string): number => lstatSync(path).mode & 0o777;
  const before = process.umask(0o022);
  try {
    const dir = scratch();
    writeFileAtomic(join(dir, 'public.json'), 'x');
    assert.equal(mode(join(dir, 'public.json')), 0o644);
    writeFileAtomic(join(dir, 'private.json'), 'x', 'private.json', PRIVATE_FILE);
    assert.equal(mode(join(dir, 'private.json')), 0o600);
    // An older file with looser rights is replaced by one with the mode asked for.
    writeFileAtomic(join(dir, 'public.json'), 'y', 'public.json', PRIVATE_FILE);
    assert.equal(mode(join(dir, 'public.json')), 0o600);

    appendFileSafe(join(dir, 'open.jsonl'), 'a\n');
    assert.equal(mode(join(dir, 'open.jsonl')), 0o644);
    appendFileSafe(join(dir, 'chat.jsonl'), 'a\n', 'chat.jsonl', PRIVATE_FILE);
    appendFileSafe(join(dir, 'chat.jsonl'), 'b\n', 'chat.jsonl', PRIVATE_FILE);
    assert.equal(mode(join(dir, 'chat.jsonl')), 0o600);
    assert.equal(readFileSync(join(dir, 'chat.jsonl'), 'utf8'), 'a\nb\n');

    ensureFolder(join(dir, 'shared'), dir, 'shared');
    assert.equal(mode(join(dir, 'shared')), 0o755);
    ensureFolder(join(dir, 'chat'), dir, 'chat', PRIVATE_FOLDER);
    assert.equal(mode(join(dir, 'chat')), 0o700);
    ensureFolder(join(dir, 'shared'), dir, 'shared', PRIVATE_FOLDER);
    assert.equal(mode(join(dir, 'shared')), 0o755, 'a folder that is already there keeps its own mode');
  } finally {
    process.umask(before);
  }
});
