import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, FolderPlus, LayoutGrid, Plus, X } from 'lucide-react';
import { Button, Chip, Field, Icon, IconButton, inputClass } from './primitives';
import { useBoard } from '../lib/board';
import { cn } from '../lib/format';
import { COLUMN_COLORS, type ColumnColor } from '../lib/types';

const DEFAULT_WORKFLOW = ['Backlog', 'To do', 'In progress', 'Review', 'Done', 'Failed'];

/**
 * Which board am I looking at, and how do I get to another one. Boards are
 * grouped under their project, because that is the hierarchy agents address too.
 */
export function BoardSwitcher() {
  const { state, openBoard } = useBoard();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const current = state.board;
  const projects = state.projects.filter((project) =>
    state.boards.some((board) => board.projectId === project.id)
  );

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'motion-press flex max-w-[18rem] items-center gap-2 rounded-(--radius-control) px-2.5 py-1.5',
          'text-ui text-ink hover:bg-ink/5'
        )}
      >
        <Icon icon={LayoutGrid} size={16} className="text-ink-faint" />
        <span className="truncate">{current?.name ?? 'No board'}</span>
        {state.project && state.project.id !== 'general' && (
          <Chip className="hidden sm:inline-flex">{state.project.name}</Chip>
        )}
        <Icon icon={ChevronDown} size={14} className="text-ink-faint" />
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          className={cn(
            'motion-fade bg-overlay absolute start-0 top-full z-50 mt-1.5 w-80 overflow-hidden',
            'rounded-(--radius-panel) p-2 shadow-[var(--lift-panel)]'
          )}
        >
          <div className="scroll-quiet max-h-[60vh] overflow-y-auto">
            {projects.map((project) => (
              <section key={project.id} className="mb-2 last:mb-0">
                <h3 className="text-micro text-ink-faint px-2 py-1.5">{project.name}</h3>
                {state.boards
                  .filter((board) => board.projectId === project.id)
                  .map((board) => {
                    const active = board.id === current?.id;
                    return (
                      <button
                        key={board.id}
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setOpen(false);
                          if (!active) void openBoard(board.id);
                        }}
                        className={cn(
                          'flex w-full items-start gap-2 rounded-(--radius-field) px-2 py-1.5 text-start',
                          active ? 'bg-accent-soft text-accent-soft-ink' : 'hover:bg-ink/5'
                        )}
                      >
                        <span className="mt-[3px] w-3.5 shrink-0">
                          {active && <Icon icon={Check} size={14} beside="semibold" />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="text-ui block truncate">{board.name}</span>
                          <span className="text-caption text-ink-faint block truncate tabular-nums">
                            {board.openCount} open · {board.columns.length} columns ·{' '}
                            <span className="font-mono">{board.cardPrefix}-n</span>
                          </span>
                        </span>
                      </button>
                    );
                  })}
              </section>
            ))}
          </div>

          <div className="border-line mt-1 border-t pt-2">
            <Button
              size="sm"
              variant="ghost"
              className="w-full justify-start"
              onClick={() => {
                setOpen(false);
                setCreating(true);
              }}
            >
              <Icon icon={Plus} size={14} />
              New board
            </Button>
          </div>
        </div>
      )}

      {creating && <NewBoardDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

/**
 * Creating a board is where the workflow is decided, so the columns are editable
 * right here rather than hidden behind a settings screen afterwards.
 */
function NewBoardDialog({ onClose }: { onClose: () => void }) {
  const { state, createBoard, createProject, announce, toast } = useBoard();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameId = useId();
  const descriptionId = useId();
  const projectId = useId();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [project, setProject] = useState('general');
  const [newProject, setNewProject] = useState('');
  const [columns, setColumns] = useState<string[]>(DEFAULT_WORKFLOW);
  const [column, setColumn] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  const submit = async () => {
    if (!name.trim()) {
      setError('Give the board a name first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let target = project;
      if (project === '__new') {
        if (!newProject.trim()) {
          setError('Name the new project, or pick an existing one.');
          setBusy(false);
          return;
        }
        target = (await createProject({ name: newProject.trim() })).id;
      }
      const board = await createBoard({
        name: name.trim(),
        description: description.trim() || undefined,
        projectId: target,
        columns: columns.map((entry, index) => ({
          name: entry,
          color: COLUMN_COLORS[index % COLUMN_COLORS.length],
          terminal: /^(done|shipped|complete|completed|failed|cancelled|canceled)$/i.test(entry),
        })),
      });
      announce(`Created the board ${board.name}.`);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Unable to create the board.');
      toast('Unable to create the board.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose();
      }}
      className={cn(
        'bg-overlay text-ink m-auto w-[min(34rem,calc(100vw-3rem))] rounded-(--radius-panel) p-0',
        'shadow-[var(--lift-panel)] backdrop:bg-bone-1000/40'
      )}
    >
      <form
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="p-6"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-title text-ink">New board</h2>
            <p className="text-caption text-ink-faint mt-1 [text-wrap:pretty]">
              A board carries its own columns, so it can model whatever workflow this work needs.
            </p>
          </div>
          <IconButton icon={X} label="Close" onClick={onClose} />
        </div>

        <div className="mt-5 space-y-4">
          <Field label="Name" htmlFor={nameId}>
            <input
              id={nameId}
              autoFocus
              value={name}
              placeholder="Sprint 1"
              onChange={(event) => setName(event.target.value)}
              className={inputClass}
            />
          </Field>

          <Field
            label="Description"
            htmlFor={descriptionId}
            hint="One line about what belongs on this board. Agents read it too."
          >
            <input
              id={descriptionId}
              value={description}
              placeholder="Two weeks of platform work"
              onChange={(event) => setDescription(event.target.value)}
              className={inputClass}
            />
          </Field>

          <Field label="Project" htmlFor={projectId}>
            <select
              id={projectId}
              value={project}
              onChange={(event) => setProject(event.target.value)}
              className={cn(inputClass, 'h-10 py-0')}
            >
              {state.projects.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
              <option value="__new">New project…</option>
            </select>
          </Field>

          {project === '__new' && (
            <div className="flex items-center gap-2">
              <Icon icon={FolderPlus} size={16} className="text-ink-faint" />
              <input
                value={newProject}
                aria-label="New project name"
                placeholder="Platform"
                onChange={(event) => setNewProject(event.target.value)}
                className={inputClass}
              />
            </div>
          )}

          <div>
            <span className="text-micro text-ink-faint">Columns</span>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {columns.map((entry, index) => (
                <li key={`${entry}-${index}`}>
                  <Chip>
                    {entry}
                    <button
                      type="button"
                      aria-label={`Remove the ${entry} column`}
                      onClick={() => setColumns(columns.filter((_, i) => i !== index))}
                      className="text-ink-faint hover:text-ink -me-0.5 ms-0.5 rounded-full p-0.5"
                    >
                      <Icon icon={X} size={14} className="size-3" />
                    </button>
                  </Chip>
                </li>
              ))}
            </ul>
            <div className="mt-2 flex items-center gap-2">
              <input
                value={column}
                aria-label="Add a column"
                placeholder="Add a column"
                onChange={(event) => setColumn(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && column.trim()) {
                    event.preventDefault();
                    setColumns([...columns, column.trim()]);
                    setColumn('');
                  }
                }}
                className={cn(inputClass, 'h-9 w-48')}
              />
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  if (!column.trim()) return;
                  setColumns([...columns, column.trim()]);
                  setColumn('');
                }}
              >
                <Icon icon={Plus} size={14} />
                Add
              </Button>
              {columns.join('|') !== DEFAULT_WORKFLOW.join('|') && (
                <Button size="sm" variant="ghost" onClick={() => setColumns(DEFAULT_WORKFLOW)}>
                  Reset to the default six
                </Button>
              )}
            </div>
          </div>
        </div>

        {error && (
          <p role="alert" className="text-caption text-danger mt-4">
            {error}
          </p>
        )}

        <div className="mt-6 flex items-center gap-3">
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create board'}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </dialog>
  );
}

/** The colour choices offered wherever a column colour is edited. */
export function ColorPicker({
  value,
  onChange,
}: {
  value: ColumnColor;
  onChange: (color: ColumnColor) => void;
}) {
  const swatch: Record<ColumnColor, string> = {
    stone: 'bg-column-stone-mark',
    amber: 'bg-column-amber-mark',
    moss: 'bg-column-moss-mark',
    sky: 'bg-column-sky-mark',
    indigo: 'bg-column-indigo-mark',
    plum: 'bg-column-plum-mark',
    rose: 'bg-column-rose-mark',
  };
  return (
    <div role="radiogroup" aria-label="Column colour" className="flex gap-1.5">
      {COLUMN_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={value === color}
          aria-label={color}
          title={color}
          onClick={() => onChange(color)}
          className={cn(
            'relative grid size-6 place-items-center rounded-(--radius-field)',
            'after:absolute after:top-1/2 after:left-1/2 after:size-9 after:-translate-x-1/2 after:-translate-y-1/2',
            value === color ? 'ring-2 ring-(--focus-ring) ring-offset-2 ring-offset-(--surface-overlay)' : ''
          )}
        >
          <span aria-hidden="true" className={cn('size-3.5 rounded-full', swatch[color])} />
        </button>
      ))}
    </div>
  );
}
