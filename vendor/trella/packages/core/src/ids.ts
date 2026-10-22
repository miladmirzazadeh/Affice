import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford-ish: no i, l, o, u.

/**
 * Sortable, compact, collision-resistant id for rows nobody types by hand
 * (comments, activity). Time prefix keeps insertion order readable in the file.
 */
export function newId(prefix: string): string {
  const time = Date.now().toString(32).padStart(9, '0');
  const bytes = randomBytes(8);
  let random = '';
  for (const byte of bytes) random += ALPHABET[byte % ALPHABET.length];
  return `${prefix}_${time}${random}`;
}



/** Turns a column name into the slug used as a card's `status`. */
export function slugify(input: string): string {
  const slug = input
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'column';
}
