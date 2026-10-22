// Starting points for a new department: a name, a color and a two sentence responsibility. The lobby's
// empty state offers them as quick buttons and the department form as "start from a template" chips; both
// only pre-fill the form, nothing is created until the user submits it. English copy, no dashes.

import { DEFAULT_REPORT_DIR } from '../../shared/folders';
import type { DepartmentColor } from '../../shared/types';

export interface DepartmentTemplate {
  id: string;
  name: string;
  color: DepartmentColor;
  responsibility: string;
  /** Where its reports are listed: the folder the protocol tells agents to write to. */
  reportDirs: string[];
}

export const DEPARTMENT_TEMPLATES: ReadonlyArray<DepartmentTemplate> = [
  {
    id: 'engineering',
    name: 'Engineering',
    color: 'indigo',
    responsibility:
      'Build and maintain the product. Turn every piece of work into a board card with acceptance criteria, delegate it to subagents, review what comes back, and ask me only for real decisions.',
    reportDirs: [DEFAULT_REPORT_DIR],
  },
  {
    id: 'marketing',
    name: 'Marketing',
    color: 'rose',
    responsibility:
      'Plan and write what tells people about the product: launch posts, website copy and the newsletter. Delegate drafts to subagents, review them, and ask me for approval before anything is published.',
    reportDirs: [DEFAULT_REPORT_DIR],
  },
  {
    id: 'product',
    name: 'Product',
    color: 'amber',
    responsibility:
      'Decide what gets built next. Collect feedback and ideas, turn them into small, clear cards on the board, and bring me the trade-offs whenever a choice is mine to make.',
    reportDirs: [DEFAULT_REPORT_DIR],
  },
  {
    id: 'support',
    name: 'Support',
    color: 'sky',
    responsibility:
      'Answer questions from people who use the product and keep a list of what keeps going wrong. Draft replies for me to approve, and file a card for every bug or request that needs another department.',
    reportDirs: [DEFAULT_REPORT_DIR],
  },
];

export function templateById(id: string | null | undefined): DepartmentTemplate | null {
  return DEPARTMENT_TEMPLATES.find((t) => t.id === id) ?? null;
}
