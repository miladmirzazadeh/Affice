import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Check, MoreHorizontal, Plus, Trash2, X } from 'lucide-react';
import { CardTile } from './CardTile';
import { ColorPicker } from './BoardSwitcher';
import { Button, Icon, IconButton, inputClass } from './primitives';
import { cn } from '../lib/format';
import type { Card, Column as ColumnModel, ColumnColor } from '../lib/types';

export const RAIL: Record<string, string> = {
  stone: 'bg-column-stone-mark',
  amber: 'bg-column-amber-mark',
  moss: 'bg-column-moss-mark',
  sky: 'bg-column-sky-mark',
  indigo: 'bg-column-indigo-mark',
  plum: 'bg-column-plum-mark',
  rose: 'bg-column-rose-mark',
};

/** Cards mounted per column before scrolling reveals more. */
const CARD_WINDOW = 24;

const EMPTY_COPY: Record<string, string> = {
  backlog: 'Anything you might do, in no particular order.',
  'to-do': 'Cards with enough detail for someone to pick up.',
  'in-progress': 'Work in progress. One card per actor is usually enough.',
  review: 'Finished work waiting for a second pair of eyes.',
  done: 'Cards that are finished. Nothing to do here.',
  failed: 'Work that was stopped or did not pan out.',
};

export interface ColumnProps {
  column: ColumnModel;
  columns: ColumnModel[];
  cards: Card[];
  selectedCardId: string | null;
  touched: Record<string, number>;
  pending: Record<string, true>;
  isDropTarget: boolean;
  composerOpen: boolean;
  onOpenCard: (id: string) => void;
  onFocusCard: (id: string) => void;
  onComposerChange: (columnId: string | null) => void;
  onCreate: (columnId: string, title: string) => Promise<void>;
  onEditColumn: (
    columnId: string,
    patch: { name?: string; color?: ColumnColor; terminal?: boolean }
  ) => Promise<void>;
  onRemoveColumn: (columnId: string, moveCardsTo: string) => Promise<void>;
}

function ColumnBase({
  column,
  columns,
  cards,
  selectedCardId,
  touched,
  pending,
  isDropTarget,
  composerOpen,
  onOpenCard,
  onFocusCard,
  onComposerChange,
  onCreate,
  onEditColumn,
  onRemoveColumn,
}: ColumnProps) {
  const { setNodeRef } = useDroppable({
    id: `column:${column.id}`,
    data: { type: 'column', status: column.id },
  });
  const [scrolled, setScrolled] = useState(false);
  const [windowSize, setWindowSize] = useState(CARD_WINDOW);
  const [editing, setEditing] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // Only the cards near the scroll position are mounted. Each mounted card is a
  // drag-and-drop participant, so a column of 200 would make every drag frame
  // pay for cards nobody can see.
  const visible = useMemo(() => cards.slice(0, windowSize), [cards, windowSize]);
  const items = useMemo(() => visible.map((card) => card.id), [visible]);
  const hidden = cards.length - visible.length;

  return (
    <section
      aria-labelledby={`column-${column.id}-name`}
      className={cn(
        'flex h-full w-full min-w-[16.5rem] flex-col overflow-hidden rounded-(--radius-column)',
        'bg-sunken motion-lift',
        isDropTarget && 'ring-2 ring-(--accent-solid)/35'
      )}
    >
      <div
        aria-hidden="true"
        className={cn('h-[3px] w-full', RAIL[column.color] ?? RAIL.stone, isDropTarget && 'h-1')}
      />

      <header
        className={cn('flex items-center gap-2 px-3 pt-2.5 pb-2', scrolled && 'border-line border-b')}
      >
        <span
          aria-hidden="true"
          className={cn('size-1.5 shrink-0 rounded-full', RAIL[column.color] ?? RAIL.stone)}
        />
        <h2 id={`column-${column.id}-name`} className="text-micro text-ink truncate">
          {column.name}
        </h2>
        <span className="text-caption text-ink-faint tabular-nums">{cards.length}</span>
        <div className="flex-1" />
        <IconButton
          icon={MoreHorizontal}
          label={`Edit the ${column.name} column`}
          onClick={() => setEditing((value) => !value)}
          active={editing}
        />
        <IconButton
          icon={Plus}
          label={`Add a card to ${column.name}`}
          onClick={() => onComposerChange(composerOpen ? null : column.id)}
        />
      </header>

      {editing && (
        <ColumnEditor
          column={column}
          columns={columns}
          cardCount={cards.length}
          onClose={() => setEditing(false)}
          onEdit={onEditColumn}
          onRemove={onRemoveColumn}
        />
      )}

      <div
        ref={(node) => {
          setNodeRef(node);
          listRef.current = node;
        }}
        onScroll={(event) => {
          const target = event.currentTarget;
          setScrolled(target.scrollTop > 2);
          if (target.scrollHeight - target.scrollTop - target.clientHeight < 600) {
            setWindowSize((size) => (size < cards.length ? size + CARD_WINDOW : size));
          }
        }}
        className="scroll-quiet flex-1 overflow-y-auto overscroll-y-contain px-1.5 pb-1.5"
      >
        <SortableContext items={items} strategy={verticalListSortingStrategy}>
          <ul className="flex flex-col gap-3 p-1.5">
            {visible.map((card, index) => (
              <CardTile
                key={card.id}
                card={card}
                columnName={column.name}
                index={index}
                total={cards.length}
                selected={selectedCardId === card.id}
                touched={touched[card.id] !== undefined}
                pending={pending[card.id] === true}
                onOpen={onOpenCard}
                onFocus={onFocusCard}
              />
            ))}
          </ul>
        </SortableContext>

        {hidden > 0 && (
          <div className="px-1.5 pb-1.5">
            <Button
              size="sm"
              variant="ghost"
              className="w-full"
              onClick={() => setWindowSize((size) => size + Math.max(hidden, CARD_WINDOW))}
            >
              Show {hidden} more card{hidden === 1 ? '' : 's'}
            </Button>
          </div>
        )}

        {cards.length === 0 && !composerOpen && (
          <div className="border-line mx-1.5 rounded-(--radius-card) border border-dashed px-3 py-5 text-center">
            <p className="text-caption text-ink-faint [text-wrap:pretty]">
              {EMPTY_COPY[column.id] ?? `Nothing in ${column.name} yet.`}
            </p>
            <Button
              size="sm"
              variant="ghost"
              className="mt-2"
              onClick={() => onComposerChange(column.id)}
            >
              <Icon icon={Plus} size={14} />
              Add a card
            </Button>
          </div>
        )}
      </div>

      {composerOpen && (
        <Composer
          columnName={column.name}
          onCancel={() => onComposerChange(null)}
          onSubmit={(title) => onCreate(column.id, title)}
        />
      )}
    </section>
  );
}

export const Column = memo(ColumnBase);

/** Renaming, recolouring and removing a column, in the column itself. */
function ColumnEditor({
  column,
  columns,
  cardCount,
  onClose,
  onEdit,
  onRemove,
}: {
  column: ColumnModel;
  columns: ColumnModel[];
  cardCount: number;
  onClose: () => void;
  onEdit: (
    columnId: string,
    patch: { name?: string; color?: ColumnColor; terminal?: boolean }
  ) => Promise<void>;
  onRemove: (columnId: string, moveCardsTo: string) => Promise<void>;
}) {
  const [name, setName] = useState(column.name);
  const [confirming, setConfirming] = useState(false);
  const others = columns.filter((entry) => entry.id !== column.id);
  const [destination, setDestination] = useState(others[0]?.id ?? '');

  return (
    <div className="border-line bg-raised border-b px-3 py-3">
      <div className="flex items-center gap-2">
        <input
          value={name}
          aria-label="Column name"
          onChange={(event) => setName(event.target.value)}
          onBlur={() => name.trim() && name !== column.name && void onEdit(column.id, { name: name.trim() })}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && name.trim()) {
              event.preventDefault();
              void onEdit(column.id, { name: name.trim() });
            }
            if (event.key === 'Escape') {
              setName(column.name);
              onClose();
            }
          }}
          className={cn(inputClass, 'h-8 py-0')}
        />
        <IconButton icon={X} label="Close column settings" onClick={onClose} />
      </div>

      <div className="mt-3">
        <ColorPicker value={column.color} onChange={(color) => void onEdit(column.id, { color })} />
      </div>

      <label className="text-caption text-ink-soft mt-3 flex items-center gap-2">
        <input
          type="checkbox"
          checked={column.terminal}
          onChange={(event) => void onEdit(column.id, { terminal: event.target.checked })}
          className="size-4"
        />
        Cards here count as finished
      </label>

      {others.length > 0 && (
        <div className="border-line mt-3 border-t pt-3">
          {confirming ? (
            <div className="space-y-2">
              <p className="text-caption text-ink-soft [text-wrap:pretty]">
                {cardCount === 0
                  ? `Remove "${column.name}"?`
                  : `Remove "${column.name}" and move its ${cardCount} card${cardCount === 1 ? '' : 's'} to:`}
              </p>
              {cardCount > 0 && (
                <select
                  aria-label="Move the cards to"
                  value={destination}
                  onChange={(event) => setDestination(event.target.value)}
                  className={cn(inputClass, 'h-8 py-0')}
                >
                  {others.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              )}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => {
                    void onRemove(column.id, destination);
                    onClose();
                  }}
                >
                  <Icon icon={Check} size={14} beside="semibold" />
                  Remove column
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                  Keep it
                </Button>
              </div>
            </div>
          ) : (
            <Button size="sm" variant="ghost" className="-ms-3" onClick={() => setConfirming(true)}>
              <Icon icon={Trash2} size={14} />
              Remove column
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Title first, details later: the fastest possible path from "I thought of
 * something" to "it is on the board".
 */
function Composer({
  columnName,
  onCancel,
  onSubmit,
}: {
  columnName: string;
  onCancel: () => void;
  onSubmit: (title: string) => Promise<void>;
}) {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = async () => {
    const value = title.trim();
    if (!value) {
      setError('Give the card a title first.');
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(value);
      setTitle('');
      inputRef.current?.focus();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Unable to add the card.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-line border-t p-2">
      <textarea
        ref={inputRef}
        value={title}
        rows={2}
        aria-label={`New card in ${columnName}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? 'composer-error' : undefined}
        placeholder="What needs doing?"
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            void submit();
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
        className={cn(inputClass, 'resize-none')}
      />
      {error && (
        <p id="composer-error" role="alert" className="text-caption text-danger mt-1.5">
          {error}
        </p>
      )}
      <div className="mt-2 flex items-center gap-3">
        <Button size="sm" variant="primary" disabled={busy} onClick={() => void submit()}>
          <Icon icon={Check} size={14} beside="semibold" />
          {busy ? 'Adding…' : 'Add card'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          <Icon icon={X} size={14} />
          Cancel
        </Button>
      </div>
    </div>
  );
}
