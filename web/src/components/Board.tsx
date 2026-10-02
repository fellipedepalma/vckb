import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  type PointerSensorOptions,
  TouchSensor,
  type UniqueIdentifier,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { type PointerEvent as ReactPointerEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { DONE_COLUMN, filesWithWarnings, groupByColumn, REVIEW_COLUMN } from '../board-model';
import { strings } from '../strings';
import type { BoardSnapshot, BoardWarning, Task } from '../types';

function WarningMark({ label, className = "size-4 text-danger" }: { label?: string, className?: string }) {
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true };
  return (
    <svg viewBox="0 0 16 16" className={`shrink-0 ${className}`} {...a11y}>
      {label && <title>{label}</title>}
      <path fill="currentColor" d="M8 1.5 15 14H1L8 1.5Zm-.9 4.6.2 4.3h1.4l.2-4.3H7.1Zm.9 5.4a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8Z" />
    </svg>
  );
}

function PriorityIcon({ priority, className }: { priority: string, className?: string }) {
  if (priority === 'high') {
    return <svg className={className} viewBox="0 0 16 16" fill="currentColor"><path d="M8 0l8 16H0L8 0z" /></svg>;
  }
  if (priority === 'medium') {
    return <svg className={className} viewBox="0 0 16 16" fill="currentColor"><rect x="2" y="4" width="12" height="8" rx="2" /></svg>;
  }
  return <svg className={className} viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="6" /></svg>;
}

function ProgressCheck({ done, total, className }: { done: number; total: number; className?: string }) {
  return (
    <span className={`flex items-center gap-1.5 ${className}`} title={strings.task.checklist(done, total)}>
      <svg className="size-3.5" viewBox="0 0 16 16" fill="currentColor">
        <path fillRule="evenodd" d="M14 3v10H2V3h12zm1-1H1v12h14V2z" />
        <path d="M11.5 5.5l-4 4-2-2L4.5 8.5l3 3 5-5-1-1z" />
      </svg>
      <span className="tabular-nums font-mono text-[11px] font-medium" aria-hidden="true">{done}/{total}</span>
      <span className="sr-only">{strings.task.checklist(done, total)}</span>
    </span>
  );
}

/** `overlay`: the copy that follows the pointer while dragging (mint border, slight elevation). */
export function TaskCard({ task, warned, quiet = false, overlay = false }: { task: Task; warned: boolean; quiet?: boolean; overlay?: boolean }) {
  const titleId = useId();
  
  const bgClass = quiet ? 'bg-done-surface' : 'bg-surface hover:bg-surface-2 focus-within:bg-surface-2';
  const borderClass = overlay
    ? 'border-accent shadow-[0_10px_28px_rgba(0,0,0,0.5)] cursor-grabbing'
    : quiet
      ? 'border-line'
      : 'border-line hover:border-accent focus-within:border-accent';
  const titleTextClass = quiet ? 'text-done-text' : 'text-text';
  const shadowClass = quiet ? '' : 'shadow-sm hover:shadow-[0_1px_3px_rgba(0,0,0,0.3)] transition-[background-color,border-color,box-shadow,transform]';
  
  const prioColor = task.priority === 'high' ? 'text-danger' : task.priority === 'medium' ? 'text-accent-2' : 'text-muted';

  return (
    <article
      aria-labelledby={titleId}
      tabIndex={overlay ? -1 : 0}
      className={`rounded-[7px] border ${borderClass} ${bgClass} p-3 ${shadowClass} outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent`}
    >
      <div className="flex items-center gap-2 text-[11px] text-muted">
        <span className="font-mono font-medium text-accent uppercase tracking-wider">{task.id}</span>
        <div className={`flex items-center gap-1 font-medium uppercase tracking-widest ${quiet ? 'text-done-text' : prioColor}`}>
          <PriorityIcon priority={task.priority} className="size-3" />
          <span>{strings.task.priority[task.priority]}</span>
        </div>
        <span className="sr-only">{strings.task.priorityFull(task.priority)}</span>
        
        {task.progress.total > 0 && (
          <ProgressCheck done={task.progress.done} total={task.progress.total} className={`ml-auto ${quiet ? 'text-done-text' : 'text-muted'}`} />
        )}
      </div>
      <h3 id={titleId} className={`mt-1.5 line-clamp-2 text-[14px] font-medium leading-snug [overflow-wrap:anywhere] ${titleTextClass}`}>
        {task.title}
      </h3>
      
      {(task.labels.length > 0 || warned) && (
        <div className="mt-2.5 flex items-center justify-between">
          {task.labels.length > 0 && (
            <ul className="flex flex-wrap gap-1" aria-label={strings.board.labelsAria}>
              {task.labels.map((l) => (
                <li key={l} className={`rounded px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-widest ${quiet ? 'bg-done-surface text-done-text border border-line' : 'bg-surface-2 text-muted border border-line'}`}>
                  {l}
                </li>
              ))}
            </ul>
          )}
          {warned && <WarningMark className="size-3.5 text-danger" label={strings.task.hasWarnings} />}
        </div>
      )}
      
      {task.progress.total > 0 && (
        <div className="mt-3 h-[3px] w-[32px] overflow-hidden rounded-full bg-line">
          <div className="h-full bg-accent" style={{ width: `${Math.round((task.progress.done / task.progress.total) * 100)}%` }} />
        </div>
      )}
    </article>
  );
}

/** Mouse and pen: a drag starts after 8px of movement, so a plain click never moves a card. */
class MousePenSensor extends PointerSensor {
  static activators = [
    {
      eventName: 'onPointerDown' as const,
      handler: ({ nativeEvent: e }: ReactPointerEvent, { onActivation }: PointerSensorOptions) => {
        if (e.pointerType === 'touch' || !e.isPrimary || e.button !== 0) return false;
        onActivation?.({ event: e });
        return true;
      },
    },
  ];
}

const COLUMN_ID = 'col:';
const columnId = (name: string) => `${COLUMN_ID}${name}`;

/**
 * A draggable card. Only the pointer/touch listeners are attached (no dnd-kit `attributes`):
 * keyboard semantics for moving cards come in a later step.
 */
function SortableCard({ task, warned, quiet }: { task: Task; warned: boolean; quiet: boolean }) {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({ id: task.file });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className="touch-manipulation"
      {...listeners}
    >
      {isDragging ? (
        // Where the card will land: a dashed mint outline of the same size (no opacity tricks).
        <div className="rounded-[7px] border border-dashed border-accent">
          <div className="invisible" aria-hidden="true">
            <TaskCard task={task} warned={warned} quiet={quiet} />
          </div>
        </div>
      ) : (
        <TaskCard task={task} warned={warned} quiet={quiet} />
      )}
    </li>
  );
}

function Column({
  name,
  tasks,
  warnedFiles,
  highlighted,
}: {
  name: string;
  tasks: Task[];
  warnedFiles: Set<string>;
  highlighted: boolean;
}) {
  const headingId = useId();
  const review = name === REVIEW_COLUMN;
  const { setNodeRef } = useDroppable({ id: columnId(name) });

  // The column under the pointer gets the mint border and a lighter surface (tokens; no opacity).
  const colBorder = highlighted ? 'border-accent' : review ? 'border-review' : 'border-line';
  const listBg = highlighted ? 'bg-surface-2' : name === DONE_COLUMN ? 'bg-bg' : 'bg-surface';

  return (
    <section
      ref={setNodeRef}
      aria-labelledby={headingId}
      data-drop-target={highlighted || undefined}
      className={`flex max-h-full snap-start flex-col rounded-[9px] border ${colBorder} bg-bg overflow-hidden`}
    >
      <header className={`px-3 py-2.5 border-b ${review ? 'border-review bg-review/10' : 'border-line bg-surface'}`}>
        <div className="flex items-center justify-between">
          <h2 id={headingId} className="flex items-center gap-2">
            <span className={`font-mono text-[13px] font-semibold uppercase tracking-wider ${review ? 'text-review' : 'text-text'}`}>
              {strings.board.columnName(name)}
            </span>
          </h2>
          <span className={`font-mono text-[13px] font-semibold tabular-nums ${review && tasks.length ? 'text-review' : 'text-muted'}`}>
            <span aria-hidden="true">{tasks.length}</span>
            <span className="sr-only">{strings.board.count(tasks.length)}</span>
          </span>
        </div>
        {review && tasks.length > 0 && (
          <p className="mt-1 inline-block rounded bg-review px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-widest text-surface">{strings.board.needsYou}</p>
        )}
      </header>
      <SortableContext items={tasks.map((t) => t.file)} strategy={verticalListSortingStrategy}>
        <ol className={`flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2 ${listBg}`}>
          {tasks.map((t) => (
            <SortableCard key={t.file} task={t} warned={warnedFiles.has(t.file)} quiet={name === DONE_COLUMN} />
          ))}
          {tasks.length === 0 && (
            <li className="rounded-[7px] border border-dashed border-line px-3 py-4 text-center text-[12px] text-muted">{strings.board.emptyColumn}</li>
          )}
        </ol>
      </SortableContext>
    </section>
  );
}

export function WarningsBanner({ slug, warnings }: { slug: string; warnings: BoardWarning[] }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (!warnings.length) return null;
  const s = strings.warnings;
  return (
    <aside role="alert" className="mx-4 mt-3 rounded-md border border-accent-2/40 bg-accent-2/10 px-4 py-3 sm:mx-6" aria-label={s.title(warnings.length)}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <WarningMark className="size-4 mt-0.5 text-accent-2" />
        <div className="min-w-0 flex-1 text-[14px]">
          <p className="font-semibold text-accent-2">{s.title(warnings.length)}</p>
          <p className="mt-1 text-muted">
            {s.body} <code className="rounded border border-line-strong bg-surface px-1.5 py-0.5 font-mono text-[12px] text-text">{s.report(slug)}</code>{' '}
            <code className="rounded border border-line-strong bg-surface px-1.5 py-0.5 font-mono text-[12px] text-text">{s.fix(slug)}</code>
          </p>
        </div>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((o) => !o)}
          className="rounded-md px-2.5 py-1 text-[13px] font-medium text-accent-2 underline-offset-4 hover:underline focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent"
        >
          {open ? s.hide : s.show}
        </button>
      </div>
      <ul id={listId} hidden={!open} className="mt-3 space-y-1 border-t border-accent-2/20 pt-3 font-mono text-[12px] text-accent-2">
        {warnings.map((w, i) => (
          <li key={i} className="[overflow-wrap:anywhere]">
            {w.message}
          </li>
        ))}
      </ul>
    </aside>
  );
}

type Items = Record<string, string[]>;

export interface BoardProps {
  snapshot: BoardSnapshot;
  /** Persist a move: `position` is the index in `status` without the moved card (0 = top). */
  onMove?: (file: string, status: string, position: number) => void;
  /** Tells the page a drag started/ended (live refetches are held back while dragging). */
  onDragStateChange?: (dragging: boolean) => void;
}

export function Board({ snapshot, onMove, onDragStateChange }: BoardProps) {
  const { project, tasks, warnings } = snapshot;
  const groups = groupByColumn(project.columns, tasks);
  const warned = filesWithWarnings(warnings);
  const byFile = useMemo(() => new Map(tasks.map((t) => [t.file, t])), [tasks]);
  const derived = useMemo<Items>(
    () => Object.fromEntries(project.columns.map((c) => [c, (groups.get(c) ?? []).map((t) => t.file)])),
    [snapshot],
  );

  // While dragging, cards move between columns locally; otherwise the snapshot is the truth.
  const [items, setItems] = useState<Items>(derived);
  const [active, setActive] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<string | null>(null);
  const start = useRef<{ items: Items; column: string; index: number } | null>(null);
  useEffect(() => {
    if (!active) setItems(derived);
  }, [derived, active]);

  const sensors = useSensors(
    useSensor(MousePenSensor, { activationConstraint: { distance: 8 } }),
    // Touch: long press, so swiping still scrolls the board sideways.
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
  );

  const containerOf = (id: UniqueIdentifier, from: Items = items): string | null => {
    const key = String(id);
    if (key.startsWith(COLUMN_ID)) return key.slice(COLUMN_ID.length);
    return Object.keys(from).find((c) => from[c].includes(key)) ?? null;
  };

  const end = () => {
    start.current = null;
    setActive(null);
    setOverColumn(null);
    onDragStateChange?.(false);
  };

  const onDragStart = ({ active: a }: DragStartEvent) => {
    const file = String(a.id);
    const column = containerOf(file);
    if (!column) return;
    start.current = { items, column, index: items[column].indexOf(file) };
    setActive(file);
    setOverColumn(column);
    onDragStateChange?.(true);
  };

  const onDragOver = ({ active: a, over }: DragOverEvent) => {
    if (!over) return;
    const from = containerOf(a.id);
    const to = containerOf(over.id);
    if (!from || !to) return;
    setOverColumn(to);
    if (from === to) return;
    // Entering another column: put the card there now, so its cards make room for it.
    setItems((prev) => {
      const file = String(a.id);
      const target = prev[to].filter((f) => f !== file);
      let index = target.length;
      if (!String(over.id).startsWith(COLUMN_ID)) {
        const overIndex = target.indexOf(String(over.id));
        const translated = a.rect.current.translated;
        const below = translated && translated.top > over.rect.top + over.rect.height / 2;
        index = overIndex >= 0 ? overIndex + (below ? 1 : 0) : target.length;
      }
      target.splice(index, 0, file);
      return { ...prev, [from]: prev[from].filter((f) => f !== file), [to]: target };
    });
  };

  const onDragEnd = ({ active: a, over }: DragEndEvent) => {
    const origin = start.current;
    const file = String(a.id);
    const to = over ? containerOf(over.id) : null;
    if (!origin || !to) {
      if (origin) setItems(origin.items);
      end();
      return;
    }
    let list = items[to];
    const from = list.indexOf(file);
    const overIndex = String(over!.id).startsWith(COLUMN_ID) ? from : list.indexOf(String(over!.id));
    if (from >= 0 && overIndex >= 0 && from !== overIndex) list = arrayMove(list, from, overIndex);
    const position = list.indexOf(file);
    setItems({ ...items, [to]: list });
    // onMove updates the snapshot in the same batch as end(), so nothing flashes back.
    if (position >= 0 && !(to === origin.column && position === origin.index)) onMove?.(file, to, position);
    end();
  };

  const onDragCancel = () => {
    if (start.current) setItems(start.current.items);
    end();
  };

  const activeTask = active ? byFile.get(active) : undefined;
  const reducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  return (
    <>
      <div className="px-4 py-6 sm:px-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <nav aria-label={strings.board.breadcrumbAria} className="text-[12px] font-medium text-accent uppercase tracking-widest mb-1">{project.slug}</nav>
          <h1 className="text-[28px] font-bold tracking-tighter text-text sm:text-[32px]">{project.name}</h1>
          <p className="mt-1 text-[13px] text-muted">
            <code className="rounded border border-line-strong bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-accent">{project.slug}</code> {strings.board.kanbanLabel}
          </p>
        </div>
        <div className="flex gap-6">
          <div className="flex flex-col items-end">
            <span className="text-2xl font-mono font-semibold text-text leading-none">{tasks.length}</span>
            <span className="mt-1 text-[11px] uppercase tracking-widest text-muted">{strings.board.tasksLabel}</span>
          </div>
          <div className="flex flex-col items-end">
            <span className="text-2xl font-mono font-semibold text-review leading-none">{groups.get(REVIEW_COLUMN)?.length || 0}</span>
            <span className="mt-1 text-[11px] uppercase tracking-widest text-muted">{strings.board.reviewLabel}</span>
          </div>
          <div className="flex flex-col items-end">
            <span className={`text-2xl font-mono font-semibold leading-none ${warnings.length > 0 ? 'text-danger' : 'text-muted'}`}>{warnings.length}</span>
            <span className="mt-1 text-[11px] uppercase tracking-widest text-muted">{strings.board.warnsLabel}</span>
          </div>
        </div>
      </div>
      <WarningsBanner slug={project.slug} warnings={warnings} />
      {tasks.length === 0 && <p className="px-4 pt-4 text-muted sm:px-6">{strings.board.empty}</p>}
      <div
        className="grid min-h-0 flex-1 grid-flow-col auto-cols-[minmax(250px,1fr)] snap-x snap-mandatory scroll-px-4 gap-4 overflow-x-auto px-4 pb-4 pt-3 sm:snap-none sm:px-6"
        role="region"
        aria-label={project.name}
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragEnd={onDragEnd}
          onDragCancel={onDragCancel}
          autoScroll
        >
          {project.columns.map((c) => (
            <Column
              key={c}
              name={c}
              tasks={(items[c] ?? []).map((f) => byFile.get(f)).filter((t): t is Task => !!t)}
              warnedFiles={warned}
              highlighted={active !== null && overColumn === c}
            />
          ))}
          <DragOverlay dropAnimation={reducedMotion ? null : undefined}>
            {activeTask ? <TaskCard task={activeTask} warned={warned.has(activeTask.file)} overlay /> : null}
          </DragOverlay>
        </DndContext>
      </div>
    </>
  );
}
