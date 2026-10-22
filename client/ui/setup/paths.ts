// Path text for the project picker. Pure, so it can be tested without a browser.

/**
 * A path as the picker shows it: the home folder written `~` (the usual /Users/<name> and /home/<name>),
 * and a long path cut to its last three folders with a leading ellipsis. The full path stays in the
 * element's title.
 */
export function shortenPath(path: string): string {
  const home = /^\/(?:Users|home)\/[^/]+(?=\/|$)|^\/root(?=\/|$)/.exec(path);
  const tilde = home ? `~${path.slice(home[0].length)}` : path;
  const parts = tilde.split('/').filter(Boolean);
  if (parts.length <= 4) return tilde || '/';
  return `…/${parts.slice(-3).join('/')}`;
}

export interface Crumb {
  label: string;
  path: string;
}

/** The steps of a folder path for the breadcrumb: the root, then every folder down to the path. */
export function crumbs(path: string): Crumb[] {
  const out: Crumb[] = [{ label: '/', path: '/' }];
  let at = '';
  for (const part of path.split('/').filter(Boolean)) {
    at += `/${part}`;
    out.push({ label: part, path: at });
  }
  return out;
}
