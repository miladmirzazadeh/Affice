/**
 * The address names the board and the card on screen, so a view can be linked to
 * and survives a reload:
 *
 *   /?board=<id | slug | project/slug>&card=<key>
 *
 * The page reads it once, on load. From then on it only writes it, with
 * `replaceState`, so switching boards or opening a card neither reloads the page
 * nor adds a history entry per click.
 */
export interface Address {
  board: string | null;
  card: string | null;
}

export function readAddress(): Address {
  const params = new URLSearchParams(window.location.search);
  return {
    board: params.get('board')?.trim() || null,
    // The service reads card keys in any case and stores them in upper case.
    card: params.get('card')?.trim().toUpperCase() || null,
  };
}

/** Sets `board` and `card` (a null removes it) and leaves everything else alone. */
export function writeAddress({ board, card }: Address): void {
  const url = new URL(window.location.href);
  // Removed and appended, so a copied link always reads board first, then card.
  for (const [name, value] of [
    ['board', board],
    ['card', card],
  ] as const) {
    url.searchParams.delete(name);
    if (value) url.searchParams.append(name, value);
  }
  if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url);
}
