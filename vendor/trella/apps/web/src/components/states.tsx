import { useEffect, useRef } from 'react';
import { Plus, RefreshCw, Terminal, X } from 'lucide-react';
import { Button, Icon, IconButton } from './primitives';
import { cn } from '../lib/format';

/** First run. Orientation, one primary action, and the agent route stated quietly. */
export function EmptyBoard({ onAddCard }: { onAddCard: () => void }) {
  return (
    <div className="flex h-full w-full flex-1 items-center justify-center px-6 pb-16">
      <div className="motion-stagger max-w-lg text-center">
        <h2 className="text-display text-ink [text-wrap:balance]">An empty trellis</h2>
        <p className="text-body text-ink-soft mx-auto mt-3 max-w-md [text-wrap:pretty]">
          Cards live in columns and move left to right as work progresses. You and your agents
          share this board, and every change is recorded with who made it.
        </p>
        <div className="mt-6 flex justify-center">
          <Button variant="primary" onClick={onAddCard}>
            <Icon icon={Plus} size={16} beside="semibold" />
            Add the first card
          </Button>
        </div>
        <p className="text-caption text-ink-faint mt-8 [text-wrap:pretty]">
          <Icon icon={Terminal} size={14} className="me-1.5 inline align-[-2px]" />
          Agents can add cards too — through <code className="font-mono">trella create</code>, the
          MCP server, or the file adapter.
        </p>
      </div>
    </div>
  );
}

/** Skeletons at real card geometry, so nothing jumps when the data lands. */
export function BoardSkeleton() {
  return (
    <div aria-hidden="true" className="flex h-full w-full flex-1 gap-4 px-6 pb-6">
      {[5, 3, 2, 1, 2].map((count, column) => (
        <div
          key={column}
          className="bg-sunken h-full min-w-[16.5rem] flex-1 basis-[19rem] rounded-(--radius-column) p-1.5"
        >
          <div className="flex items-center gap-2 px-1.5 py-2">
            <div className="skeleton size-1.5 rounded-full" />
            <div className="skeleton h-3 w-20 rounded-(--radius-chip)" />
          </div>
          <div className="flex flex-col gap-3 p-1.5">
            {Array.from({ length: count }, (_, card) => (
              <div key={card} className="surface-card rounded-(--radius-card) px-3 py-2.5">
                <div className="skeleton h-3.5 w-11/12 rounded-(--radius-chip)" />
                <div className="skeleton mt-2 h-3.5 w-2/3 rounded-(--radius-chip)" />
                <div className="skeleton mt-3 h-3 w-1/3 rounded-(--radius-chip)" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** The service is not answering. States the exact command that fixes it. */
export function ServiceDown({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex h-full w-full flex-1 items-center justify-center px-6 pb-16">
      <div className="max-w-md text-center">
        <h2 className="text-title text-ink [text-wrap:balance]">{message}</h2>
        <p className="text-body text-ink-soft mt-2 [text-wrap:pretty]">
          The board is served by a small process running in your project. Start it, then try again.
        </p>
        <pre className="bg-inset border-line text-ink-soft mt-4 overflow-x-auto rounded-(--radius-field) border px-3 py-2 text-start font-mono text-[13px]">
          npx trella start
        </pre>
        <div className="mt-5 flex justify-center">
          <Button variant="secondary" onClick={onRetry}>
            <Icon icon={RefreshCw} size={16} />
            Try again
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Search and filters found nothing. Names the query and offers the way out. */
export function NoMatches({ query, onClear }: { query: string; onClear: () => void }) {
  return (
    <div className="flex h-full w-full flex-1 items-start justify-center px-6 pt-24 pb-16">
      <div className="max-w-sm text-center">
        <h2 className="text-heading text-ink [text-wrap:balance]">
          {query ? `No cards match “${query}”` : 'No cards match these filters'}
        </h2>
        <p className="text-body text-ink-soft mt-2 [text-wrap:pretty]">
          Every card is still here — the filters are just hiding them.
        </p>
        <div className="mt-4 flex justify-center">
          <Button variant="secondary" onClick={onClear}>
            Clear filters
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * One stable polite region for drag, save and remote-change announcements, plus
 * visible toasts. Nothing here auto-dismisses when it carries an error.
 */
export function StatusLayer({
  announcement,
  toasts,
  onDismiss,
}: {
  announcement: string;
  toasts: Array<{ id: number; message: string; tone: 'info' | 'error' }>;
  onDismiss: (id: number) => void;
}) {
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    for (const toast of toasts) {
      if (toast.tone === 'error' || timers.current.has(toast.id)) continue;
      timers.current.set(
        toast.id,
        setTimeout(() => {
          timers.current.delete(toast.id);
          onDismiss(toast.id);
        }, 6000)
      );
    }
    const active = timers.current;
    return () => {
      for (const [id, timer] of active) {
        if (!toasts.some((toast) => toast.id === id)) {
          clearTimeout(timer);
          active.delete(id);
        }
      }
    };
  }, [toasts, onDismiss]);

  return (
    <>
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>

      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role={toast.tone === 'error' ? 'alert' : 'status'}
            className={cn(
              'motion-fade pointer-events-auto flex max-w-md items-start gap-3 rounded-(--radius-control) px-4 py-2.5',
              'bg-overlay shadow-[var(--lift-3)]',
              toast.tone === 'error' && 'border-caution-line border-s-2'
            )}
          >
            <p className="text-caption text-ink [text-wrap:pretty]">{toast.message}</p>
            <IconButton
              icon={X}
              label="Dismiss"
              className="-me-1 size-6"
              onClick={() => onDismiss(toast.id)}
            />
          </div>
        ))}
      </div>
    </>
  );
}

const SHORTCUTS: Array<[string, string]> = [
  ['/', 'Search cards'],
  ['c', 'Add a card to the first column'],
  ['← →', 'Move between columns'],
  ['↑ ↓', 'Move between cards'],
  ['Enter', 'Open the focused card'],
  ['Space', 'Pick up or drop the focused card'],
  ['⌘ / Ctrl + Enter', 'Save the field you are editing'],
  ['Escape', 'Close the top-most layer'],
  ['?', 'Show this list'],
];

export function KeyboardHelp({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      className={cn(
        'bg-overlay text-ink m-auto w-[min(30rem,calc(100vw-3rem))] rounded-(--radius-panel) p-0',
        'shadow-[var(--lift-panel)] backdrop:bg-bone-1000/40'
      )}
    >
      <div className="p-6">
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-title text-ink">Keyboard</h2>
          <IconButton icon={X} label="Close" onClick={onClose} />
        </div>
        <dl className="mt-4 space-y-2">
          {SHORTCUTS.map(([keys, description]) => (
            <div key={keys} className="flex items-baseline gap-4">
              <dt className="border-line bg-inset text-ink-soft w-40 shrink-0 rounded-(--radius-chip) border px-2 py-0.5 text-center font-mono text-[12px]">
                {keys}
              </dt>
              <dd className="text-caption text-ink-soft">{description}</dd>
            </div>
          ))}
        </dl>
      </div>
    </dialog>
  );
}
