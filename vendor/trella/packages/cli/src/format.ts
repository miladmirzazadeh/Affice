import type { ActivityEvent, Card, CardSummary, Column, Comment } from '@trella/core';

const supportsColor =
  process.stdout.isTTY && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb';

const ESC = '\u001B';
const wrap = (code: string) => (text: string) =>
  supportsColor ? `${ESC}[${code}m${text}${ESC}[0m` : text;

export const style = {
  bold: wrap('1'),
  dim: wrap('2'),
  accent: wrap('36'),
  warn: wrap('33'),
  danger: wrap('31'),
  agent: wrap('35'),
};

const PRIORITY_MARK: Record<string, string> = {
  low: '▁',
  medium: '▄',
  high: '▆',
  urgent: '█',
};

export function priorityMark(priority: string): string {
  const mark = PRIORITY_MARK[priority] ?? '▄';
  return priority === 'urgent' ? style.danger(mark) : style.dim(mark);
}

export function actorLabel(actor: { type: string; name: string } | null): string {
  if (!actor) return style.dim('unassigned');
  return actor.type === 'agent' ? style.agent(`⬡ ${actor.name}`) : `▢ ${actor.name}`;
}

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toISOString().slice(0, 10);
}

/** Groups cards under their column, in board order. */
export function formatBoard(columns: Column[], cards: CardSummary[]): string {
  const lines: string[] = [];
  for (const column of columns) {
    const inColumn = cards
      .filter((card) => card.status === column.id)
      .sort((a, b) => a.position - b.position);
    lines.push(
      `${style.bold(column.name)} ${style.dim(`(${inColumn.length})`)}${
        column.terminal ? style.dim(' · done') : ''
      }`
    );
    if (inColumn.length === 0) {
      lines.push(style.dim('  nothing here yet'));
    } else {
      for (const card of inColumn) lines.push(`  ${formatCardLine(card)}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export function formatCardLine(card: CardSummary): string {
  const bits = [
    priorityMark(card.priority),
    style.accent(card.id.padEnd(7)),
    truncate(card.title, 56).padEnd(56),
    style.dim(`r${card.revision}`.padEnd(5)),
    actorLabel(card.assignee),
  ];
  if (card.labels.length) bits.push(style.dim(card.labels.map((l) => `#${l}`).join(' ')));
  if (card.commentCount > 0)
    bits.push(style.dim(`${card.commentCount} comment${card.commentCount === 1 ? '' : 's'}`));
  if (card.archived) bits.push(style.warn('archived'));
  return bits.join('  ');
}

export function formatCardDetail(
  card: Card,
  comments: Comment[],
  activity: ActivityEvent[]
): string {
  const lines: string[] = [];
  lines.push(`${style.accent(card.id)}  ${style.bold(card.title)}`);
  lines.push('');
  lines.push(
    [
      `${label('status')}${card.status}`,
      `${label('priority')}${card.priority}`,
      `${label('revision')}${card.revision}`,
    ].join('\n')
  );
  lines.push(`${label('assignee')}${stripStyle(actorLabel(card.assignee))}`);
  lines.push(`${label('creator')}${card.creator ? stripStyle(actorLabel(card.creator)) : '—'}`);
  lines.push(`${label('last change')}${card.lastActor ? stripStyle(actorLabel(card.lastActor)) : '—'} · ${relativeTime(card.updatedAt)}`);
  if (card.labels.length) lines.push(`${label('labels')}${card.labels.join(', ')}`);
  if (card.archived) lines.push(`${label('archived')}yes`);

  if (card.description.trim()) {
    lines.push('', style.bold('Description'), indent(card.description));
  }
  if (card.acceptanceCriteria.trim()) {
    lines.push('', style.bold('Acceptance criteria'), indent(card.acceptanceCriteria));
  }
  if (comments.length) {
    lines.push('', style.bold(`Comments (${comments.length})`));
    for (const comment of comments) {
      lines.push(`  ${actorLabel(comment.actor)} ${style.dim(relativeTime(comment.createdAt))}`);
      lines.push(indent(comment.body, '    '));
    }
  }
  if (activity.length) {
    lines.push('', style.bold('Activity'));
    for (const entry of activity.slice(-10)) lines.push(`  ${formatActivityLine(entry)}`);
  }
  return lines.join('\n');
}

export function formatActivityLine(entry: ActivityEvent): string {
  const when = style.dim(relativeTime(entry.createdAt).padEnd(9));
  const who = actorLabel(entry.actor);
  return `${when} ${who} ${style.dim('·')} ${describeAction(entry)}`;
}

function describeAction(entry: ActivityEvent): string {
  const changes = entry.changes ?? {};
  switch (entry.action) {
    case 'card.created':
      return `created ${entry.cardId ?? ''}`.trim();
    case 'card.moved':
      return changes.status
        ? `moved ${String(changes.status.from)} → ${String(changes.status.to)}`
        : 'reordered';
    case 'card.claimed':
      return 'claimed the card';
    case 'card.assigned':
      return `assigned to ${(changes.assignee?.to as { name?: string } | null)?.name ?? 'someone'}`;
    case 'card.unassigned':
      return 'unassigned';
    case 'card.commented':
      return `commented: ${truncate(String(changes.comment?.to ?? ''), 60)}`;
    case 'card.archived':
      return 'archived';
    case 'card.restored':
      return 'restored from the archive';
    case 'column.updated':
      return 'updated a column';
    default: {
      const fields = Object.keys(changes);
      return fields.length ? `updated ${fields.join(', ')}` : 'updated the card';
    }
  }
}

function label(text: string): string {
  return style.dim(`${text}`.padEnd(14));
}

function indent(text: string, prefix = '  '): string {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

export function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function stripStyle(text: string): string {
  return text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
}
