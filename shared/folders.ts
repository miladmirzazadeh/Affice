// Folders that are too broad to name as a department's report folder, knowledge folder or repository: the
// root of the disk and the user's home folder.
//
// A report folder of `/` would let the report viewer serve any .md or .html file on the machine, and a
// knowledge folder of `/` or of the home folder would make everything in it readable by the manager without a
// card. The server (the office store, when it checks a form and when it loads affice.json) and the form on
// the page apply this one rule, so they cannot disagree. Pure strings only: it runs in the browser too.

/**
 * The report folder every new department starts with: `reports`, relative to the Office folder. It is where the
 * protocol tells every agent to write (Office/reports/), so a department made from a template or with an empty
 * field lists its reports at once.
 */
export const DEFAULT_REPORT_DIR = 'reports';

export type BroadFolder = 'the root of the disk' | 'your home folder';

const DRIVE = /^[A-Za-z]:(?:[\\/]|$)/;

/**
 * A folder path in one spelling, for comparing: forward slashes, `.` and `..` resolved, no repeated or
 * trailing slashes. An absolute path stays absolute (`/` for the root, `C:/` for a drive root). A relative
 * path is only cleaned: nothing here knows where it starts.
 */
export function normalizeFolder(path: string): string {
  const text = path.trim();
  const drive = DRIVE.test(text);
  const parts = (drive ? text.replace(/\\/g, '/') : text).split('/');
  const rooted = drive ? parts.shift()!.toUpperCase() : text.startsWith('/') ? '' : null;
  const kept: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (kept.length && kept[kept.length - 1] !== '..') kept.pop();
      else if (rooted === null) kept.push('..');
      continue;
    }
    kept.push(part);
  }
  const body = kept.join('/');
  if (rooted === null) return body || '.';
  return `${rooted}/${body}`;
}

/** The home folder as a page can guess it when it cannot ask the server: the usual /Users/<name>, /home/<name> and /root. */
const USUAL_HOME = /^\/(?:Users|home)\/[^/]+$|^\/root$/;

/**
 * Whether the absolute `path` is the root of the disk or the home folder. `home` is the real home folder when
 * the caller knows it (the server does); without it the usual places are recognised. A relative path is never
 * judged here: the caller resolves it first.
 */
export function broadFolder(path: string, home?: string | null): BroadFolder | null {
  const clean = normalizeFolder(path);
  if (clean === '/' || /^[A-Z]:\/$/.test(clean)) return 'the root of the disk';
  if (!clean.startsWith('/') && !/^[A-Z]:\//.test(clean)) return null;
  if (home ? normalizeFolder(home) === clean : USUAL_HOME.test(clean)) return 'your home folder';
  return null;
}

/** The sentence for a form or a log: which folder, why it is refused, and what to do instead. */
export function broadFolderMessage(label: string, path: string, reason: BroadFolder): string {
  const shown = path.length > 80 ? `${path.slice(0, 77)}...` : path;
  return `${label} ${shown} is ${reason}, which is too broad. Name a folder inside your project instead.`;
}
