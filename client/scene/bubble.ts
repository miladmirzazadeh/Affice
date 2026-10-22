// The speech bubble over an avatar: an HTML card placed by CSS2DRenderer. At building zoom it is
// only the status chip; the full card (card key, title, what the agent does, model) shows when the
// room is focused or the avatar is hovered.

import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { plainLine } from '../../shared/plain-line';
import { modelLabel, type AgentPresence, type AgentStatus } from '../../shared/types';

export type BubbleMode = 'hidden' | 'chip' | 'full';

const CHIP: Record<AgentStatus, string> = {
  idle: 'Idle',
  thinking: 'Thinking',
  working: 'Working',
  waiting: 'Waiting for you',
  arriving: 'Starting',
  done: 'Done',
  failed: 'Failed',
};

const TIMED: ReadonlySet<AgentStatus> = new Set(['working', 'thinking']);

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d`;
}

export function modelName(model: string | null): string {
  if (!model) return '';
  return modelLabel(model);
}

function toolName(tool: string): string {
  if (!tool.startsWith('mcp__')) return tool;
  const [, server, ...rest] = tool.split('__');
  return `${server} ${rest.join(' ')}`.replace(/_/g, ' ');
}

export class Bubble {
  readonly object: CSS2DObject;
  private readonly el: HTMLDivElement;
  private readonly key: HTMLSpanElement;
  private readonly chip: HTMLSpanElement;
  private readonly title: HTMLDivElement;
  private readonly detail: HTMLSpanElement;
  private readonly model: HTMLSpanElement;
  private status: AgentStatus = 'idle';
  private since = 0;
  private mode: BubbleMode = 'chip';

  constructor(agentId: string) {
    // The outer element is placed by CSS2DRenderer with its bottom center on the anchor above the
    // head; its bottom padding holds the card's pointer.
    const el = document.createElement('div');
    el.className = 'office-bubble is-chip';
    const card = document.createElement('div');
    card.className = 'ob-card';
    card.dataset.officeAgent = agentId;
    const head = document.createElement('div');
    head.className = 'ob-head';
    this.key = document.createElement('span');
    this.key.className = 'ob-key';
    this.chip = document.createElement('span');
    this.chip.className = 'ob-chip';
    head.append(this.key, this.chip);
    this.title = document.createElement('div');
    this.title.className = 'ob-title';
    this.title.dir = 'auto';
    const foot = document.createElement('div');
    foot.className = 'ob-foot';
    this.detail = document.createElement('span');
    this.detail.className = 'ob-detail';
    this.detail.dir = 'auto';
    this.model = document.createElement('span');
    this.model.className = 'ob-model';
    foot.append(this.detail, this.model);
    card.append(head, this.title, foot);
    el.append(card);
    this.el = el;
    this.object = new CSS2DObject(el);
    this.object.center.set(0.5, 1);
  }

  /** Fills the card from the agent. `since` is when the elapsed time counts from (epoch ms). */
  set(agent: AgentPresence, since: number): void {
    this.status = agent.status;
    this.since = since;
    const key = agent.kind === 'manager' ? 'Manager' : (agent.cardKey ?? '');
    let title = plainLine(agent.title);
    if (agent.cardKey && title.startsWith(agent.cardKey)) title = title.slice(agent.cardKey.length).replace(/^[\s:.]+/, '');
    const detail = agent.currentTool ? `Using ${toolName(agent.currentTool)}` : plainLine(agent.lastText);
    write(this.key, key);
    write(this.title, title || plainLine(agent.title));
    write(this.detail, detail);
    write(this.model, modelName(agent.model));
    this.chip.dataset.status = agent.status;
    this.el.dataset.status = agent.status;
    this.tick(Date.now());
  }

  /** Refreshes the elapsed time in the chip. */
  tick(now: number): void {
    const label = TIMED.has(this.status) && this.since > 0 ? `${CHIP[this.status]} ${formatElapsed(now - this.since)}` : CHIP[this.status];
    write(this.chip, label);
  }

  setMode(mode: BubbleMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.object.visible = mode !== 'hidden';
    this.el.classList.toggle('is-chip', mode === 'chip');
  }

  get element(): HTMLDivElement {
    return this.el;
  }
}

function write(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}
