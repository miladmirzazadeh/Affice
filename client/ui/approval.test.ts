import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PERMISSION_PART_CAP, type PermissionRequest } from '../../shared/types';
import { approvalMeta, approvalParts, cutNote, isLong, SHORT_CHARS, SHORT_LINES } from './approval';

function request(patch: Partial<PermissionRequest> = {}): PermissionRequest {
  return { id: 'perm_1', department: 'engineering', agentId: 'manager:engineering', tool: 'Bash', input: { command: 'ls' }, summary: 'Run ls', at: '2026-10-20T09:00:00.000Z', ...patch };
}

test('SEC-05: a block is long when it passes eight lines or 480 characters, and only then gets Show all', () => {
  assert.equal(isLong('ls -la'), false);
  assert.equal(isLong(Array.from({ length: SHORT_LINES }, () => 'x').join('\n')), false);
  assert.equal(isLong(Array.from({ length: SHORT_LINES + 1 }, () => 'x').join('\n')), true);
  assert.equal(isLong('y'.repeat(SHORT_CHARS)), false);
  assert.equal(isLong('y'.repeat(SHORT_CHARS + 1)), true);
});

test('SEC-05: a cut is always said, with how much is missing and what to do', () => {
  assert.match(cutNote(1), /^1 more character is not shown/);
  assert.match(cutNote(9), /^9 more characters are not shown/);
  assert.ok(cutNote(9).includes(String(PERMISSION_PART_CAP)));
  assert.match(cutNote(9), /Deny it unless you trust the rest\.$/);
});

test('SEC-05: the card shows the server blocks, or the raw input cut the same way for a request that has none', () => {
  const parts = [{ label: 'Command', text: 'git status\nrm -rf ~', cut: 0 }];
  assert.deepEqual(approvalParts(request({ parts })), parts);
  assert.deepEqual(approvalParts(request()), [{ label: 'Input', text: '{\n  "command": "ls"\n}', cut: 0 }]);
  assert.deepEqual(approvalParts(request({ input: {} })), []);
  const huge = approvalParts(request({ input: { command: 'z'.repeat(PERMISSION_PART_CAP + 50) } }))[0];
  assert.equal(huge.text.length, PERMISSION_PART_CAP);
  assert.ok(huge.cut > 0);
});

test('the lines above the blocks are the working folder and the file, when there are any', () => {
  assert.deepEqual(approvalMeta(request()), []);
  assert.deepEqual(approvalMeta(request({ cwd: '/work/project', path: '/work/project/a.ts' })), [
    { label: 'Folder', text: '/work/project' },
    { label: 'File', text: '/work/project/a.ts' },
  ]);
  assert.deepEqual(approvalMeta(request({ cwd: null, path: null })), []);
});
