// The data views of the room panel. The UI shell calls renderView when the
// user opens a tab; every view fetches /api/data/<department>/..., shows a loading state and
// a readable error, and cleans up in dispose().

import type { DataViewKind, Department } from '../../../shared/types';
import type { DataView } from './common';
import { renderBranches } from './branches';
import { renderDecisions } from './decisions';
import { renderKanban } from './kanban';
import { renderReports } from './reports';

export type { DataView } from './common';

export function renderView(kind: DataViewKind, container: HTMLElement, department: Department, trellaUrl: string): DataView {
  switch (kind) {
    case 'kanban':
      return renderKanban(container, department, trellaUrl);
    case 'branches':
      return renderBranches(container, department);
    case 'reports':
      return renderReports(container, department);
    case 'decisions':
      return renderDecisions(container, department);
  }
}
