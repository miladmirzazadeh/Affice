import { memo } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, MessageSquare, ListChecks } from 'lucide-react';
import { ActorAvatar, Chip, Icon, PriorityGlyph } from './primitives';
import { checklistProgress, cn, relativeTime } from '../lib/format';
import type { Card } from '../lib/types';

export interface CardTileProps {
  card: Card;
  columnName: string;
  index: number;
  total: number;
  selected: boolean;
  touched: boolean;
  pending: boolean;
  onOpen: (id: string) => void;
  onFocus: (id: string) => void;
}

/**
 * The card. Title first and largest, everything else demoted to caption-sized
 * tertiary ink, and no metadata rendered unless it has a value.
 */
function CardTileBase({
  card,
  columnName,
  index,
  total,
  selected,
  touched,
  pending,
  onOpen,
  onFocus,
}: CardTileProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
    data: { type: 'card', status: card.status },
  });

  const checklist = checklistProgress(card.acceptanceCriteria);
  const hasMeta =
    card.priority !== 'medium' ||
    card.assignee !== null ||
    card.commentCount > 0 ||
    checklist !== null;

  return (
    <li
      ref={setNodeRef}
      data-card={card.id}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn('relative list-none', isDragging && 'opacity-0')}
    >
      <article
        {...attributes}
        {...listeners}
        aria-roledescription="Draggable card"
        aria-label={`${card.title}. ${card.priority} priority. ${columnName}, position ${index + 1} of ${total}.`}
        onFocus={() => onFocus(card.id)}
        onClick={() => onOpen(card.id)}
        // Enter opens the card; every other key belongs to the drag sensor, which
        // owns space to pick up, arrows to move, and escape to cancel.
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            onOpen(card.id);
            return;
          }
          listeners?.onKeyDown?.(event);
        }}
        className={cn(
          'group relative isolate block w-full cursor-grab overflow-hidden text-start',
          'surface-card motion-lift rounded-(--radius-card) px-3 py-2.5',
          'hover:shadow-[var(--lift-2)] active:cursor-grabbing',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring)',
          selected && 'shadow-[var(--lift-2)] outline-2 outline-offset-2 outline-(--focus-ring)',
          pending && 'opacity-70',
          touched && 'motion-touched'
        )}
      >
        <div className="flex items-start gap-2">
          <h3 className="text-ui text-ink min-w-0 flex-1 [text-wrap:balance] break-words">
            {card.title}
          </h3>
          <Icon
            icon={GripVertical}
            size={14}
            className="text-ink-faint/0 group-hover:text-ink-faint/70 mt-0.5 transition-colors duration-120"
          />
        </div>

        {hasMeta && (
          <div className="text-caption text-ink-faint mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
            {card.priority !== 'medium' && <PriorityGlyph priority={card.priority} />}
            {checklist && (
              <span className="inline-flex items-center gap-1 tabular-nums">
                <Icon icon={ListChecks} size={14} />
                {checklist.done}/{checklist.total}
              </span>
            )}
            {card.commentCount > 0 && (
              <span className="inline-flex items-center gap-1 tabular-nums">
                <Icon icon={MessageSquare} size={14} />
                {card.commentCount}
                <span className="sr-only">
                  {card.commentCount === 1 ? 'comment' : 'comments'}
                </span>
              </span>
            )}
            {card.assignee && (
              <span className="inline-flex items-center gap-1.5">
                <ActorAvatar actor={card.assignee} />
                <span className="max-w-28 truncate">{card.assignee.name}</span>
              </span>
            )}
            {card.lastActor?.type === 'agent' && !card.assignee && (
              <span className="inline-flex items-center gap-1.5">
                <ActorAvatar actor={card.lastActor} />
                <span>{relativeTime(card.updatedAt)}</span>
              </span>
            )}
          </div>
        )}

        {card.labels.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {card.labels.slice(0, 4).map((label) => (
              <Chip key={label}>{label}</Chip>
            ))}
            {card.labels.length > 4 && <Chip>+{card.labels.length - 4}</Chip>}
          </div>
        )}
      </article>
    </li>
  );
}

export const CardTile = memo(CardTileBase);

/** What the pointer carries during a drag: the same card, lifted. */
export function CardGhost({ card }: { card: Card }) {
  return (
    <article
      className={cn(
        'surface-card w-72 rotate-[1.5deg] scale-[1.02] rounded-(--radius-card) px-3 py-2.5',
        'shadow-[var(--lift-3)] cursor-grabbing'
      )}
    >
      <h3 className="text-ui text-ink [text-wrap:balance] break-words">{card.title}</h3>
      {(card.priority !== 'medium' || card.assignee) && (
        <div className="text-caption text-ink-faint mt-1.5 flex items-center gap-2.5">
          {card.priority !== 'medium' && <PriorityGlyph priority={card.priority} />}
          {card.assignee && <ActorAvatar actor={card.assignee} />}
        </div>
      )}
    </article>
  );
}
