// Labels and time formats for the chrome. English copy, no dashes.

import { modelLabel, type AgentStatus, type PermissionPolicy, type SessionStatus } from '../../shared/types';

export function modelName(id: string | null | undefined): string {
  if (!id) return 'No model';
  const base = id.replace(/\[.*$/, '');
  return modelLabel(base);
}

/**
 * What to tell someone whose office server is not running. True for a person who ran `npx affice` and for a
 * contributor working from a clone (where the development page needs `npm run server`).
 */
export const SERVER_DOWN_ADVICE = 'Start it with npx affice. From a clone, use npm start (or npm run server while developing).';

export const SESSION_LABEL: Record<SessionStatus, string> = {
  off: 'Off',
  starting: 'Starting',
  ready: 'Ready',
  busy: 'Working',
  waiting: 'Waiting for you',
  error: 'Stopped with an error',
};

export const AGENT_LABEL: Record<AgentStatus, string> = {
  idle: 'Idle',
  thinking: 'Thinking',
  working: 'Working',
  waiting: 'Waiting for you',
  arriving: 'Arriving',
  done: 'Done',
  failed: 'Failed',
};

export const POLICY: Record<PermissionPolicy, { label: string; short: string; line: string }> = {
  ask: {
    label: 'Ask',
    short: 'Asks before acting',
    line: 'Every tool that needs permission waits for your approval in this chat.',
  },
  'accept-edits': {
    label: 'Accept edits',
    short: 'Accepts edits',
    line: 'File edits go through on their own; everything else waits for your approval.',
  },
  'read-only': {
    label: 'Read only',
    short: 'Read only',
    line: 'Reads inside the project, the board and subagents. No web, no writes, no commands.',
  },
};

/** 12s, 4m, 1h 5m, 3d. Counts to `until` when the thing has ended. */
export function elapsed(fromIso: string, untilIso: string | null = null, now = Date.now()): string {
  const from = Date.parse(fromIso);
  if (Number.isNaN(from)) return '';
  const until = untilIso ? Date.parse(untilIso) : now;
  const seconds = Math.max(0, Math.round(((Number.isNaN(until) ? now : until) - from) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

const timeFormat = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dayFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

/** 13:11 today, 16 Oct 13:11 before. */
export function clock(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay ? timeFormat.format(date) : `${dayFormat.format(date)} ${timeFormat.format(date)}`;
}

/** mcp__trella__claim_task reads as "trella claim_task". */
export function toolName(name: string): string {
  return name.startsWith('mcp__') ? name.slice(5).replace(/__/g, ' ') : name;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
