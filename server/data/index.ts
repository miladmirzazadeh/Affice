// The data routes of the office. server/host.ts calls registerDataRoutes once.
//
//   GET /api/data/:department/branches[?refresh=1]   BranchesView
//   GET /api/data/:department/reports                ReportsView
//   GET /api/data/:department/decisions              DecisionsView
//   GET /api/data/:department/report?path=<absolute> one report file, raw (see RawResponse). Opens with the page
//                                                   token or with a ticket (below), since a link cannot send a header
//   GET /api/data/:department/report-ticket?path=    {ticket}: a one minute ticket for that one file
//
// Everything here is read-only.

import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, resolve } from 'node:path';
import { RouteError, type RawResponse, type RegisterDataRoutes } from '../../shared/server-api';
import { makeTicket } from '../auth';
import { RefreshGate } from '../coalesce';
import type { Department } from '../../shared/types';
import { readBranches } from './git';
import { inside, readReports, resolveReportDirs } from './reports';
import { readDecisions, TrellaMissing } from './trella';

const MAX_REPORT_BYTES = 5 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  '.md': 'text/markdown; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
};

/**
 * An HTML report is text an agent wrote, served from the office's own address. It runs nothing and loads
 * nothing: a sandbox with no flags (an opaque origin, no scripts, no forms, no popups, no navigation), no
 * network of any kind, and only inline styles and data: images. SEC-12.
 */
const HTML_HEADERS = {
  'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
  'content-disposition': 'inline',
  'x-content-type-options': 'nosniff',
};

/** A refresh of the branches (it runs git) is honoured once in this time per department; the others get the held snapshot. */
const BRANCH_REFRESH_GAP_MS = 5_000;

/** What a report ticket is for: one file of one department. */
const reportScope = (department: string, path: string | null) => `report:${department}:${path ?? ''}`;

export const registerDataRoutes: RegisterDataRoutes = (router, paths, departments) => {
  const find = (id: string): Department => {
    const department = departments.byId(id);
    if (!department) throw new RouteError(404, `There is no department "${id}".`);
    return department;
  };

  const refreshes = new RefreshGate(BRANCH_REFRESH_GAP_MS);
  router.get('/api/data/:department/branches', async ({ params, query }) => {
    const department = find(params.department);
    const refresh = query.get('refresh') === '1' || query.get('refresh') === 'true';
    if (!refresh) return readBranches(department.repos, paths.project, { refresh: false });
    // SEC-09: a refresh runs git, so it is shared while it runs and not repeated within a few seconds.
    return refreshes.run(
      department.id,
      () => readBranches(department.repos, paths.project, { refresh: true }),
      () => readBranches(department.repos, paths.project, { refresh: false }),
    );
  });

  router.get('/api/data/:department/reports', async ({ params }) => {
    const department = find(params.department);
    return readReports(department.reportDirs, paths.root);
  });

  router.get('/api/data/:department/decisions', async ({ params }) => {
    const department = find(params.department);
    try {
      return await readDecisions(paths.root, paths.trellaUrl, department);
    } catch (error) {
      if (error instanceof TrellaMissing) throw new RouteError(503, error.message);
      throw error;
    }
  });

  router.get(
    '/api/data/:department/report',
    async ({ params, query }) => {
      const department = find(params.department);
      return serveReport(department, paths.root, query.get('path'));
    },
    { ticketScope: ({ params, query }) => reportScope(params.department, query.get('path')) },
  );

  // The page asks (with its token) for the ticket that lets a link open one report in a new tab.
  router.get('/api/data/:department/report-ticket', ({ params, query }) => {
    const department = find(params.department);
    const path = query.get('path');
    if (!path) throw new RouteError(400, 'The path parameter is missing.');
    return { ticket: makeTicket(reportScope(department.id, path)) };
  });
};

/** A report file, only when it lies inside one of the department's report directories (symlinks resolved). */
export async function serveReport(department: Department, root: string, requested: string | null): Promise<RawResponse> {
  if (!requested) throw new RouteError(400, 'The path parameter is missing.');
  if (!isAbsolute(requested)) throw new RouteError(400, 'The path must be absolute.');

  const folders = resolveReportDirs(department.reportDirs, root);
  const realFolders: string[] = [];
  for (const folder of folders) {
    try {
      realFolders.push(await realpath(folder));
    } catch {
      // the folder does not exist, so nothing inside it can be served
    }
  }

  // Outside the folders on paper: refuse before touching the disk, so a probe learns nothing about other files.
  if (!inside(resolve(requested), [...folders, ...realFolders])) {
    throw new RouteError(403, 'That file is not in one of this department\'s report folders.');
  }

  let real: string;
  try {
    real = await realpath(requested);
  } catch {
    throw new RouteError(404, 'There is no such report.');
  }
  if (!inside(real, realFolders)) throw new RouteError(403, 'That file is not in one of this department\'s report folders.');

  const extension = extname(real).toLowerCase();
  const contentType = CONTENT_TYPES[extension];
  if (!contentType) throw new RouteError(403, 'Only .md and .html reports are served.');

  const info = await stat(real);
  if (!info.isFile()) throw new RouteError(404, 'There is no such report.');
  if (info.size > MAX_REPORT_BYTES) throw new RouteError(413, 'That report is too large to open here.');

  const body = await readFile(real, 'utf8');
  const headers = extension === '.html' ? HTML_HEADERS : { 'x-content-type-options': 'nosniff', 'content-disposition': 'inline' };
  return { contentType, body, headers };
}
