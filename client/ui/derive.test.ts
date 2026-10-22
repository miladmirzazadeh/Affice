import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import type { Department } from '../../shared/types';
import { speakerLabel } from './derive';

const room = { id: 'engineering', name: 'Engineering', kind: 'room' } as Department;
const lobby = { id: 'general', name: 'General manager', kind: 'lobby' } as Department;

test('the person typing is "You", also for a history line that still has the old role name', () => {
  assert.equal(speakerLabel({ role: 'user' }, room), 'You');
  assert.equal(speakerLabel({ role: 'founder' as never }, room), 'You');
});

test('the other speakers keep their names', () => {
  assert.equal(speakerLabel({ role: 'manager' }, room), 'Engineering manager');
  assert.equal(speakerLabel({ role: 'manager' }, lobby), 'General manager');
  assert.equal(speakerLabel({ role: 'colleague', fromName: 'Marketing manager' }, room), 'Marketing manager');
  assert.equal(speakerLabel({ role: 'colleague' }, room), 'A colleague');
  assert.equal(speakerLabel({ role: 'system' }, room), 'Office');
});

/** Where the old name may still appear: the place that reads old history, the label that tolerates it, and the note on the type. */
const MAY_NAME_THE_OLD_ROLE = new Set(['server/office-store.ts', 'client/ui/derive.ts', 'shared/types.ts']);

test('no source file prints or stores the old role name, except where old history is read', () => {
  const root = join(import.meta.dirname, '../..');
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|css|html|json)$/.test(name) && !/\.test\.ts$/.test(name)) {
        const file = relative(root, path);
        if (!MAY_NAME_THE_OLD_ROLE.has(file) && /founder/i.test(readFileSync(path, 'utf8'))) found.push(file);
      }
    }
  };
  for (const dir of ['server', 'client', 'shared', 'fixtures']) walk(join(root, dir));
  assert.deepEqual(found, []);
});
