// The reducer's handling of a whole new office (a project switch or a reconnect): the selection survives only
// when what it points at is still there.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentPresence, Department, OfficeSnapshot } from '../../shared/types';
import type { OfficeState } from '../../shared/scene-api';
import { emptySnapshot, reduce } from './store';

const department = (id: string, slot: number): Department => ({
  id, name: id, color: 'stone', responsibility: '', cwd: '/p', model: 'sonnet', permission: 'ask',
  repos: [], reportDirs: [], trellaBoardId: null, sessionId: null, slot, createdAt: '2026-10-19T00:00:00.000Z',
});
const agent = (id: string, dept: string): AgentPresence => ({
  id, department: dept, kind: 'manager', title: id, cardKey: null, model: null, status: 'idle', currentTool: null,
  lastText: null, startedAt: '2026-10-19T00:00:00.000Z', endedAt: null, parentToolUseId: null,
});
const snapshot = (departments: Department[], agents: AgentPresence[] = []): OfficeSnapshot => ({
  ...emptySnapshot, config: { ...emptySnapshot.config, departments }, agents,
});
const state = (selected: OfficeState['selected']): OfficeState => ({ ...emptySnapshot, selected, connection: 'live', app: null });

test('a new office drops a selected department that is not in it, and keeps one that is', () => {
  const engineering = state({ kind: 'department', id: 'engineering' });
  assert.equal(reduce(engineering, { type: 'office.state', snapshot: snapshot([department('general', -1)]) }).selected, null);
  assert.deepEqual(
    reduce(engineering, { type: 'office.state', snapshot: snapshot([department('general', -1), department('engineering', 0)]) }).selected,
    { kind: 'department', id: 'engineering' },
  );
});

test('a new office drops a selected agent that is not in it, and keeps one that is', () => {
  const selected = state({ kind: 'agent', id: 'manager:engineering' });
  assert.equal(reduce(selected, { type: 'office.state', snapshot: snapshot([department('general', -1)], [agent('manager:general', 'general')]) }).selected, null);
  assert.deepEqual(
    reduce(selected, { type: 'office.state', snapshot: snapshot([department('engineering', 0)], [agent('manager:engineering', 'engineering')]) }).selected,
    { kind: 'agent', id: 'manager:engineering' },
  );
  assert.equal(reduce(state(null), { type: 'office.state', snapshot: snapshot([]) }).selected, null);
});
