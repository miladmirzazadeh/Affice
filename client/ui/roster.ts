// The agents roster of one department: the manager and each subagent, with status, elapsed time,
// card key and what it is doing. Clicking an agent focuses it in the scene.

import type { OfficeState } from '../../shared/scene-api';
import { plainLine } from '../../shared/plain-line';
import type { AgentPresence } from '../../shared/types';
import { h, setAttr, setText, syncList } from './dom';
import { agentsOf } from './derive';
import { AGENT_LABEL, elapsed, modelName, toolName } from './format';

export interface Roster {
  el: HTMLElement;
  update(state: OfficeState, department: string): void;
  /** Refreshes the elapsed times. */
  tick(): void;
}

/** "ENG-11 Stop printing codes" with key ENG-11 reads as "Stop printing codes" beside the key chip. */
function displayTitle(agent: AgentPresence): string {
  const key = agent.cardKey;
  if (key && agent.title.startsWith(key)) {
    const rest = agent.title.slice(key.length).replace(/^[\s:.,]+/, '');
    if (rest) return plainLine(rest);
  }
  return plainLine(agent.title);
}

export function createRoster(deps: { onSelect(id: string): void }): Roster {
  const count = h('span', { class: 'section-count' });
  const list = h('ul', { class: 'roster-list' });
  const empty = h('p', { class: 'roster-empty', hidden: true, text: 'Nobody is here yet. Start the session and the manager takes its desk.' });
  const el = h(
    'section',
    { class: 'roster', 'aria-labelledby': 'roster-title' },
    h('div', { class: 'section-head' }, h('h3', { class: 'section-title', id: 'roster-title', text: 'Agents' }), count),
    list,
    empty,
  );

  function create(agent: AgentPresence): HTMLElement {
    const row = h(
      'button',
      { class: 'agent', type: 'button' },
      h('span', { class: 'agent-dot', 'aria-hidden': 'true' }),
      h('span', { class: 'agent-title', dir: 'auto' }),
      h('span', { class: 'agent-time' }),
      h(
        'span',
        { class: 'agent-sub' },
        h('span', { class: 'agent-status' }),
        h('span', { class: 'key' }),
        h('span', { class: 'agent-model' }),
        h('span', { class: 'agent-detail', dir: 'auto' }),
      ),
    );
    row.addEventListener('click', () => deps.onSelect(agent.id));
    return h('li', { class: 'roster-item' }, row);
  }

  function fill(item: HTMLElement, agent: AgentPresence, selectedId: string | null) {
    const row = item.firstElementChild as HTMLButtonElement;
    row.dataset.status = agent.status;
    row.dataset.kind = agent.kind;
    row.dataset.started = agent.startedAt;
    row.dataset.ended = agent.endedAt ?? '';
    setAttr(row, 'aria-current', agent.id === selectedId ? 'true' : null);
    setText(row.querySelector('.agent-title')!, displayTitle(agent));
    setText(row.querySelector('.agent-time')!, elapsed(agent.startedAt, agent.endedAt));
    setText(row.querySelector('.agent-status')!, agent.kind === 'manager' && agent.status === 'idle' ? 'Manager' : AGENT_LABEL[agent.status]);
    const key = row.querySelector('.key') as HTMLElement;
    key.hidden = !agent.cardKey;
    setText(key, agent.cardKey ?? '');
    const model = row.querySelector('.agent-model') as HTMLElement;
    model.hidden = !agent.model;
    setText(model, modelName(agent.model));
    const busy = agent.status === 'working' || agent.status === 'thinking' || agent.status === 'waiting';
    const detail = busy && agent.currentTool ? toolName(agent.currentTool) : plainLine(agent.lastText);
    setText(row.querySelector('.agent-detail')!, detail);
    setAttr(row, 'title', agent.title);
  }

  let last: unknown[] = [];

  return {
    el,
    update(state, department) {
      const inputs = [state.agents, state.selected, department];
      if (inputs.every((value, i) => value === last[i])) return;
      const selectionChanged = inputs[1] !== last[1];
      last = inputs;
      const agents = agentsOf(state, department);
      const selectedId = state.selected?.kind === 'agent' ? state.selected.id : null;
      setText(count, agents.length ? String(agents.length) : '');
      syncList(list, agents, (a) => a.id, create, (item, a) => fill(item, a, selectedId));
      empty.hidden = agents.length > 0;
      if (selectionChanged && selectedId) {
        list.querySelector<HTMLElement>('.agent[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
      }
    },
    tick() {
      if (!el.isConnected) return;
      for (const row of list.querySelectorAll<HTMLElement>('.agent')) {
        const time = row.querySelector('.agent-time');
        if (time && row.dataset.started) setText(time, elapsed(row.dataset.started, row.dataset.ended || null));
      }
    },
  };
}
