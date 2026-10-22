import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Archive, ArchiveRestore, Check, MessageSquare, UserPlus, UserMinus, X } from 'lucide-react';
import { ApiError, api } from '../lib/api';
import { useBoard } from '../lib/board';
import {
  absoluteTime,
  checklistProgress,
  cn,
  describeActivity,
  relativeTime,
} from '../lib/format';
import { ActorAvatar, Button, Chip, Field, Icon, IconButton, PriorityGlyph, inputClass } from './primitives';
import { PRIORITIES, type ActivityEvent, type Card, type Comment, type Priority } from '../lib/types';

interface Conflict {
  field: string;
  label: string;
  mine: string;
  theirs: string;
  current: Card;
}

export function CardDetail({ cardId, onClose }: { cardId: string; onClose: () => void }) {
  const { state, updateCard, claimCard, setArchived, addComment, announce, toast } = useBoard();
  const card = state.cards[cardId];
  const panelRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const headingId = useId();

  const [comments, setComments] = useState<Comment[]>([]);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [showAllActivity, setShowAllActivity] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 899px)').matches);

  useEffect(() => {
    const query = window.matchMedia('(max-width: 899px)');
    const listen = () => setNarrow(query.matches);
    query.addEventListener('change', listen);
    return () => query.removeEventListener('change', listen);
  }, []);

  // Remember where focus came from and move it into the panel.
  useEffect(() => {
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
  }, [cardId]);

  // On a narrow viewport the panel is modal, so the board behind it is inert.
  useEffect(() => {
    const shell = document.getElementById('app-shell');
    if (!shell) return;
    if (narrow) shell.setAttribute('inert', '');
    return () => shell.removeAttribute('inert');
  }, [narrow]);

  // Put focus back on close. Declared after the inert effect so its cleanup runs
  // once the board is no longer inert; an inert element cannot take focus.
  useEffect(() => () => returnFocusRef.current?.focus?.(), [cardId]);

  const refresh = useCallback(async () => {
    try {
      const detail = await api.card(cardId);
      setComments(detail.card.comments);
      setActivity(detail.activity);
    } catch {
      // The card itself is already on screen from the board state; the comments
      // and activity simply stay as they were until the next successful read.
    }
  }, [cardId]);

  useEffect(() => {
    void refresh();
  }, [refresh, card?.updatedAt]);

  /**
   * `basedOn` is the revision the draft started from, not the card's current
   * revision. That distinction is the whole point: if another actor saved while
   * this field was open, the write is rejected and the user chooses, rather than
   * quietly replacing their text.
   */
  const save = useCallback(
    async (
      field: string,
      label: string,
      patch: Record<string, unknown>,
      mine: string,
      basedOn?: number
    ) => {
      if (!card) return;
      try {
        await updateCard(cardId, patch as never, basedOn ?? card.revision);
        setConflict(null);
      } catch (error) {
        if (error instanceof ApiError && error.isConflict && error.body.current) {
          const theirs = String(
            (error.body.current as unknown as Record<string, unknown>)[field] ?? ''
          );
          if (theirs === mine) {
            setConflict(null);
            return;
          }
          setConflict({ field, label, mine, theirs, current: error.body.current });
          announce(`${label} was changed by someone else. Choose which version to keep.`);
        } else {
          toast(error instanceof Error ? error.message : 'Unable to save.', 'error');
        }
      }
    },
    [card, cardId, updateCard, announce, toast]
  );

  if (!card) {
    return null;
  }

  const checklist = checklistProgress(card.acceptanceCriteria);
  const isMine = card.assignee?.id === state.identity?.id;
  const visibleActivity = showAllActivity ? activity : activity.slice(-5);

  const panel = (
    <>
      {narrow && (
        <div
          aria-hidden="true"
          onClick={onClose}
          className="motion-fade fixed inset-0 z-40 bg-bone-1000/40"
        />
      )}

      <aside
        ref={panelRef}
        tabIndex={-1}
        role={narrow ? 'dialog' : 'complementary'}
        aria-modal={narrow ? true : undefined}
        aria-labelledby={headingId}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
        }}
        className={cn(
          'motion-panel bg-overlay z-50 flex flex-col overflow-hidden',
          'shadow-[var(--lift-panel)] focus-visible:outline-none',
          narrow
            ? 'fixed inset-y-0 end-0 w-full max-w-[34rem]'
            : 'h-full w-[min(34rem,42vw)] shrink-0 rounded-(--radius-panel) my-1 me-6'
        )}
      >
        <header className="border-line flex items-start gap-3 border-b px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="text-ink-faint flex items-center gap-2 font-mono text-[11px]">
              <span>{card.id}</span>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">revision {card.revision}</span>
              {card.archived && <Chip tone="caution">Archived</Chip>}
            </div>
            <EditableTitle
              id={headingId}
              value={card.title}
              revision={card.revision}
              onSave={(value, basedOn) =>
                save('title', 'The title', { title: value }, value, basedOn)
              }
            />
          </div>
          <IconButton icon={X} label="Close card" onClick={onClose} />
        </header>

        {conflict && (
          <ConflictBanner
            conflict={conflict}
            onKeepMine={async () => {
              await updateCard(
                cardId,
                { [conflict.field]: conflict.mine } as never,
                conflict.current.revision
              );
              setConflict(null);
              announce('Kept your version.');
            }}
            onUseTheirs={() => {
              setConflict(null);
              announce('Kept their version.');
            }}
          />
        )}

        <div className="scroll-quiet flex-1 space-y-6 overflow-y-auto overscroll-contain px-5 py-5">
          <section className="flex flex-wrap items-center gap-x-6 gap-y-4">
            <StatusControl card={card} />
            <PriorityControl
              card={card}
              onChange={(priority) =>
                save('priority', 'Priority', { priority }, priority)
              }
            />
            <div className="flex flex-col gap-1.5">
              <span className="text-micro text-ink-faint">Assignee</span>
              {card.assignee ? (
                <div className="flex items-center gap-2">
                  <ActorAvatar actor={card.assignee} size={20} />
                  <span className="text-ui text-ink">{card.assignee.name}</span>
                  <IconButton
                    icon={UserMinus}
                    label={`Unassign ${card.assignee.name}`}
                    onClick={() => void save('assignee', 'The assignee', { assignee: null }, '')}
                  />
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={async () => {
                    await claimCard(cardId);
                    announce('You claimed this card.');
                  }}
                >
                  <Icon icon={UserPlus} size={14} />
                  Claim this card
                </Button>
              )}
            </div>
          </section>

          <EditableText
            label="Description"
            placeholder="What is this card about? Anything the next person — or agent — needs to know."
            value={card.description}
            revision={card.revision}
            rows={5}
            onSave={(value, basedOn) =>
              save('description', 'The description', { description: value }, value, basedOn)
            }
          />

          <EditableText
            label="Acceptance criteria"
            placeholder="What has to be true to call this done? Start a line with - [ ] to make a checklist."
            value={card.acceptanceCriteria}
            revision={card.revision}
            rows={4}
            suffix={
              checklist ? (
                <span className="text-caption text-ink-faint tabular-nums">
                  {checklist.done} of {checklist.total} done
                </span>
              ) : null
            }
            onSave={(value, basedOn) =>
              save(
                'acceptanceCriteria',
                'The acceptance criteria',
                { acceptanceCriteria: value },
                value,
                basedOn
              )
            }
          />

          <LabelEditor
            labels={card.labels}
            onSave={(labels) =>
              save('labels', 'Labels', { labels }, labels.join(', '))
            }
          />

          <Comments comments={comments} onAdd={async (body) => {
            await addComment(cardId, body);
            await refresh();
            announce('Comment added.');
          }} />

          <section aria-labelledby={`${headingId}-activity`}>
            <h3 id={`${headingId}-activity`} className="text-micro text-ink-faint mb-3">
              Activity
            </h3>
            {activity.length === 0 ? (
              <p className="text-caption text-ink-faint">Nothing has happened to this card yet.</p>
            ) : (
              <ol className="space-y-2.5">
                {visibleActivity.map((entry) => (
                  <li key={entry.id} className="flex items-start gap-2.5">
                    <ActorAvatar actor={entry.actor} />
                    <p className="text-caption text-ink-faint [text-wrap:pretty]">
                      <span className="text-ink-soft font-medium">{entry.actor.name}</span>{' '}
                      {describeActivity(entry)}{' '}
                      <time dateTime={entry.createdAt} title={absoluteTime(entry.createdAt)}>
                        {relativeTime(entry.createdAt)}
                      </time>
                    </p>
                  </li>
                ))}
              </ol>
            )}
            {activity.length > 5 && (
              <Button
                size="sm"
                variant="ghost"
                className="mt-2 -ms-3"
                onClick={() => setShowAllActivity((value) => !value)}
              >
                {showAllActivity ? 'Show recent activity only' : `Show all ${activity.length} entries`}
              </Button>
            )}
          </section>
        </div>

        <footer className="border-line flex items-center gap-3 border-t px-5 py-3">
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              await setArchived(cardId, !card.archived);
              announce(card.archived ? 'Card restored.' : 'Card archived.');
              if (!card.archived) onClose();
            }}
          >
            <Icon icon={card.archived ? ArchiveRestore : Archive} size={14} />
            {card.archived ? 'Restore card' : 'Archive card'}
          </Button>
          <span className="text-caption text-ink-faint ms-auto">
            {card.lastActor ? (
              <>
                Last changed by {card.lastActor.name}{' '}
                <time dateTime={card.updatedAt} title={absoluteTime(card.updatedAt)}>
                  {relativeTime(card.updatedAt)}
                </time>
              </>
            ) : (
              <>Created {relativeTime(card.createdAt)}</>
            )}
            {isMine && ' · assigned to you'}
          </span>
        </footer>
      </aside>
    </>
  );

  // The narrow panel is modal and #app-shell is inert behind it, so it must live
  // outside #app-shell; inside it, the panel itself would be inert and unclickable.
  return narrow ? createPortal(panel, document.body) : panel;
}

/* --------------------------------------------------------------------------- */

function ConflictBanner({
  conflict,
  onKeepMine,
  onUseTheirs,
}: {
  conflict: Conflict;
  onKeepMine: () => Promise<void>;
  onUseTheirs: () => void;
}) {
  return (
    <div
      role="alert"
      className="bg-caution-soft border-caution-line text-ink border-b px-5 py-4"
    >
      <p className="text-ui text-caution">
        {conflict.label.toLowerCase().startsWith('the') ? conflict.label : `${conflict.label}`} changed
        while you were editing
      </p>
      <p className="text-caption text-ink-soft mt-1 [text-wrap:pretty]">
        {conflict.current.lastActor?.name ?? 'Someone else'} saved a different version{' '}
        {relativeTime(conflict.current.updatedAt)}. Nothing has been overwritten — choose which one
        to keep.
      </p>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <figure className="bg-raised rounded-(--radius-field) p-3">
          <figcaption className="text-micro text-ink-faint mb-1">Yours</figcaption>
          <p className="text-caption text-ink line-clamp-4 whitespace-pre-wrap">
            {conflict.mine || <span className="text-ink-faint">(empty)</span>}
          </p>
        </figure>
        <figure className="bg-raised rounded-(--radius-field) p-3">
          <figcaption className="text-micro text-ink-faint mb-1">
            {conflict.current.lastActor?.name ?? 'Theirs'}
          </figcaption>
          <p className="text-caption text-ink line-clamp-4 whitespace-pre-wrap">
            {conflict.theirs || <span className="text-ink-faint">(empty)</span>}
          </p>
        </figure>
      </div>

      <div className="mt-3 flex flex-wrap gap-3">
        <Button size="sm" variant="primary" onClick={() => void onKeepMine()}>
          Keep my version
        </Button>
        <Button size="sm" variant="secondary" onClick={onUseTheirs}>
          Use their version
        </Button>
      </div>
    </div>
  );
}

function EditableTitle({
  id,
  value,
  revision,
  onSave,
}: {
  id: string;
  value: string;
  revision: number;
  onSave: (value: string, basedOn: number) => Promise<void>;
}) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const basedOn = useRef(revision);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  const beginEditing = () => {
    basedOn.current = revision;
    setEditing(true);
  };

  if (!editing) {
    return (
      <h2
        id={id}
        tabIndex={0}
        role="button"
        title="Click to edit the title"
        onClick={beginEditing}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            beginEditing();
          }
        }}
        className="text-title text-ink hover:bg-ink/4 -mx-1.5 mt-1 cursor-text rounded-(--radius-field) px-1.5 py-0.5 [text-wrap:balance]"
      >
        {value}
      </h2>
    );
  }

  const commit = async () => {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== value) await onSave(next, basedOn.current);
    else setDraft(value);
  };

  return (
    <textarea
      ref={ref}
      autoFocus
      rows={2}
      aria-label="Card title"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          void commit();
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          setDraft(value);
          setEditing(false);
        }
      }}
      className={cn(inputClass, 'text-title mt-1 resize-none')}
    />
  );
}

function EditableText({
  label,
  value,
  revision,
  placeholder,
  rows,
  suffix,
  onSave,
}: {
  label: string;
  value: string;
  revision: number;
  placeholder: string;
  rows: number;
  suffix?: React.ReactNode;
  onSave: (value: string, basedOn: number) => Promise<void>;
}) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const basedOn = useRef(revision);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  const beginEditing = () => {
    basedOn.current = revision;
    setEditing(true);
  };

  const commit = async () => {
    setEditing(false);
    if (draft === value) return;
    setSaving(true);
    try {
      await onSave(draft, basedOn.current);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-labelledby={id}>
      <div className="mb-2 flex items-center gap-3">
        <h3 id={id} className="text-micro text-ink-faint">
          {label}
        </h3>
        {suffix}
        {saving && <span className="text-caption text-ink-faint ms-auto">Saving…</span>}
      </div>

      {editing ? (
        <textarea
          autoFocus
          rows={Math.max(rows, draft.split('\n').length + 1)}
          aria-label={label}
          value={draft}
          placeholder={placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void commit();
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              setDraft(value);
              setEditing(false);
            }
          }}
          className={cn(inputClass, 'text-body resize-y')}
        />
      ) : (
        <div
          role="button"
          tabIndex={0}
          title={`Click to edit ${label.toLowerCase()}`}
          onClick={beginEditing}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              beginEditing();
            }
          }}
          className="hover:bg-ink/4 -mx-2 cursor-text rounded-(--radius-field) px-2 py-1.5"
        >
          {value.trim() ? (
            <RichText value={value} />
          ) : (
            <p className="text-body text-ink-faint [text-wrap:pretty]">{placeholder}</p>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Just enough Markdown to make a checklist readable: `- [ ]` and `- [x]` lines
 * become a real list, everything else stays exactly as it was typed. A full
 * Markdown renderer would be a bigger promise than the field makes.
 */
function RichText({ value }: { value: string }) {
  const blocks: Array<{ type: 'text'; lines: string[] } | { type: 'list'; items: Array<{ done: boolean; label: string }> }> = [];

  for (const line of value.split('\n')) {
    const match = /^\s*[-*]\s+\[( |x|X)\]\s*(.*)$/.exec(line);
    const last = blocks.at(-1);
    if (match) {
      const item = { done: match[1]!.toLowerCase() === 'x', label: match[2]! };
      if (last?.type === 'list') last.items.push(item);
      else blocks.push({ type: 'list', items: [item] });
    } else if (last?.type === 'text') {
      last.lines.push(line);
    } else {
      blocks.push({ type: 'text', lines: [line] });
    }
  }

  return (
    <div className="prose-trella space-y-2">
      {blocks.map((block, index) =>
        block.type === 'list' ? (
          <ul key={index} className="space-y-1">
            {block.items.map((item, itemIndex) => (
              <li key={itemIndex} className="flex items-start gap-2">
                <span
                  aria-hidden="true"
                  className={cn(
                    'mt-[5px] grid size-3.5 shrink-0 place-items-center rounded-[4px]',
                    item.done
                      ? 'bg-accent-solid text-on-accent'
                      : 'border-line-strong border'
                  )}
                >
                  {item.done && <Icon icon={Check} size={14} beside="semibold" className="size-2.5" />}
                </span>
                <span
                  className={cn(
                    'text-body',
                    item.done ? 'text-ink-faint line-through' : 'text-ink-soft'
                  )}
                >
                  {item.label}
                </span>
                <span className="sr-only">{item.done ? '(done)' : '(not done)'}</span>
              </li>
            ))}
          </ul>
        ) : block.lines.join('').trim() === '' ? null : (
          <p key={index} className="text-body text-ink-soft whitespace-pre-wrap">
            {block.lines.join('\n').trim()}
          </p>
        )
      )}
    </div>
  );
}

function StatusControl({ card }: { card: Card }) {
  const { state, moveCard, byColumn, announce } = useBoard();
  const id = useId();
  const columns = state.board?.columns ?? [];
  return (
    <Field label="Status" htmlFor={id}>
      <select
        id={id}
        value={card.status}
        onChange={(event) => {
          const status = event.target.value;
          const index = (byColumn[status] ?? []).length;
          announce(`Moved to ${columns.find((entry) => entry.id === status)?.name ?? status}.`);
          void moveCard(card.id, status, index);
        }}
        className={cn(inputClass, 'h-9 w-44 py-0')}
      >
        {columns.map((column) => (
          <option key={column.id} value={column.id}>
            {column.name}
          </option>
        ))}
      </select>
    </Field>
  );
}

function PriorityControl({
  card,
  onChange,
}: {
  card: Card;
  onChange: (priority: Priority) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-micro text-ink-faint" id={`priority-${card.id}`}>
        Priority
      </span>
      <div role="radiogroup" aria-labelledby={`priority-${card.id}`} className="flex gap-1">
        {PRIORITIES.map((priority) => {
          const active = card.priority === priority;
          return (
            <button
              key={priority}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(priority)}
              className={cn(
                'motion-press flex h-9 items-center gap-1.5 rounded-(--radius-field) px-2.5',
                'text-caption capitalize',
                active
                  ? 'bg-accent-soft text-accent-soft-ink shadow-[var(--lift-1)]'
                  : 'text-ink-faint hover:bg-ink/5 hover:text-ink-soft'
              )}
            >
              <PriorityGlyph priority={priority} />
              <span>{priority}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function LabelEditor({
  labels,
  onSave,
}: {
  labels: string[];
  onSave: (labels: string[]) => Promise<void>;
}) {
  const id = useId();
  const [value, setValue] = useState('');

  return (
    <section aria-labelledby={id}>
      <h3 id={id} className="text-micro text-ink-faint mb-2">
        Labels
      </h3>
      <div className="flex flex-wrap items-center gap-1.5">
        {labels.map((label) => (
          <span key={label} className="inline-flex items-center">
            <Chip>
              {label}
              <button
                type="button"
                aria-label={`Remove the ${label} label`}
                onClick={() => void onSave(labels.filter((entry) => entry !== label))}
                className="text-ink-faint hover:text-ink -me-0.5 ms-0.5 rounded-full p-0.5"
              >
                <Icon icon={X} size={14} className="size-3" />
              </button>
            </Chip>
          </span>
        ))}
        <input
          type="text"
          aria-label="Add a label"
          placeholder={labels.length ? 'Add another' : 'Add a label'}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && value.trim()) {
              event.preventDefault();
              void onSave([...labels, value.trim()]);
              setValue('');
            }
          }}
          className={cn(inputClass, 'h-7 w-32 px-2 py-0 text-[13px]')}
        />
      </div>
    </section>
  );
}

function Comments({
  comments,
  onAdd,
}: {
  comments: Comment[];
  onAdd: (body: string) => Promise<void>;
}) {
  const id = useId();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    try {
      await onAdd(body);
      setDraft('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby={id}>
      <h3 id={id} className="text-micro text-ink-faint mb-3">
        Comments {comments.length > 0 && <span className="tabular-nums">({comments.length})</span>}
      </h3>

      {comments.length === 0 ? (
        <p className="text-caption text-ink-faint mb-3 [text-wrap:pretty]">
          Comments are where handoff context lives. Say what you did and what is left.
        </p>
      ) : (
        <ol className="mb-4 space-y-4">
          {comments.map((comment) => (
            <li key={comment.id} className="flex gap-2.5">
              <ActorAvatar actor={comment.actor} size={28} />
              <div className="min-w-0 flex-1">
                <p className="text-caption text-ink-faint">
                  <span className="text-ink font-medium">{comment.actor.name}</span>{' '}
                  <time dateTime={comment.createdAt} title={absoluteTime(comment.createdAt)}>
                    {relativeTime(comment.createdAt)}
                  </time>
                </p>
                <p className="text-body text-ink-soft prose-trella mt-0.5">{comment.body}</p>
              </div>
            </li>
          ))}
        </ol>
      )}

      <div className="flex flex-col gap-2">
        <textarea
          rows={2}
          aria-label="Write a comment"
          placeholder="Leave a note for whoever picks this up next"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void submit();
            }
          }}
          className={cn(inputClass, 'text-body resize-y')}
        />
        <div className="flex items-center gap-3">
          <Button size="sm" variant="primary" disabled={busy || !draft.trim()} onClick={() => void submit()}>
            <Icon icon={busy ? Check : MessageSquare} size={14} beside="semibold" />
            {busy ? 'Posting…' : 'Add comment'}
          </Button>
          <span className="text-caption text-ink-faint hidden sm:inline">⌘ + Enter</span>
        </div>
      </div>
    </section>
  );
}
