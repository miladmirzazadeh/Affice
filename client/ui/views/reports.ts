// The Reports view: the department's report files, newest first. A click opens the file in a
// new tab through the report route, which serves only files from the configured folders.

import type { Department, ReportInfo, ReportsView } from '../../../shared/types';
import { createLoader, createRoot, dataUrl, el, localDay, openReport, reportUrl, type DataView } from './common';

export function renderReports(container: HTMLElement, department: Department): DataView {
  const { root, body } = createRoot(container, department, 'dv-reports');
  const loader = createLoader<ReportsView>({
    body,
    loading: 'Loading reports',
    url: () => dataUrl(department, 'reports'),
    draw: (view) => draw(body, department, view),
  });
  void loader.load();
  return {
    refresh: () => loader.load(),
    dispose() {
      loader.dispose();
      root.remove();
    },
  };
}

function draw(body: HTMLElement, department: Department, view: ReportsView): void {
  const count = view.reports.length;
  const bar = el('div', 'dv-bar', el('span', 'dv-title', 'Reports'), el('span', 'dv-dim dv-small', `${count} ${count === 1 ? 'file' : 'files'}, newest first`));

  if (count === 0) {
    const where = department.reportDirs.length > 0 ? department.reportDirs.join(', ') : 'any folder, none is set for this department';
    body.replaceChildren(bar, el('p', 'dv-empty', `No reports yet in ${where}.`));
    return;
  }
  const list = el('ul', 'dv-list');
  for (const report of view.reports) list.append(el('li', '', row(department, report)));
  body.replaceChildren(bar, list);
}

function row(department: Department, report: ReportInfo): HTMLAnchorElement {
  const date = el('span', 'dv-date');
  if (report.date) {
    date.textContent = report.date;
  } else {
    date.textContent = localDay(report.modifiedAt);
    date.classList.add('dv-date-inferred');
    date.title = 'No date in the file name: this is the day the file last changed.';
  }
  const title = el('span', 'dv-row-title', report.title);
  title.dir = 'auto';
  const link = el(
    'a',
    'dv-row',
    date,
    report.cardKey ? el('span', 'dv-chip dv-chip-key', report.cardKey) : el('span'),
    title,
    report.title === report.file ? null : el('span', 'dv-row-file', report.file),
  );
  link.href = reportUrl(department, report.path);
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  // The link alone would be refused (no token): a click, or a middle click, opens the report with a ticket.
  link.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    event.preventDefault();
    void openReport(department, report.path);
  });
  link.addEventListener('auxclick', (event) => {
    if (event.button !== 1) return;
    event.preventDefault();
    void openReport(department, report.path);
  });
  return link;
}
