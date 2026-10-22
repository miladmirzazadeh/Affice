// The only ways Affice writes into a project folder (SEC-04 of the security review).
//
// A project folder can arrive from a git clone or a zip, and git stores symbolic links. A plain
// writeFileSync, mkdirSync or appendFileSync follows them, so opening such a project could overwrite or
// create a file anywhere the user can write, before any manager runs and before any approval. Everything
// Affice writes inside Office/ therefore goes through these functions:
//
//   ensureFolder      a folder that must be a real folder (lstat, never a link), inside its parent once
//                     links are resolved; it is created when missing
//   writeNewFile      creates a file with the `wx` flag (O_EXCL: a link in the way is an error, never
//                     followed) and leaves what already exists alone
//   writeFileAtomic   a temporary file with a random name made with `wx`, then a rename; refuses a target
//                     that is a link or not a regular file
//   appendFileSafe    appends to a regular file, creating it with O_EXCL, opening with O_NOFOLLOW where the
//                     platform has it
//
// Every refusal is an UnsafePathError whose message is a sentence for the user.
//
// File modes: what Affice creates for the user alone (affice.json, the chat history,
// ~/.affice/projects.json) is made 0600, and the folders it creates for that (the chat folder, ~/.affice)
// 0700, so another account on the same computer cannot read a conversation. Pass PRIVATE_FILE or
// PRIVATE_FOLDER. The default stays 0644 and 0755, for what the user may share (the Office folder itself,
// the reports folder, PROTOCOL.md and .gitignore).

import { randomBytes } from 'node:crypto';
import { closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync, type Stats } from 'node:fs';
import { basename, join } from 'node:path';

/** Affice refuses to write where a symbolic link (or something else unexpected) is in the way. The message is for the user. */
export class UnsafePathError extends Error {
  override name = 'UnsafePathError';
}

const LINK_ADVICE = 'Affice never writes through symbolic links.';

/** Mode of a file only its owner should read. The umask can only remove more. */
export const PRIVATE_FILE = 0o600;
/** Mode of a folder only its owner should list. */
export const PRIVATE_FOLDER = 0o700;

/** lstat that answers null for a path that is not there (a dangling link is there). */
export function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

function notAFolder(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${path} is not a folder`), { code: 'EEXIST' });
}

/**
 * A real folder at `dir` (created when missing), directly inside the folder whose real path is
 * `parentReal`. Refuses a link and a folder that resolves anywhere else. Returns the folder's real path.
 * A file in the way is the same error mkdir gives (code EEXIST), so the caller's wording applies. `mode` is
 * the mode of a folder this call creates (PRIVATE_FOLDER); a folder that is already there keeps its own.
 */
export function ensureFolder(dir: string, parentReal: string, label: string, mode?: number): string {
  let info = lstatOrNull(dir);
  if (!info) {
    try {
      mkdirSync(dir, mode === undefined ? undefined : { mode });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    info = lstatSync(dir);
  }
  if (info.isSymbolicLink()) {
    throw new UnsafePathError(`${label} (${dir}) is a symbolic link. ${LINK_ADVICE} Replace it with a real folder, then open the project again.`);
  }
  if (!info.isDirectory()) throw notAFolder(dir);
  const real = realpathSync(dir);
  if (real !== join(parentReal, basename(dir))) {
    throw new UnsafePathError(`${label} (${dir}) leads outside the project (to ${real}). ${LINK_ADVICE} Replace it with a real folder, then open the project again.`);
  }
  return real;
}

/** Throws when `file` is a symbolic link or anything but a regular file. A file that is not there is fine. */
export function refuseUnlessPlainFile(file: string, label: string): void {
  const info = lstatOrNull(file);
  if (!info) return;
  if (info.isSymbolicLink()) throw new UnsafePathError(`${label} (${file}) is a symbolic link. ${LINK_ADVICE} Replace it with a real file, then open the project again.`);
  if (!info.isFile()) throw new UnsafePathError(`${label} (${file}) is not a regular file.`);
}

/** Creates `file` with `data` when nothing is there (a link, even a dangling one, counts as there). True when it was created. */
export function writeNewFile(file: string, data: string): boolean {
  try {
    writeFileSync(file, data, { flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

/**
 * Replaces `file` with `data` atomically: a temporary file next to it with a random name, made with `wx`
 * so a planted link of any name cannot be written through, then a rename (which replaces a directory entry
 * and never follows one). Refuses a target that is a link or not a regular file. The new file has `mode`
 * (PRIVATE_FILE for what is the user's alone), also when it replaces a file that had another one.
 */
export function writeFileAtomic(file: string, data: string, label = basename(file), mode = 0o644): void {
  refuseUnlessPlainFile(file, label);
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  let created = false;
  try {
    writeFileSync(temp, data, { flag: 'wx', mode });
    created = true;
    renameSync(temp, file);
  } catch (error) {
    if (created) rmSync(temp, { force: true });
    throw error;
  }
}

/** Appends `data` to the regular file `file`, creating it (with `mode`) when missing. Never follows a link. */
export function appendFileSafe(file: string, data: string, label = basename(file), mode = 0o644, retry = true): void {
  const info = lstatOrNull(file);
  if (info) refuseUnlessPlainFile(file, label);
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | noFollow | (info ? 0 : constants.O_EXCL);
  let fd: number;
  try {
    fd = openSync(file, flags, mode);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Created by someone else between the check and the open: look again (it may now be a link).
    if (code === 'EEXIST' && !info && retry) return appendFileSafe(file, data, label, mode, false);
    if (code === 'ELOOP' || code === 'EEXIST') throw new UnsafePathError(`${label} (${file}) is a symbolic link. ${LINK_ADVICE}`);
    throw error;
  }
  try {
    const buffer = Buffer.from(data);
    let offset = 0;
    while (offset < buffer.length) offset += writeSync(fd, buffer, offset);
  } finally {
    closeSync(fd);
  }
}
