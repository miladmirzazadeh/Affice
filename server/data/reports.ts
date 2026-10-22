// The reports of a department: the .md and .html files of its reportDirs, not recursive.
// Only the first 32 KB of a file is read, for its title. Contents are served by the report
// route in index.ts, never from here.
//
// A file is listed only when it passes the test the report route applies before it serves a file
// (SEC-13): its real path, symbolic links resolved, lies inside the real path of the report folder and
// is still a .md or .html file. A link that leaves the folder is skipped, so its target's first line
// is never read into a title.

import { open, readdir, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, resolve, sep } from 'node:path';
import { parseCardKey, type ReportInfo, type ReportsView } from '../../shared/types';

export const REPORT_EXTENSIONS = ['.md', '.html'];

const HEAD_BYTES = 32 * 1024;

/** The department's report directories as absolute paths, in order, without repeats. */
export function resolveReportDirs(dirs: string[], root: string): string[] {
  const all = dirs.map((dir) => (isAbsolute(dir) ? resolve(dir) : resolve(root, dir)));
  return all.filter((dir, index) => all.indexOf(dir) === index);
}

/** True when `file` lies inside one of `folders` (compared as paths: resolve symbolic links first). */
export function inside(file: string, folders: string[]): boolean {
  return folders.some((folder) => file.startsWith(folder.endsWith(sep) ? folder : folder + sep));
}

export async function readReports(dirs: string[], root: string): Promise<ReportsView> {
  const lists = await Promise.all(resolveReportDirs(dirs, root).map(listDir));
  const seen = new Set<string>();
  const reports: Array<ReportInfo & { sortDate: string; mtimeMs: number }> = [];
  for (const entry of lists.flat()) {
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    reports.push(entry);
  }

  // Newest first by date, then by modification time. A file without a date in its name is dated by
  // its modification day for the ordering only; its `date` field stays null.
  reports.sort(
    (a, b) => b.sortDate.localeCompare(a.sortDate) || b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file),
  );
  return {
    generatedAt: new Date().toISOString(),
    reports: reports.map(({ sortDate: _sortDate, mtimeMs: _mtimeMs, ...info }) => info),
  };
}

async function listDir(dir: string): Promise<Array<ReportInfo & { sortDate: string; mtimeMs: number }>> {
  let names: string[];
  let realDir: string;
  try {
    realDir = await realpath(dir);
    names = await readdir(realDir);
  } catch {
    return []; // a configured folder that does not exist yet has no reports
  }
  const wanted = names.filter((name) => REPORT_EXTENSIONS.includes(extname(name).toLowerCase()) && !name.startsWith('.'));
  const infos = await Promise.all(
    wanted.map(async (file) => {
      const path = join(dir, file);
      try {
        // The same test as serveReport: the real file is inside the real folder and still a report.
        const real = await realpath(path);
        if (!inside(real, [realDir]) || !REPORT_EXTENSIONS.includes(extname(real).toLowerCase())) return null;
        const info = await stat(real);
        if (!info.isFile()) return null;
        const date = dateFromName(file);
        const title = titleOf(file, await head(real));
        return {
          file,
          path,
          date,
          cardKey: parseCardKey(file),
          title,
          modifiedAt: info.mtime.toISOString(),
          sortDate: date ?? localDate(info.mtime),
          mtimeMs: info.mtimeMs,
        };
      } catch {
        return null; // unreadable or removed while listing
      }
    }),
  );
  return infos.filter((info) => info !== null);
}

async function head(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.toString('utf8', 0, bytesRead);
  } finally {
    await handle.close();
  }
}

export function dateFromName(file: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?![0-9])/.exec(file);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  const real = check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
  return real ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function localDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function titleOf(file: string, text: string): string {
  const found = extname(file).toLowerCase() === '.html' ? htmlTitle(text) : markdownTitle(text);
  return found && found.length > 0 ? found : file;
}

/** The first level-one heading, skipping YAML front matter and fenced code. */
export function markdownTitle(text: string): string | null {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  let index = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
    if (end > 0) index = end + 1;
  }
  let fence: string | null = null;
  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const opening = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (opening) {
      const marker = opening[1]![0]!;
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = /^#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (heading) {
      const title = heading[1]!.replace(/`/g, '').replace(/\*\*/g, '').trim();
      if (title) return title;
    }
  }
  return null;
}

function fromCode(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return ''; // not a code point
  }
}

export function htmlTitle(text: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text);
  if (!m) return null;
  const decoded = m[1]!
    .replace(/&#(\d+);/g, (_, code: string) => fromCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => fromCode(parseInt(code, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
  return decoded.replace(/\s+/g, ' ').trim() || null;
}
