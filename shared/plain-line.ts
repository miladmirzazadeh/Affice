// One line of plain text from a manager's markdown. The chat renders markdown; the speech bubble over an
// avatar and the agent row in the panel show one short line, where `**12 lines**` would show its asterisks.
// Pure strings, so the page and the scene both use it. The chat itself is not touched.

/** Markers a line can start with: a heading, a list dash or bullet, a number, a quote. */
const LINE_START = /^\s*(?:#{1,6}\s+|[-*+•]\s+|\d{1,3}[.)]\s+|>\s*)/;

/** `text` without the markers of markdown: **bold**, __bold__, *italic*, `code`, ~~gone~~, [links](url), # headings and list dashes. */
export function plainLine(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .split('\n')
    .map((line) => line.replace(LINE_START, ''))
    .join(' ')
    .replace(/!?\[([^\]]*)\]\([^)\s]*\)/g, '$1')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
    .replace(/(^|[^\w*])\*(?=[^\s*])([^*]*?[^\s*])\*(?!\w)/g, '$1$2')
    .replace(/(^|\W)_(?=[^\s_])([^_]*?[^\s_])_(?!\w)/g, '$1$2')
    // What a cut at the end of a long line leaves behind: an opening marker with no closing one.
    .replace(/\*\*|`|(^|\s)__|__(?=\s|$)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}
