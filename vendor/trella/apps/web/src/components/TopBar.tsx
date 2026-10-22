import { forwardRef } from 'react';
import { Keyboard, Moon, Plus, Search, Sun, X } from 'lucide-react';
import { ActorAvatar, Button, Icon, IconButton, inputClass } from './primitives';
import { BoardSwitcher } from './BoardSwitcher';
import { cn } from '../lib/format';
import type { Connection } from '../lib/board';
import type { Actor, Priority } from '../lib/types';

export type Appearance = 'light' | 'dark' | 'system';

export interface Filters {
  query: string;
  assignee: 'all' | 'me' | 'agents' | 'unassigned';
  priority: 'all' | Priority;
}

export const emptyFilters: Filters = { query: '', assignee: 'all', priority: 'all' };

export const TopBar = forwardRef<
  HTMLInputElement,
  {
    identity: Actor | null;
    connection: Connection;
    filters: Filters;
    matchCount: number;
    totalCount: number;
    appearance: Appearance;
    onFilters: (filters: Filters) => void;
    onAppearance: (appearance: Appearance) => void;
    onAddCard: () => void;
    onShowShortcuts: () => void;
  }
>(function TopBar(
  {
    identity,
    connection,
    filters,
    matchCount,
    totalCount,
    appearance,
    onFilters,
    onAppearance,
    onAddCard,
    onShowShortcuts,
  },
  searchRef
) {
  const filtering = filters.query !== '' || filters.assignee !== 'all' || filters.priority !== 'all';

  return (
    <header className="bg-chrome border-line flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-6 py-3">
      <div className="flex min-w-0 items-center gap-2">
        <Wordmark />
        <span aria-hidden="true" className="bg-line h-5 w-px" />
        <BoardSwitcher />
      </div>

      <div className="order-last flex w-full items-center gap-2 sm:order-none sm:w-auto sm:flex-1 sm:justify-center">
        <div className="relative w-full max-w-md">
          <span className="text-ink-faint pointer-events-none absolute inset-y-0 start-3 flex items-center">
            <Icon icon={Search} size={16} />
          </span>
          <input
            ref={searchRef}
            type="search"
            value={filters.query}
            aria-label="Search cards"
            placeholder="Search cards"
            onChange={(event) => onFilters({ ...filters, query: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && filters.query) {
                event.stopPropagation();
                onFilters({ ...filters, query: '' });
              }
            }}
            className={cn(inputClass, 'h-9 ps-9 pe-3')}
          />
        </div>

        <select
          aria-label="Filter by assignee"
          value={filters.assignee}
          onChange={(event) =>
            onFilters({ ...filters, assignee: event.target.value as Filters['assignee'] })
          }
          className={cn(inputClass, 'h-9 w-auto py-0')}
        >
          <option value="all">Anyone</option>
          <option value="me">Assigned to me</option>
          <option value="agents">Assigned to agents</option>
          <option value="unassigned">Unassigned</option>
        </select>

        <select
          aria-label="Filter by priority"
          value={filters.priority}
          onChange={(event) =>
            onFilters({ ...filters, priority: event.target.value as Filters['priority'] })
          }
          className={cn(inputClass, 'hidden h-9 w-auto py-0 lg:block')}
        >
          <option value="all">Any priority</option>
          <option value="urgent">Urgent</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>

        {filtering && (
          <Button size="sm" variant="ghost" onClick={() => onFilters(emptyFilters)}>
            <Icon icon={X} size={14} />
            Clear
            <span className="sr-only">
              {` filters. Showing ${matchCount} of ${totalCount} cards.`}
            </span>
          </Button>
        )}
      </div>

      <div className="ms-auto flex items-center gap-2">
        <ConnectionBadge connection={connection} />
        <Button size="sm" variant="primary" onClick={onAddCard}>
          <Icon icon={Plus} size={14} beside="semibold" />
          Add card
        </Button>
        <IconButton icon={Keyboard} label="Keyboard shortcuts" onClick={onShowShortcuts} />
        <IconButton
          icon={appearance === 'dark' ? Sun : Moon}
          label={appearance === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'}
          onClick={() => onAppearance(appearance === 'dark' ? 'light' : 'dark')}
        />
        {identity && <ActorAvatar actor={identity} size={28} />}
      </div>
    </header>
  );
});

function Wordmark() {
  return (
    <span className="flex items-center gap-2">
      <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true">
        <path
          d="M4 20 L20 4 M4 4 L20 20"
          stroke="var(--accent-solid)"
          strokeWidth="1.25"
          strokeLinecap="round"
          opacity="0.5"
        />
        <rect x="3" y="9.5" width="18" height="5" rx="2.5" fill="var(--accent-solid)" />
      </svg>
      <span className="font-serif text-[19px] leading-none tracking-tight text-ink">trella</span>
    </span>
  );
}

/**
 * Connection is a word plus a dot, never a dot on its own: a colour-only status
 * indicator is unreadable for a good share of users.
 */
function ConnectionBadge({ connection }: { connection: Connection }) {
  const copy = {
    live: 'Live',
    connecting: 'Connecting',
    offline: 'Reconnecting',
  }[connection];

  return (
    <span
      className={cn(
        'text-caption hidden items-center gap-1.5 md:inline-flex',
        connection === 'live' ? 'text-ink-faint' : 'text-caution'
      )}
      title={
        connection === 'live'
          ? 'Changes from agents and other windows arrive here immediately.'
          : 'Trying to reach the local Trella service.'
      }
    >
      <span
        aria-hidden="true"
        className={cn(
          'size-1.5 rounded-full',
          connection === 'live' ? 'bg-accent-solid' : 'bg-caution-line'
        )}
      />
      {copy}
    </span>
  );
}
