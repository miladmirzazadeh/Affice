// What an approval card shows, as plain data (the DOM is built in chat.ts). The server sends the whole
// request as labelled blocks (server/claude/approval-card.ts); this decides which blocks a card has,
// which are long enough to get a "Show all" button, and what is said when text was cut.

import { PERMISSION_PART_CAP, type PermissionPart, type PermissionRequest } from '../../shared/types';

/** A block with more lines than this, or more characters, starts collapsed to a few lines and gets "Show all". */
export const SHORT_LINES = 8;
export const SHORT_CHARS = 480;

export function isLong(text: string): boolean {
  return text.length > SHORT_CHARS || text.split('\n').length > SHORT_LINES;
}

/** The sentence under a block whose text was cut. Never empty for cut > 0: a cut is never silent. */
export function cutNote(cut: number): string {
  return `${cut === 1 ? '1 more character is' : `${cut} more characters are`} not shown, because the text is longer than ${PERMISSION_PART_CAP} characters. Deny it unless you trust the rest.`;
}

/** The blocks of a card: the server's, or the raw input as JSON (cut the same way) for a request that has none. */
export function approvalParts(request: PermissionRequest): PermissionPart[] {
  if (request.parts) return request.parts;
  let json = '';
  try {
    json = JSON.stringify(request.input, null, 2) ?? '';
  } catch {
    json = String(request.input);
  }
  if (!json || json === '{}') return [];
  return [{ label: 'Input', text: json.slice(0, PERMISSION_PART_CAP), cut: Math.max(0, json.length - PERMISSION_PART_CAP) }];
}

/** The lines above the blocks: where the agent works, and the file the call touches. */
export function approvalMeta(request: PermissionRequest): { label: string; text: string }[] {
  const meta: { label: string; text: string }[] = [];
  if (request.cwd) meta.push({ label: 'Folder', text: request.cwd });
  if (request.path) meta.push({ label: 'File', text: request.path });
  return meta;
}
