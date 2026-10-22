import { useCallback, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  defaultDropAnimationSideEffects,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type DropAnimation,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { Column } from './Column';
import { Button, Icon, inputClass } from './primitives';
import { cn } from '../lib/format';
import { Plus } from 'lucide-react';
import { CardGhost } from './CardTile';
import { useBoard } from '../lib/board';
import type { Card, ColumnColor } from '../lib/types';

interface Preview {
  cardId: string;
  status: string;
  index: number;
}

export interface BoardProps {
  filter: (card: Card) => boolean;
  onOpenCard: (id: string) => void;
  selectedCardId: string | null;
  onSelectCard: (id: string | null) => void;
  composerColumn: string | null;
  onComposerChange: (columnId: string | null) => void;
}

/**
 * A pointer inside a column wins; otherwise fall back to whichever droppable the
 * dragged rect overlaps most. Without the fallback, dragging past the bottom of a
 * short column finds nothing to drop on.
 */
const collisionDetection: CollisionDetection = (args) => {
  const pointer = pointerWithin(args);
  return pointer.length > 0 ? pointer : rectIntersection(args);
};

const dropAnimation: DropAnimation = {
  duration: 220,
  easing: 'cubic-bezier(0.2, 0, 0, 1)',
  sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: '0.4' } } }),
};

export function Board({
  filter,
  onOpenCard,
  selectedCardId,
  onSelectCard,
  composerColumn,
  onComposerChange,
}: BoardProps) {
  const { state, byColumn, moveCard, createCard, announce, updateColumn, removeColumn, addColumn } =
    useBoard();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);

  const sensors = useSensors(
    // A few pixels of travel before a drag starts, so a click still opens a card.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const columns = state.board?.columns ?? [];

  const filtered = useMemo(() => {
    const result: Record<string, Card[]> = {};
    for (const column of columns) result[column.id] = (byColumn[column.id] ?? []).filter(filter);
    return result;
  }, [byColumn, columns, filter]);

  /**
   * The lists as the user currently sees them, including the in-flight drag.
   *
   * Only the source and destination columns are rebuilt. Every other column keeps
   * its array identity, so its memoised `Column` — and every card inside it —
   * skips the render entirely. That is what keeps a drag cheap on a large board.
   */
  const rendered = useMemo(() => {
    if (!preview) return filtered;
    const card = state.cards[preview.cardId];
    if (!card) return filtered;

    const from = card.status;
    const to = preview.status;
    const next = { ...filtered };
    const withoutCard = (status: string) =>
      (filtered[status] ?? []).filter((entry) => entry.id !== preview.cardId);

    next[from] = withoutCard(from);
    const target = to === from ? [...next[from]!] : withoutCard(to);
    target.splice(
      Math.min(preview.index, target.length),
      0,
      to === card.status ? card : { ...card, status: to }
    );
    next[to] = target;
    return next;
  }, [filtered, preview, state.cards]);

  const columnName = useCallback(
    (status: string) => columns.find((column) => column.id === status)?.name ?? status,
    [columns]
  );

  const handleEditColumn = useCallback(
    async (columnId: string, patch: { name?: string; color?: ColumnColor; terminal?: boolean }) => {
      await updateColumn(columnId, patch);
    },
    [updateColumn]
  );

  const handleRemoveColumn = useCallback(
    async (columnId: string, moveCardsTo: string) => {
      await removeColumn(columnId, moveCardsTo);
      announce('Column removed. Its cards moved to the column you chose.');
    },
    [removeColumn, announce]
  );

  // Stable so an unrelated column never re-renders just because the board did.
  const handleCreate = useCallback(
    async (columnId: string, title: string) => {
      const card = await createCard({ title, status: columnId });
      announce(`Added ${card.title} to ${columnName(columnId)}.`);
    },
    [createCard, announce, columnName]
  );

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(String(event.active.id));
    setPreview(null);
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) return;
    const cardId = String(active.id);
    const overId = String(over.id);
    if (overId === cardId) return;

    let status: string;
    let index: number;

    if (overId.startsWith('column:')) {
      status = overId.slice('column:'.length);
      index = (filtered[status] ?? []).filter((card) => card.id !== cardId).length;
    } else {
      const overCard = state.cards[overId];
      if (!overCard) return;
      status = overCard.status;
      const base = (filtered[status] ?? []).filter((card) => card.id !== cardId);
      const overIndex = base.findIndex((card) => card.id === overId);
      if (overIndex === -1) return;

      const activeRect = active.rect.current.translated;
      const below =
        activeRect !== null &&
        activeRect.top + activeRect.height / 2 > over.rect.top + over.rect.height / 2;
      index = below ? overIndex + 1 : overIndex;
    }

    setPreview((current) =>
      current && current.status === status && current.index === index && current.cardId === cardId
        ? current
        : { cardId, status, index }
    );
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const cardId = String(event.active.id);
    const target = preview;
    setActiveId(null);
    setPreview(null);
    if (!target || target.cardId !== cardId) return;

    const card = state.cards[cardId];
    if (!card) return;
    const unchanged =
      card.status === target.status &&
      (filtered[card.status] ?? []).findIndex((entry) => entry.id === cardId) === target.index;
    if (unchanged) return;

    announce(`Moved ${card.title} to ${columnName(target.status)}, position ${target.index + 1}.`);
    void moveCard(cardId, target.status, target.index);
  };

  const announcements: Announcements = {
    onDragStart: ({ active }) => {
      const card = state.cards[String(active.id)];
      if (!card) return undefined;
      const list = filtered[card.status] ?? [];
      const position = list.findIndex((entry) => entry.id === card.id) + 1;
      return `Picked up ${card.title}. Position ${position} of ${list.length} in ${columnName(card.status)}. Use the arrow keys to move it, space to drop, escape to cancel.`;
    },
    onDragOver: () =>
      preview
        ? `Now at position ${preview.index + 1} in ${columnName(preview.status)}.`
        : undefined,
    onDragEnd: ({ active }) => {
      const card = state.cards[String(active.id)];
      return preview && card
        ? `Dropped ${card.title} into ${columnName(preview.status)} at position ${preview.index + 1}.`
        : 'Drop cancelled.';
    },
    onDragCancel: ({ active }) => {
      const card = state.cards[String(active.id)];
      return card ? `Cancelled. ${card.title} is back where it was.` : 'Cancelled.';
    },
  };

  /** Arrow-key navigation between cards. dnd-kit owns the keyboard while dragging. */
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (activeId) return;
    const key = event.key;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)) return;

    const current = selectedCardId ? state.cards[selectedCardId] : undefined;
        let nextId: string | undefined;

    if (!current) {
      nextId = columns.flatMap((column) => rendered[column.id] ?? [])[0]?.id;
    } else if (key === 'ArrowUp' || key === 'ArrowDown') {
      const list = rendered[current.status] ?? [];
      const at = list.findIndex((card) => card.id === current.id);
      nextId = list[at + (key === 'ArrowDown' ? 1 : -1)]?.id;
    } else {
      const columnIndex = columns.findIndex((column) => column.id === current.status);
      const list = rendered[current.status] ?? [];
      const row = list.findIndex((card) => card.id === current.id);
      const step = key === 'ArrowRight' ? 1 : -1;
      for (let i = columnIndex + step; i >= 0 && i < columns.length; i += step) {
        const candidates = rendered[columns[i]!.id] ?? [];
        if (candidates.length > 0) {
          nextId = (candidates[Math.min(row, candidates.length - 1)] ?? candidates[0])!.id;
          break;
        }
      }
    }

    if (!nextId) return;
    event.preventDefault();
    onSelectCard(nextId);
    boardRef.current
      ?.querySelector<HTMLElement>(`[data-card="${CSS.escape(nextId)}"] [role="button"]`)
      ?.focus();
  };

  const activeCard = activeId ? state.cards[activeId] : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      accessibility={{
        announcements,
        screenReaderInstructions: {
          draggable:
            'Press space to pick this card up. Use the arrow keys to move it between columns and ' +
            'positions, space again to drop it, and escape to cancel. Press enter to open it instead.',
        },
      }}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={() => {
        setActiveId(null);
        setPreview(null);
      }}
    >
      <div
        ref={boardRef}
        onKeyDown={handleKeyDown}
        className="scroll-quiet flex h-full min-h-0 gap-4 overflow-x-auto px-6 pb-6"
      >
        {columns.map((column) => (
          <div
            key={column.id}
            data-column={column.id}
            className="h-full min-w-[16.5rem] flex-1 basis-[19rem] py-1"
          >
            <Column
              column={column}
              columns={columns}
              cards={rendered[column.id] ?? []}
              selectedCardId={selectedCardId}
              touched={state.touched}
              pending={state.pending}
              isDropTarget={preview?.status === column.id}
              composerOpen={composerColumn === column.id}
              onOpenCard={onOpenCard}
              onFocusCard={onSelectCard}
              onComposerChange={onComposerChange}
              onCreate={handleCreate}
              onEditColumn={handleEditColumn}
              onRemoveColumn={handleRemoveColumn}
            />
          </div>
        ))}
        <AddColumn onAdd={(name) => addColumn({ name })} />
      </div>

      <DragOverlay dropAnimation={dropAnimation}>
        {activeCard ? <CardGhost card={activeCard} /> : null}
      </DragOverlay>
    </DndContext>
  );
}

/** Adding a column is part of the board, not a settings screen somewhere else. */
function AddColumn({ onAdd }: { onAdd: (name: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');

  if (!open) {
    return (
      <div className="shrink-0 py-1 pe-2">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="motion-lift text-caption text-ink-faint hover:text-ink-soft border-line hover:border-line-strong flex h-full w-32 flex-col items-center justify-center gap-1.5 rounded-(--radius-column) border border-dashed"
        >
          <Icon icon={Plus} size={16} />
          Add column
        </button>
      </div>
    );
  }

  return (
    <div className="bg-sunken h-full w-[16.5rem] shrink-0 rounded-(--radius-column) p-3">
      <label className="text-micro text-ink-faint" htmlFor="new-column-name">
        New column
      </label>
      <input
        id="new-column-name"
        autoFocus
        value={name}
        placeholder="Blocked"
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && name.trim()) {
            event.preventDefault();
            void onAdd(name.trim());
            setName('');
            setOpen(false);
          }
          if (event.key === 'Escape') setOpen(false);
        }}
        className={cn(inputClass, 'mt-2')}
      />
      <div className="mt-2 flex gap-2">
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            if (!name.trim()) return;
            void onAdd(name.trim());
            setName('');
            setOpen(false);
          }}
        >
          Add column
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
