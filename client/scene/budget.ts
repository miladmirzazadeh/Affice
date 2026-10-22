// The scene's budget check, a development page only (client/scene/budget.html, served by Vite):
// six departments, six managers and twenty subagents in every status, some walking in, so the
// frames measured include the shadow pass. The contract allows 150 draw calls and 80k triangles.

import type { AgentPresence, AgentStatus, Department, DepartmentColor, OfficeSnapshot } from '../../shared/types';
import { createStore } from '../state/store';
import { createOffice } from './index';

const names = ['Development', 'Marketing', 'Sales', 'Design', 'Support', 'Research'];
const colors: DepartmentColor[] = ['indigo', 'rose', 'moss', 'amber', 'sky', 'plum'];
const subagents = [8, 3, 3, 2, 2, 2];
const statuses: AgentStatus[] = ['arriving', 'working', 'thinking', 'waiting', 'working', 'done', 'failed'];
const now = new Date().toISOString();

const departments: Department[] = names.map((name, slot) => ({
  id: name.toLowerCase(),
  name,
  color: colors[slot],
  responsibility: '',
  cwd: '/',
  model: 'claude-opus-5-5',
  permission: 'ask',
  repos: [],
  reportDirs: [],
  trellaBoardId: null,
  sessionId: null,
  slot,
  createdAt: now,
}));

const agents: AgentPresence[] = [];
departments.forEach((department, i) => {
  const base = { department: department.id, currentTool: null, lastText: null, startedAt: now, endedAt: null, parentToolUseId: null };
  agents.push({ ...base, id: `manager:${department.id}`, kind: 'manager', title: `${department.name} manager`, cardKey: null, model: 'claude-opus-5-5', status: 'working' });
  for (let k = 0; k < subagents[i]; k += 1) {
    const key = `ENG-${20 + agents.length}`;
    const status = statuses[(i + k) % statuses.length];
    agents.push({ ...base, id: `${department.id}-${k}`, kind: 'subagent', title: `${key} Task ${k + 1}`, cardKey: key, model: 'claude-sonnet-5-5', status });
  }
});

const snapshot: OfficeSnapshot = {
  config: { version: 1, company: 'Acme Studio', trellaUrl: '', departments },
  sessions: departments.map((d) => ({ department: d.id, status: 'busy', sessionId: null, model: null, startedAt: now, error: null, bypass: false })),
  agents,
  messages: [],
  permissions: [],
};

const store = createStore({ send() {} }, 'mock');
const scene = createOffice(document.getElementById('scene')!, store);
window.addEventListener('resize', () => scene.resize());
store.dispatch({ type: 'office.state', snapshot });

const out = document.getElementById('budget')!;
let peakCalls = 0;
let peakTriangles = 0;
window.setInterval(() => {
  const stats = scene.stats();
  peakCalls = Math.max(peakCalls, stats.drawCalls);
  peakTriangles = Math.max(peakTriangles, stats.triangles);
  out.dataset.calls = String(peakCalls);
  out.dataset.triangles = String(peakTriangles);
  out.textContent =
    `${agents.length} avatars, ${departments.length} rooms. Now ${stats.drawCalls} draws, ${stats.triangles} triangles, ` +
    `${stats.fps} fps. Peak ${peakCalls} draws, ${peakTriangles} triangles.`;
}, 1000);
