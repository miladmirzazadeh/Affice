import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Board } from './components/Board';
import { CardDetail } from './components/CardDetail';
import { TopBar, emptyFilters, type Appearance, type Filters } from './components/TopBar';
import {
  BoardSkeleton,
  EmptyBoard,
  KeyboardHelp,
  NoMatches,
  ServiceDown,
  StatusLayer,
} from './components/states';
import { readAddress, writeAddress } from './lib/address';
import { BoardProvider, useBoard } from './lib/board';
import type { Card } from './lib/types';

export default function App() {
  return (
    <BoardProvider>
      <Workspace />
    </BoardProvider>
  );
}

function Workspace() {
  const board = useBoard();
  const { state } = board;

  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [openCardId, setOpenCardId] = useState<string | null>(null);
  // The card the address named when the page loaded. It opens once, as soon as its
  // board is on screen, and is dropped when that board does not have it. Adjusted
  // during render so the address is only ever written with the card already open.
  const [addressCard, setAddressCard] = useState(() => readAddress().card);
  if (addressCard && state.phase === 'ready') {
    setAddressCard(null);
    if (state.cards[addressCard]) setOpenCardId(addressCard);
  }
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [composerColumn, setComposerColumn] = useState<string | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [appearance, setAppearance] = useState<Appearance>(
    () => (localStorage.getItem('trella:appearance') as Appearance) ?? 'system'
  );
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const dark =
      appearance === 'dark' ||
      (appearance === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
    if (appearance === 'system') localStorage.removeItem('trella:appearance');
    else localStorage.setItem('trella:appearance', appearance);
  }, [appearance]);

  useEffect(() => {
    document.title = state.board ? `${state.board.name} · Trella` : 'Trella';
  }, [state.board]);

  // Keep the address in step with the board and card on screen, so the view can be
  // linked to and reloaded. A card that is not on this board is left out.
  const boardId = state.board?.id ?? null;
  const shownCardId = openCardId && state.cards[openCardId] ? openCardId : null;
  useEffect(() => {
    if (state.phase === 'ready' && boardId) writeAddress({ board: boardId, card: shownCardId });
  }, [state.phase, boardId, shownCardId]);

  // The field stays responsive while the board catches up; re-filtering hundreds
  // of cards on every keystroke would make typing feel heavy.
  const deferredQuery = useDeferredValue(filters.query);

  const matches = useCallback(
    (card: Card) => {
      const query = deferredQuery.trim().toLowerCase();
      if (query) {
        const haystack = `${card.id} ${card.title} ${card.description} ${card.labels.join(' ')}`;
        if (!haystack.toLowerCase().includes(query)) return false;
      }
      if (filters.priority !== 'all' && card.priority !== filters.priority) return false;
      switch (filters.assignee) {
        case 'me':
          return card.assignee?.id === state.identity?.id;
        case 'agents':
          return card.assignee?.type === 'agent';
        case 'unassigned':
          return card.assignee === null;
        default:
          return true;
      }
    },
    [deferredQuery, filters.priority, filters.assignee, state.identity]
  );

  const totalCount = Object.keys(state.cards).length;
  const matchCount = useMemo(
    () => Object.values(state.cards).filter(matches).length,
    [state.cards, matches]
  );

  // Global shortcuts. Anything typed into a field belongs to that field.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable === true;

      if (event.key === 'Escape') {
        if (showShortcuts) setShowShortcuts(false);
        else if (composerColumn) setComposerColumn(null);
        else if (openCardId) setOpenCardId(null);
        return;
      }
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === '/') {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (event.key === 'c') {
        event.preventDefault();
        const status = selectedCardId
          ? state.cards[selectedCardId]?.status
          : state.board?.columns[0]?.id;
        setComposerColumn(status ?? null);
      } else if (event.key === '?') {
        event.preventDefault();
        setShowShortcuts(true);
      } else if (event.key === 'e' && selectedCardId) {
        event.preventDefault();
        setOpenCardId(selectedCardId);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showShortcuts, composerColumn, openCardId, selectedCardId, state.cards, state.board]);

  const clearFilters = () => setFilters(emptyFilters);
  const addCard = () => setComposerColumn(state.board?.columns[0]?.id ?? null);

  const filtering =
    filters.query !== '' || filters.assignee !== 'all' || filters.priority !== 'all';

  // The welcome hero is for a workspace nobody has used yet. Once there is more
  // than one board, an empty board should show its own columns instead: they are
  // the workflow the person just chose, and hiding them behind a generic hero
  // makes a new board look like it did not take.
  const showWelcome =
    state.phase === 'ready' && !filtering && totalCount === 0 && state.boards.length <= 1;
  const showNoMatches = state.phase === 'ready' && filtering && matchCount === 0;
  const showBoard = state.phase === 'ready' && !showWelcome && !showNoMatches;

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <a
        href="#board"
        className="sr-only focus:not-sr-only focus:bg-overlay focus:text-ink focus:absolute focus:start-4 focus:top-4 focus:z-[70] focus:rounded-(--radius-control) focus:px-4 focus:py-2 focus:shadow-[var(--lift-3)]"
      >
        Skip to the board
      </a>

      <div id="app-shell" className="flex min-h-0 flex-1 flex-col">
        <TopBar
          ref={searchRef}
          identity={state.identity}
          connection={state.connection}
          filters={filters}
          matchCount={matchCount}
          totalCount={totalCount}
          appearance={appearance}
          onFilters={setFilters}
          onAppearance={setAppearance}
          onAddCard={addCard}
          onShowShortcuts={() => setShowShortcuts(true)}
        />

        <main id="board" className="flex min-h-0 min-w-0 flex-1 overflow-hidden pt-4">
          {state.phase === 'loading' && <BoardSkeleton />}

          {state.phase === 'error' && (
            <ServiceDown
              message={state.error ?? 'Unable to load the board.'}
              onRetry={() => void board.reload()}
            />
          )}

          {showWelcome && <EmptyBoard onAddCard={addCard} />}

          {showNoMatches && <NoMatches query={filters.query} onClear={clearFilters} />}

          {showBoard && (
            <div className="flex min-h-0 min-w-0 flex-1">
              <div className="min-w-0 flex-1">
                <Board
                  filter={matches}
                  onOpenCard={setOpenCardId}
                  selectedCardId={selectedCardId}
                  onSelectCard={setSelectedCardId}
                  composerColumn={composerColumn}
                  onComposerChange={setComposerColumn}
                />
              </div>
              {openCardId && state.cards[openCardId] && (
                <CardDetail cardId={openCardId} onClose={() => setOpenCardId(null)} />
              )}
            </div>
          )}
        </main>
      </div>

      {openCardId && !state.cards[openCardId] && <ClosedCardNotice onClose={() => setOpenCardId(null)} />}

      <StatusLayer
        announcement={board.announcement}
        toasts={board.toasts}
        onDismiss={board.dismissToast}
      />

      {showShortcuts && <KeyboardHelp onClose={() => setShowShortcuts(false)} />}
    </div>
  );
}

/** The open card was archived by someone else while it was on screen. */
function ClosedCardNotice({ onClose }: { onClose: () => void }) {
  const { toast } = useBoard();
  useEffect(() => {
    toast('That card was archived by someone else, so it closed.');
    onClose();
  }, [toast, onClose]);
  return null;
}
