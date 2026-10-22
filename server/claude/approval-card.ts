// What an approval card shows: the whole request, as text. A person decides on this, so nothing in it
// is summarised away: the command is shown in full (every line), an edit shows its old and its new
// text, and the fields the card has no special place for are listed as "Other fields". Text that passes
// PERMISSION_PART_CAP is cut and says how much was cut; control and bidi characters are written out
// as visible escapes, so text cannot hide behind them or read in another order.

import { PERMISSION_PART_CAP, type PermissionPart } from '../../shared/types';

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Most edits of one MultiEdit call that get a block each; the rest is counted in a note. */
const MAX_EDITS_SHOWN = 10;

const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]/gu;

/** Control, zero width and bidi characters as `\u{202E}`, so they show. Newline and tab stay as they are. */
export function visible(text: string): string {
  return text.replace(HIDDEN, (char) => `\\u{${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}}`);
}

/** One block: the text made visible and cut at the cap (never in the middle of a surrogate pair). */
export function part(label: string, text: string): PermissionPart {
  const shown = visible(text);
  if (shown.length <= PERMISSION_PART_CAP) return { label, text: shown, cut: 0 };
  let end = PERMISSION_PART_CAP;
  const last = shown.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { label, text: shown.slice(0, end), cut: shown.length - end };
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function scalar(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** The fields of `input` that no block above shows, one `name: value` line each. */
function otherFields(input: Json, shown: readonly string[]): PermissionPart | null {
  const lines = Object.entries(input)
    .filter(([key]) => !shown.includes(key))
    .map(([key, value]) => `${key}: ${scalar(value)}`);
  return lines.length ? part('Other fields', lines.join('\n')) : null;
}

export interface CardDetail {
  /** The file the call touches, as the agent wrote it (made visible), or null. */
  path: string | null;
  parts: PermissionPart[];
}

/** The path, cwd and blocks of the card for one tool call. Never throws; an input that is not an object is shown as JSON. */
export function describeRequest(tool: string, input: unknown): CardDetail {
  if (!isRecord(input)) return { path: null, parts: [part('Input', scalar(input))] };
  const parts: PermissionPart[] = [];
  const shown: string[] = [];
  const add = (label: string, key: string) => {
    shown.push(key);
    const value = text(input[key]);
    if (value !== null) parts.push(part(label, value));
  };
  const target: { path: string | null } = { path: null };
  const pathKey = (key: string) => {
    shown.push(key);
    const value = text(input[key]);
    if (value !== null) target.path = visible(value);
  };

  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      add('Command', 'command');
      break;
    case 'Edit':
      pathKey('file_path');
      add('Old text', 'old_string');
      add('New text', 'new_string');
      break;
    case 'Write':
      pathKey('file_path');
      add('New content', 'content');
      break;
    case 'MultiEdit': {
      pathKey('file_path');
      shown.push('edits');
      const edits = Array.isArray(input.edits) ? input.edits : [];
      edits.slice(0, MAX_EDITS_SHOWN).forEach((edit, index) => {
        const fields = isRecord(edit) ? edit : {};
        parts.push(part(`Edit ${index + 1}, old text`, text(fields.old_string) ?? ''), part(`Edit ${index + 1}, new text`, text(fields.new_string) ?? ''));
      });
      if (edits.length > MAX_EDITS_SHOWN) parts.push(part('More edits', `${edits.length - MAX_EDITS_SHOWN} more edits are not shown here. Deny this unless you trust the rest.`));
      break;
    }
    case 'NotebookEdit':
      pathKey('notebook_path');
      add('New source', 'new_source');
      break;
    case 'Read':
      pathKey('file_path');
      break;
    case 'Grep':
    case 'Glob':
      add('Pattern', 'pattern');
      pathKey('path');
      break;
    case 'WebFetch':
      add('URL', 'url');
      add('Prompt', 'prompt');
      break;
    case 'WebSearch':
      add('Query', 'query');
      break;
    case 'Agent':
    case 'Task':
      add('Description', 'description');
      add('Prompt', 'prompt');
      break;
    default: {
      // A tool this card has no layout for (an MCP tool, a new built-in): its whole input.
      parts.push(part('Input', JSON.stringify(input, null, 2) ?? ''));
      return { path: null, parts };
    }
  }
  const rest = otherFields(input, shown);
  if (rest) parts.push(rest);
  // A call with nothing but a file (a read) is its path line; one with nothing at all shows its empty input.
  if (!parts.length && target.path === null) parts.push(part('Input', JSON.stringify(input, null, 2) ?? ''));
  return { path: target.path, parts };
}
