// The environment of the helper programs Affice starts (git, the Trella service and the Trella CLI).
//
// An allow list, not a block list: a variable reaches the child only when this file names it. The user's
// credentials (ANTHROPIC_*, AWS_*, GITHUB_*, NPM_TOKEN, anything ending in _TOKEN, _KEY or _SECRET) are
// never named, so they cannot slip through under a name nobody thought of. The managers' own environment
// is a different matter (server/claude/driver.ts childEnv): Claude Code needs the user's login and
// settings, and a helper program does not.
//
// What stays is what a program needs to find its tools and its home folder, to pick a language and a
// temporary folder, and (on Windows) to start at all.

/** Variables copied from the parent as they are, when set. */
const KEPT = new Set([
  // Finding programs and the home folder
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  // Language and time
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_COLLATE',
  'LC_MESSAGES',
  'LC_MONETARY',
  'LC_NUMERIC',
  'LC_TIME',
  'LC_PAPER',
  'LC_NAME',
  'LC_ADDRESS',
  'LC_TELEPHONE',
  'LC_MEASUREMENT',
  'LC_IDENTIFICATION',
  'TZ',
  // Temporary folders and the terminal
  'TMPDIR',
  'TMP',
  'TEMP',
  'TERM',
  // Where the user's own tools keep their (non secret) files; git reads its global config from here
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  // Windows needs these to start a process at all, and to find its folders
  'SYSTEMROOT',
  'SystemRoot',
  'WINDIR',
  'windir',
  'COMSPEC',
  'ComSpec',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'ProgramFiles',
  'PROGRAMDATA',
  'HOMEDRIVE',
  'HOMEPATH',
]);

/**
 * A new environment for a helper program: the allow listed variables of `base` (default the server's own
 * environment), then `extra` on top (variables the program needs, such as NO_COLOR or GIT_OPTIONAL_LOCKS).
 * `base` is never changed. An `extra` value that is undefined is left out.
 */
export function minimalEnv(extra: Record<string, string | undefined> = {}, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of KEPT) {
    const value = base[name];
    if (typeof value === 'string' && !value.includes('\0')) env[name] = value;
  }
  for (const [name, value] of Object.entries(extra)) {
    if (value !== undefined) env[name] = value;
  }
  return env;
}
