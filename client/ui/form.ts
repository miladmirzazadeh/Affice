// The department form, for Add and Edit: name, color, responsibility (it becomes the manager's
// instructions), working directory, model, permission policy, repos, report folders and knowledge
// folders, with a message beside each field that needs one. Add starts from a template when the lobby
// asks for one and offers "start from a template" chips; they only fill the name, the color and the
// responsibility. Submitting sends department.create or department.update; Edit also offers Remove
// behind a confirmation.

import type { OfficeState } from '../../shared/scene-api';
import { broadFolder, broadFolderMessage, DEFAULT_REPORT_DIR } from '../../shared/folders';
import {
  DEPARTMENT_COLORS,
  MODELS,
  modelLabel,
  type Department,
  type DepartmentColor,
  type DepartmentInput,
  type DepartmentPatch,
  type ModelId,
  type PermissionPolicy,
  type RepoRef,
  type ServerEvent,
} from '../../shared/types';
import type { Store } from '../state/store';
import type { Emitter, FormState } from '../state/ui';
import { h, icon, setText } from './dom';
import { canSend, colorVar } from './derive';
import { POLICY } from './format';
import { DEPARTMENT_TEMPLATES, templateById } from './templates';

export interface DepartmentForm {
  el: HTMLDialogElement;
  /** Opens, closes or retargets the dialog to match the UI state. */
  sync(form: FormState, state: OfficeState): void;
  isOpen(): boolean;
}

export interface FormDeps {
  store: Store;
  events: Emitter<ServerEvent>;
  onClosed(): void;
  onCreated(id: string): void;
  onRemoved(id: string): void;
}

interface Values {
  name: string;
  color: DepartmentColor;
  responsibility: string;
  cwd: string;
  model: ModelId;
  permission: PermissionPolicy;
  repos: RepoRef[];
  reportDirs: string[];
  knowledgeDirs: string[];
}


type FieldName = 'name' | 'responsibility' | 'cwd' | 'repos' | 'reports' | 'knowledge';
type Errors = Partial<Record<FieldName, string>>;

const FIELD_ORDER: FieldName[] = ['name', 'responsibility', 'cwd', 'repos', 'reports', 'knowledge'];
const POLICIES: PermissionPolicy[] = ['ask', 'accept-edits', 'read-only'];
const DEFAULT_MODEL: ModelId = 'sonnet';
const NAME_MAX = 40;
const RESPONSIBILITY_MIN = 20;
const CONFIRM_TIMEOUT_MS = 10000;

const COLOR_LABEL: Record<DepartmentColor, string> = {
  stone: 'Stone',
  amber: 'Amber',
  moss: 'Moss',
  sky: 'Sky',
  indigo: 'Indigo',
  plum: 'Plum',
  rose: 'Rose',
};

/** The id the server derives from a name (the mock does the same), to catch two names that collide. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 32);
}

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function repoName(path: string): string {
  const clean = path.replace(/\/+$/, '');
  return clean === '' || clean === '.' ? 'root' : (clean.split('/').pop() ?? clean);
}

/** One repo per line: `path base`, or `name path base` when the name differs from the folder. */
export function parseRepos(text: string): { repos: RepoRef[]; error: string | null } {
  const repos: RepoRef[] = [];
  const rows = text.split('\n');
  for (let i = 0; i < rows.length; i += 1) {
    const parts = rows[i].trim().split(/\s+/).filter(Boolean);
    if (!parts.length) continue;
    if (parts.length > 3) return { repos, error: `Line ${i + 1} has ${parts.length} parts. Write the path, then the base branch.` };
    const repo: RepoRef =
      parts.length === 3
        ? { name: parts[0], path: parts[1], base: parts[2] }
        : { name: repoName(parts[0]), path: parts[0], base: parts[1] ?? 'main' };
    if (repos.some((r) => r.name === repo.name)) {
      return { repos, error: `Two repos are named ${repo.name}. Put a different name first on one line: name path base.` };
    }
    repos.push(repo);
  }
  return { repos, error: null };
}

/**
 * The folders of the form that are too broad: the root of the disk or the home folder (the usual places: the
 * page cannot ask where yours is, and the server checks the real one again). A relative path is the server's to judge.
 */
export function broadFolderErrors(values: Pick<Values, 'repos' | 'reportDirs' | 'knowledgeDirs'>): Partial<Record<'repos' | 'reports' | 'knowledge', string>> {
  const found: Partial<Record<'repos' | 'reports' | 'knowledge', string>> = {};
  const first = (paths: string[], label: string): string | undefined => {
    for (const path of paths) {
      const reason = broadFolder(path);
      if (reason) return broadFolderMessage(label, path, reason);
    }
    return undefined;
  };
  const repos = first(values.repos.map((repo) => repo.path), 'A repository path');
  const reports = first(values.reportDirs, 'A report folder');
  const knowledge = first(values.knowledgeDirs, 'A knowledge folder');
  if (repos) found.repos = repos;
  if (reports) found.reports = reports;
  if (knowledge) found.knowledge = knowledge;
  return found;
}

export function formatRepos(repos: RepoRef[]): string {
  return repos.map((r) => (r.name === repoName(r.path) ? `${r.path} ${r.base}` : `${r.name} ${r.path} ${r.base}`)).join('\n');
}

export function createDepartmentForm(deps: FormDeps): DepartmentForm {
  let latest: OfficeState = deps.store.getState();
  /** The form request last acted on. A request opens the dialog once; a closed dialog never reopens from a stale one. */
  let handled: FormState = null;
  let editing: Department | null = null;
  let attempted = false;
  let waiting: { timer: number; offStore: () => void; offEvents: () => void } | null = null;

  // Fields.
  const title = h('h2', { class: 'form-title', id: 'df-title' });
  const subtitle = h('p', { class: 'form-sub' });
  const closeButton = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close the form' }, icon('close'));

  const nameInput = h('input', { class: 'input', type: 'text', autocomplete: 'off', maxlength: NAME_MAX, dir: 'auto', spellcheck: 'false' });
  const responsibilityInput = h('textarea', { class: 'input', rows: '5', dir: 'auto' });
  const cwdInput = h('input', { class: 'input input--mono', type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: '/path/to/your/project' });
  const modelSelect = h('select', { class: 'input' });
  for (const [id, label] of Object.entries(MODELS)) modelSelect.append(h('option', { value: id, text: label }));
  const reposInput = h('textarea', { class: 'input input--mono', rows: '3', spellcheck: 'false', placeholder: 'api main\nweb main' });
  const reportsInput = h('textarea', { class: 'input input--mono', rows: '2', spellcheck: 'false', placeholder: 'reports' });
  const knowledgeInput = h('textarea', { class: 'input input--mono', rows: '2', spellcheck: 'false', placeholder: 'docs\nOffice' });

  const errors: Record<FieldName, HTMLElement> = {
    name: h('p', { class: 'field-error', id: 'df-name-error', hidden: true }),
    responsibility: h('p', { class: 'field-error', id: 'df-responsibility-error', hidden: true }),
    cwd: h('p', { class: 'field-error', id: 'df-cwd-error', hidden: true }),
    repos: h('p', { class: 'field-error', id: 'df-repos-error', hidden: true }),
    reports: h('p', { class: 'field-error', id: 'df-reports-error', hidden: true }),
    knowledge: h('p', { class: 'field-error', id: 'df-knowledge-error', hidden: true }),
  };
  const controls: Record<FieldName, HTMLInputElement | HTMLTextAreaElement> = {
    name: nameInput,
    responsibility: responsibilityInput,
    cwd: cwdInput,
    repos: reposInput,
    reports: reportsInput,
    knowledge: knowledgeInput,
  };

  function field(id: string, label: string, control: HTMLElement, hint: string | null, error: HTMLElement | null): HTMLElement {
    control.id = id;
    const described = [hint ? `${id}-hint` : '', error ? error.id : ''].filter(Boolean).join(' ');
    if (described) control.setAttribute('aria-describedby', described);
    return h(
      'div',
      { class: 'field' },
      h('label', { class: 'field-label', for: id, text: label }),
      control,
      hint ? h('p', { class: 'field-hint', id: `${id}-hint`, text: hint }) : null,
      error,
    );
  }

  const swatches = h('div', { class: 'swatches' });
  for (const color of DEPARTMENT_COLORS) {
    const radio = h('input', { type: 'radio', name: 'df-color', value: color, 'aria-label': COLOR_LABEL[color] });
    radio.addEventListener('change', () => applyAccent(color));
    const option = h('label', { class: 'swatch-opt', title: COLOR_LABEL[color] }, radio, h('span', { class: 'swatch-dot', 'aria-hidden': 'true' }));
    option.style.setProperty('--c', colorVar(color));
    swatches.append(option);
  }

  const policies = h('div', { class: 'policies' });
  for (const policy of POLICIES) {
    const radio = h('input', { type: 'radio', name: 'df-permission', value: policy, 'aria-describedby': `df-policy-${policy}` });
    policies.append(
      h(
        'label',
        { class: 'policy' },
        radio,
        h('span', { class: 'policy-label', text: POLICY[policy].label }),
        h('span', { class: 'policy-line', id: `df-policy-${policy}`, text: POLICY[policy].line }),
      ),
    );
  }

  const formError = h('p', { class: 'form-error', role: 'alert', hidden: true });

  // "Start from a template": fills the name, the color and the responsibility. Add only.
  const chips = h('div', { class: 'template-chips' });
  for (const template of DEPARTMENT_TEMPLATES) {
    const chip = h(
      'button',
      { class: 'template-chip', type: 'button', 'data-template': template.id },
      h('span', { class: 'template-dot', 'aria-hidden': 'true' }),
      h('span', { text: template.name }),
    );
    chip.style.setProperty('--c', colorVar(template.color));
    chip.addEventListener('click', () => {
      applyTemplate(template.id);
      nameInput.focus();
    });
    chips.append(chip);
  }
  const templates = h('div', { class: 'field', 'data-role': 'templates' }, h('span', { class: 'field-label', id: 'df-templates-label', text: 'Start from a template' }), chips);
  chips.setAttribute('role', 'group');
  chips.setAttribute('aria-labelledby', 'df-templates-label');

  const knowledgeField = field(
    'df-knowledge',
    'Knowledge folders',
    knowledgeInput,
    'One folder per line, absolute or relative to the project. The manager reads them for context. Optional.',
    errors.knowledge,
  );
  const knowledgeHint = knowledgeField.querySelector('.field-hint') as HTMLElement;

  const body = h(
    'div',
    { class: 'form-body' },
    templates,
    field('df-name', 'Name', nameInput, null, errors.name),
    h('fieldset', { class: 'field' }, h('legend', { class: 'field-label', text: 'Color' }), swatches),
    field(
      'df-responsibility',
      'Responsibility',
      responsibilityInput,
      "This becomes the manager's instructions: what the department owns, what it delivers, and when it should ask you.",
      errors.responsibility,
    ),
    h(
      'div',
      { class: 'form-row' },
      field('df-cwd', 'Working directory', cwdInput, 'The folder the manager session runs in.', errors.cwd),
      field('df-model', 'Model', modelSelect, 'The manager runs on it.', null),
    ),
    h('fieldset', { class: 'field' }, h('legend', { class: 'field-label', text: 'Permission policy' }), policies),
    field(
      'df-repos',
      'Repositories',
      reposInput,
      'One per line: the path, then the base branch. Paths are absolute or relative to the project folder, so . is the project itself.',
      errors.repos,
    ),
    field(
      'df-reports',
      'Report folders',
      reportsInput,
      `One folder per line, absolute or relative to the Office folder. A new department starts with ${DEFAULT_REPORT_DIR}, the folder the protocol tells agents to write to.`,
      errors.reports,
    ),
    knowledgeField,
    formError,
  );

  // Footer, with Remove and its confirmation in Edit.
  const removeButton = h('button', { class: 'btn btn--danger-quiet', type: 'button', text: 'Remove department' });
  const cancelButton = h('button', { class: 'btn', type: 'button', text: 'Cancel' });
  const submitButton = h('button', { class: 'btn btn--primary', type: 'submit' });
  const actions = h(
    'div',
    { class: 'form-actions' },
    h('div', { class: 'form-actions-start' }, removeButton),
    h('div', { class: 'form-actions-end' }, cancelButton, submitButton),
  );
  const confirmText = h('p', { class: 'confirm-text' });
  const keepButton = h('button', { class: 'btn', type: 'button', text: 'Keep it' });
  const confirmButton = h('button', { class: 'btn btn--danger', type: 'button', text: 'Remove' });
  const confirm = h('div', { class: 'form-confirm', role: 'alertdialog', 'aria-labelledby': 'df-confirm-text', hidden: true }, confirmText, h('div', { class: 'form-actions-end' }, keepButton, confirmButton));
  confirmText.id = 'df-confirm-text';
  const footer = h('footer', { class: 'form-foot' }, actions, confirm);

  const form = h(
    'form',
    { class: 'dept-form', novalidate: true },
    h('header', { class: 'form-head' }, h('div', {}, title, subtitle), closeButton),
    body,
    footer,
  );
  const dialog = h('dialog', { class: 'dept-dialog', 'aria-labelledby': 'df-title' }, form);

  function applyAccent(color: DepartmentColor) {
    dialog.style.setProperty('--form-accent', colorVar(color));
  }

  /** Fills the name, the color and the responsibility from a template. The rest of the form stays as it is. */
  function applyTemplate(id: string) {
    const template = templateById(id);
    if (!template) return;
    nameInput.value = template.name;
    responsibilityInput.value = template.responsibility;
    setChecked('df-color', template.color);
    applyAccent(template.color);
    if (attempted) {
      const { values, reposError } = read();
      showErrors(validate(values, reposError));
    }
  }

  function checked(name: string): string | null {
    return form.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value ?? null;
  }

  function setChecked(name: string, value: string) {
    for (const input of form.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)) input.checked = input.value === value;
  }

  function read(): { values: Values; reposError: string | null } {
    const repos = parseRepos(reposInput.value);
    return {
      values: {
        name: nameInput.value.trim(),
        color: (checked('df-color') ?? 'stone') as DepartmentColor,
        responsibility: responsibilityInput.value.trim(),
        cwd: cwdInput.value.trim(),
        model: modelSelect.value as ModelId,
        permission: (checked('df-permission') ?? 'ask') as PermissionPolicy,
        repos: repos.repos,
        reportDirs: lines(reportsInput.value),
        knowledgeDirs: lines(knowledgeInput.value),
      },
      reposError: repos.error,
    };
  }

  function validate(values: Values, reposError: string | null): Errors {
    const found: Errors = {};
    const others = latest.config.departments.filter((d) => d.id !== editing?.id);
    const slug = slugify(values.name);
    if (!values.name) found.name = 'Give the department a name.';
    else if (values.name.length > NAME_MAX) found.name = `Keep the name to ${NAME_MAX} characters.`;
    else if (others.some((d) => d.name.trim().toLowerCase() === values.name.toLowerCase())) found.name = `There is already a department called ${values.name}.`;
    else if (!editing && slug && others.some((d) => d.id === slug)) found.name = 'That name is too close to an existing department. Pick another.';
    if (!values.responsibility) found.responsibility = 'Write what this department is responsible for. The manager works from it.';
    else if (values.responsibility.length < RESPONSIBILITY_MIN) found.responsibility = 'Write at least a full sentence, so the manager knows what it owns.';
    if (!values.cwd) found.cwd = 'Give the folder the manager works in.';
    else if (!values.cwd.startsWith('/')) found.cwd = 'Use an absolute path, one that starts with a slash.';
    if (reposError) found.repos = reposError;
    // The root of the disk and the home folder are not folders to hand to a manager or to the report viewer.
    const broad = broadFolderErrors(values);
    if (!found.repos && broad.repos) found.repos = broad.repos;
    if (broad.reports) found.reports = broad.reports;
    if (broad.knowledge) found.knowledge = broad.knowledge;
    return found;
  }

  function showErrors(found: Errors) {
    for (const name of FIELD_ORDER) {
      const text = found[name] ?? '';
      errors[name].hidden = !text;
      setText(errors[name], text);
      if (text) controls[name].setAttribute('aria-invalid', 'true');
      else controls[name].removeAttribute('aria-invalid');
    }
  }

  function showFormError(text: string) {
    formError.hidden = !text;
    setText(formError, text);
  }

  function setSubmitting(on: boolean) {
    submitButton.disabled = on;
    form.setAttribute('aria-busy', String(on));
    setText(submitButton, on ? 'Adding' : editing ? 'Save changes' : 'Add department');
  }

  function stopWaiting() {
    if (!waiting) return;
    waiting.offStore();
    waiting.offEvents();
    window.clearTimeout(waiting.timer);
    waiting = null;
    setSubmitting(false);
  }

  /** Waits for the server's department.created (the mock answers at once) or an error. */
  function startWaiting() {
    const before = new Set(deps.store.getState().config.departments.map((d) => d.id));
    const offStore = deps.store.subscribe((state) => {
      const created = state.config.departments.find((d) => !before.has(d.id));
      if (!created) return;
      stopWaiting();
      dialog.close();
      queueMicrotask(() => deps.onCreated(created.id));
    });
    const offEvents = deps.events.on((event) => {
      if (event.type !== 'error' || (event.department !== null && before.has(event.department))) return;
      stopWaiting();
      showFormError(event.message);
    });
    const timer = window.setTimeout(() => {
      stopWaiting();
      showFormError('The office did not confirm the new department. Check the connection and try again.');
    }, CONFIRM_TIMEOUT_MS);
    waiting = { timer, offStore, offEvents };
    setSubmitting(true);
  }

  function patchFor(department: Department, values: Values): DepartmentPatch {
    const patch: DepartmentPatch = {};
    if (values.name !== department.name) patch.name = values.name;
    if (values.color !== department.color) patch.color = values.color;
    if (values.responsibility !== department.responsibility.trim()) patch.responsibility = values.responsibility;
    if (values.cwd !== department.cwd) patch.cwd = values.cwd;
    if (values.model !== department.model) patch.model = values.model;
    if (values.permission !== department.permission) patch.permission = values.permission;
    if (JSON.stringify(values.repos) !== JSON.stringify(department.repos)) patch.repos = values.repos;
    if (JSON.stringify(values.reportDirs) !== JSON.stringify(department.reportDirs)) patch.reportDirs = values.reportDirs;
    // An empty list clears the folders: the server then applies the default (the general manager's Office folder and README).
    if (JSON.stringify(values.knowledgeDirs) !== JSON.stringify(department.knowledgeDirs ?? [])) patch.knowledgeDirs = values.knowledgeDirs;
    return patch;
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (waiting) return;
    attempted = true;
    showFormError('');
    const { values, reposError } = read();
    const found = validate(values, reposError);
    showErrors(found);
    const first = FIELD_ORDER.find((name) => found[name]);
    if (first) {
      controls[first].focus();
      return;
    }
    if (!canSend(deps.store.getState())) {
      showFormError('The office is offline. Try again once it reconnects.');
      return;
    }
    if (!editing) {
      // An empty list is not sent: the new department has no knowledge folders until the user names some.
      const { knowledgeDirs, ...rest } = values;
      const input: DepartmentInput = knowledgeDirs.length ? { ...rest, knowledgeDirs } : { ...rest };
      startWaiting();
      deps.store.send({ type: 'department.create', input });
      return;
    }
    const patch = patchFor(editing, values);
    if (Object.keys(patch).length) deps.store.send({ type: 'department.update', id: editing.id, patch });
    dialog.close();
  });

  form.addEventListener('input', () => {
    if (!attempted) return;
    const { values, reposError } = read();
    showErrors(validate(values, reposError));
  });

  closeButton.addEventListener('click', () => dialog.close());
  cancelButton.addEventListener('click', () => dialog.close());
  removeButton.addEventListener('click', () => showConfirm(true));
  keepButton.addEventListener('click', () => showConfirm(false));
  confirmButton.addEventListener('click', () => {
    if (!editing) return;
    if (!canSend(deps.store.getState())) {
      showConfirm(false);
      showFormError('The office is offline. Try again once it reconnects.');
      return;
    }
    const id = editing.id;
    deps.store.send({ type: 'department.remove', id });
    dialog.close();
    deps.onRemoved(id);
  });

  function showConfirm(on: boolean) {
    confirm.hidden = !on;
    actions.hidden = on;
    if (on) {
      setText(confirmText, `Remove ${editing?.name ?? 'this department'}? Its manager session stops. The Trella board stays.`);
      keepButton.focus();
    }
  }

  dialog.addEventListener('close', () => {
    stopWaiting();
    showConfirm(false);
    editing = null;
    deps.onClosed();
  });

  function open(request: Exclude<FormState, null>, state: OfficeState) {
    editing = request.mode === 'edit' ? (state.config.departments.find((d) => d.id === request.id) ?? null) : null;
    const used = new Set(state.config.departments.map((d) => d.color));
    const template = request.mode === 'add' ? templateById(request.template) : null;
    const values: Values = editing
      ? {
          name: editing.name,
          color: editing.color,
          responsibility: editing.responsibility,
          cwd: editing.cwd,
          model: editing.model,
          permission: editing.permission,
          repos: editing.repos,
          reportDirs: editing.reportDirs,
          knowledgeDirs: editing.knowledgeDirs ?? [],
        }
      : {
          name: template?.name ?? '',
          color: template?.color ?? DEPARTMENT_COLORS.find((c) => !used.has(c)) ?? 'stone',
          responsibility: template?.responsibility ?? '',
          cwd: state.config.departments[0]?.cwd ?? '',
          model: DEFAULT_MODEL,
          permission: 'ask',
          repos: [],
          reportDirs: template?.reportDirs ?? [DEFAULT_REPORT_DIR],
          knowledgeDirs: [],
        };

    attempted = false;
    showErrors({});
    showFormError('');
    showConfirm(false);
    stopWaiting();
    setText(title, editing ? `Edit ${editing.name}` : 'Add department');
    setText(
      subtitle,
      editing ? 'Changes reach the manager at its next session.' : 'A new room with its own manager, and a Trella board for its work.',
    );
    setSubmitting(false);
    // The general manager of the lobby cannot be removed.
    removeButton.hidden = !editing || editing.kind === 'lobby';
    // Templates start a new department. Knowledge folders: the lobby's general manager has a default, say which.
    templates.hidden = !!editing;
    const lobby = editing?.kind === 'lobby';
    setText(
      knowledgeHint,
      lobby
        ? 'One folder per line, absolute or relative to the project. Leave it empty to use the default: the Office folder and the project README.'
        : 'One folder per line, absolute or relative to the project. The manager reads them for context. Optional.',
    );

    nameInput.value = values.name;
    setChecked('df-color', values.color);
    applyAccent(values.color);
    responsibilityInput.value = values.responsibility;
    cwdInput.value = values.cwd;
    if (![...modelSelect.options].some((o) => o.value === values.model)) {
      modelSelect.append(h('option', { value: values.model, text: values.model }));
    }
    // A full model id typed in affice.json is kept: offer it next to the aliases.
    if (![...modelSelect.options].some((o) => o.value === values.model)) modelSelect.append(h('option', { value: values.model, text: modelLabel(values.model) }));
    modelSelect.value = values.model;
    setChecked('df-permission', values.permission);
    reposInput.value = formatRepos(values.repos);
    reportsInput.value = values.reportDirs.join('\n');
    knowledgeInput.value = values.knowledgeDirs.join('\n');

    if (!dialog.open) dialog.showModal();
    body.scrollTop = 0;
    nameInput.focus();
  }

  return {
    el: dialog,
    sync(next, state) {
      latest = state;
      if (next === handled) return;
      handled = next;
      if (!next) {
        if (dialog.open) dialog.close();
        return;
      }
      if (next.mode === 'edit' && !state.config.departments.some((d) => d.id === next.id)) {
        if (dialog.open) dialog.close();
        else deps.onClosed();
        return;
      }
      open(next, state);
    },
    isOpen: () => dialog.open,
  };
}
