import type { ActivityEvent, Actor, Card } from './types';

export function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

export function relativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function absoluteTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function initials(actor: Actor): string {
  const parts = actor.name
    .replace(/^agent:/i, '')
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
}

/**
 * Counts `- [ ]` / `- [x]` lines so a card can show progress without the user
 * opening it. Returns null when the criteria are prose rather than a checklist.
 */
export function checklistProgress(markdown: string): { done: number; total: number } | null {
  const matches = markdown.match(/^\s*[-*]\s+\[( |x|X)\]/gm);
  if (!matches || matches.length === 0) return null;
  const done = matches.filter((line) => /\[[xX]\]/.test(line)).length;
  return { done, total: matches.length };
}

const ACTION_VERBS: Record<string, string> = {
  'card.created': 'created this card',
  'card.claimed': 'claimed this card',
  'card.unassigned': 'unassigned it',
  'card.archived': 'archived it',
  'card.restored': 'restored it from the archive',
  'card.commented': 'commented',
  'column.updated': 'updated a column',
};

export function describeActivity(entry: ActivityEvent): string {
  const changes = entry.changes ?? {};
  if (entry.action === 'card.moved') {
    return changes.status
      ? `moved it from ${String(changes.status.from)} to ${String(changes.status.to)}`
      : 'reordered it';
  }
  if (entry.action === 'card.assigned') {
    const to = changes.assignee?.to as Actor | null;
    return to ? `assigned it to ${to.name}` : 'assigned it';
  }
  if (entry.action === 'card.updated') {
    const fields = Object.keys(changes).map(humanField);
    return fields.length ? `updated ${listOf(fields)}` : 'updated this card';
  }
  return ACTION_VERBS[entry.action] ?? 'changed this card';
}

function humanField(field: string): string {
  switch (field) {
    case 'acceptanceCriteria':
      return 'the acceptance criteria';
    case 'title':
      return 'the title';
    case 'description':
      return 'the description';
    case 'priority':
      return 'priority';
    case 'labels':
      return 'labels';
    case 'assignee':
      return 'the assignee';
    default:
      return field;
  }
}

function listOf(items: string[]): string {
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

export function priorityLabel(priority: Card['priority']): string {
  return priority.charAt(0).toUpperCase() + priority.slice(1);
}

/** Deterministic neutral tint for an avatar. Decoration only — never a meaning. */
export function avatarTone(actorId: string): number {
  let hash = 0;
  for (let i = 0; i < actorId.length; i += 1) hash = (hash * 31 + actorId.charCodeAt(i)) >>> 0;
  return hash % 6;
}
