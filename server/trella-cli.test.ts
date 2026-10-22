import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { findBoard, trellaBoards, trellaProblem } from './trella-cli';

const dirs: string[] = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function fakeTrella(built: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'trella-cli-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'trella.js'), '');
  if (built) {
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'dist', 'index.js'), '');
  }
  return join(dir, 'bin', 'trella.js');
}

test('a missing or unbuilt Trella is explained, not a crash', async () => {
  const missing = join(tmpdir(), 'no-such-trella', 'bin', 'trella.js');
  assert.match(trellaProblem(missing)!, /Trella was not found at .*AFFICE_TRELLA_CLI/);
  const unbuilt = fakeTrella(false);
  assert.match(trellaProblem(unbuilt)!, /Trella is not built.*npm run build/);
  // True for someone who ran npx affice and for a clone: npx first, the build for a clone second.
  assert.match(trellaProblem(unbuilt)!, /Run npx --yes affice@latest to fetch a fresh copy\. In a clone of the repository, run npm run build there\./);
  assert.match(trellaProblem(missing)!, /unset it to use the bundled Trella\. Run npx --yes affice@latest/);
  assert.equal(trellaProblem(fakeTrella(true)), null);

  assert.deepEqual(await trellaBoards(tmpdir(), missing)('Sales'), { boardId: null, error: trellaProblem(missing) });
  assert.deepEqual(await trellaBoards(tmpdir(), unbuilt)('Sales'), { boardId: null, error: trellaProblem(unbuilt) });
});

test('findBoard picks the newest board of the project with that name', () => {
  const summary = {
    boards: [
      { id: 'a', projectId: 'p1', name: 'Sales', createdAt: '2026-01-01' },
      { id: 'b', projectId: 'p1', name: 'Sales', createdAt: '2026-02-01' },
      { id: 'c', projectId: 'p2', name: 'Sales', createdAt: '2026-03-01' },
    ],
  };
  assert.equal(findBoard(summary, 'p1', 'Sales'), 'b');
  assert.equal(findBoard(summary, 'p3', 'Sales'), null);
  assert.equal(findBoard(null, 'p1', 'Sales'), null);
});
