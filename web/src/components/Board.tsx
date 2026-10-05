import {
  type Announcements,
  closestCorners,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
  KeyboardSensor,
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
import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { DONE_COLUMN, filesWithWarnings, groupByColumn, REVIEW_COLUMN } from '../board-model';
import { isArrowKey, keyboardMove, locate } from '../keyboard-move';
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
export function TaskCard({
  task,
  warned,
  quiet = false,
  overlay = false,
  describedBy,
  articleRef,
}: {
  task: Task;
  warned: boolean;
  quiet?: boolean;
  overlay?: boolean;
  /** id of dnd-kit's hidden keyboard instructions. */
  describedBy?: string;
  /** dnd-kit activator: the element whose Space key picks the card up. */
  articleRef?: (el: HTMLElement | null) => void;
}) {
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
      ref={articleRef}
      data-card-file={task.file}
      aria-labelledby={titleId}
      aria-roledescription={overlay ? undefined : strings.dnd.roleDescription}
      aria-describedby={overlay ? undefined : describedBy}
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

/**
 * dnd-kit's KeyboardSensor starts listening for keys in a setTimeout after the pick-up, so it doesn't
 * treat the Space that started the drag (still bubbling) as "drop". Chrome runs input before timers,
 * so a key pressed right after Space could arrive before that timer and was lost (seen on CI; with
 * the CPU throttled 6x the e2e "keys pressed right after Space are not lost" fails about 1 run in 6
 * with the stock sensor and never with this one). This variant listens at once and ignores only the
 * activating keydown.
 *
 * Reviewed against @dnd-kit/core 6.3.1 and @dnd-kit/sortable 10.0.0 (both pinned in package.json).
 * Internals it relies on, all private in dnd-kit's types: the `attach` method (called by the base
 * constructor), `props.event` (the activating event), `listeners` and `windowListeners` (the
 * dnd-kit `Listeners` helpers: `add`), `handleStart`, `handleCancel` and `handleKeyDown`.
 * Before bumping either package, re-review this class and run
 * `VCKB_E2E_CPU_THROTTLE=6 npm run test:e2e:stress`; tests/dnd-kit-pin.test.ts fails on a bump.
 */
class ImmediateKeyboardSensor extends KeyboardSensor {}
// \`attach\` is private in dnd-kit's types, so it is replaced on the prototype (the base constructor
// calls this.attach(), which resolves here). Same as dnd-kit's, minus the setTimeout.
Object.defineProperty(ImmediateKeyboardSensor.prototype, 'attach', {
  value(this: {
    props: { event: Event };
    listeners: { add: (name: string, handler: (e: Event) => void) => void };
    windowListeners: { add: (name: string, handler: (e: Event) => void) => void };
    handleStart: () => void;
    handleCancel: (e: Event) => void;
    handleKeyDown: (e: Event) => void;
  }) {
    const activating = this.props.event;
    this.handleStart();
    this.windowListeners.add('resize', this.handleCancel);
    this.windowListeners.add('visibilitychange', this.handleCancel);
    this.listeners.add('keydown', (event) => {
      if (event !== activating) this.handleKeyDown(event);
    });
  },
});

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
 * A draggable card. The <article> stays the only focusable element (one Tab stop per card).
 * From dnd-kit's `attributes` only aria-describedby is used (its hidden instructions); role="button",
 * tabIndex, aria-pressed/aria-disabled and its "sortable" role description are left out: the card
 * keeps its own semantics, and the role description comes from strings.ts.
 * The `listeners` (pointer, touch and the Space key) sit on the <li>; keydown bubbles up to it from
 * the article, which is registered as the activator.
 */
function SortableCard({ task, warned, quiet }: { task: Task; warned: boolean; quiet: boolean }) {
  const { setNodeRef, setActivatorNodeRef, listeners, attributes, transform, transition, isDragging } = useSortable({ id: task.file });
  return (
    <li
      ref={setNodeRef}
      data-sortable-file={task.file}
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
        <TaskCard task={task} warned={warned} quiet={quiet} describedBy={attributes['aria-describedby']} articleRef={setActivatorNodeRef} />
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

/**
 * Puts focus back on a card after a keyboard drop, cancel or rollback. Cards remount when they change
 * column, and a rollback re-renders the board some time later, so the request is kept and applied
 * after every Board render (useLayoutEffect) to whatever element the card is now, until any key or
 * pointer input (the user moved on) or 1.5 s. It only acts when focus is lost (on body: a removed
 * element always leaves it there), so it never takes focus from anything the user focused.
 */
let focusRequest: { file: string; until: number } | null = null;

export function focusCard(file: string) {
  focusRequest = { file, until: performance.now() + 1500 };
  const clear = () => (focusRequest = null);
  document.addEventListener('keydown', clear, { capture: true, once: true });
  document.addEventListener('pointerdown', clear, { capture: true, once: true });
  requestAnimationFrame(applyFocusRequest);
}

function applyFocusRequest() {
  if (!focusRequest) return;
  if (performance.now() > focusRequest.until) {
    focusRequest = null;
    return;
  }
  const card = document.querySelector<HTMLElement>(`article[data-card-file="${window.CSS.escape(focusRequest.file)}"][tabindex="0"]`);
  const current = document.activeElement;
  if (card && (!current || current === document.body)) card.focus();
}

/**
 * Says `text` through dnd-kit's own live region (role="status"), for events dnd-kit doesn't know
 * about, such as a save that failed after the drop. No second live region is created; dnd-kit
 * replaces the text with its next announcement.
 */
export function announceInDndRegion(text: string) {
  const region = document.querySelector<HTMLElement>('[id^="DndLiveRegion-"][role="status"]');
  if (region) region.textContent = text;
}

const columnLabel = (name: string) => strings.board.columnName(name);

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

  // Refs read by dnd-kit callbacks (keyboard coordinates, announcements), always current.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const byFileRef = useRef(byFile);
  byFileRef.current = byFile;
  const columns = project.columns;
  const keyboard = useRef(false);
  const lastOrigin = useRef<{ column: string } | null>(null);
  const lastDrop = useRef<{ column: string; index: number; total: number } | null>(null);
  /** Where the card was when "picked up"/"moved" was last announced (column:index). */
  const lastSpoken = useRef<string | null>(null);

  /**
   * Arrow keys while a card is picked up: the move is decided by keyboardMove() (pure), applied to the
   * board at once, and the dragged copy is placed exactly over the card's new slot, scrolled into view.
   */
  const coordinateGetter = useCallback<KeyboardCoordinateGetter>(
    (event, { active: id }) => {
      if (!isArrowKey(event.code)) return undefined;
      event.preventDefault();
      const file = String(id);
      const next = keyboardMove(columns, itemsRef.current, file, event.code);
      if (!next) return undefined; // against an edge: nothing happens
      itemsRef.current = next;
      flushSync(() => {
        setItems(next);
        setOverColumn(locate(columns, next, file)?.column ?? null);
      });
      const slot = document.querySelector<HTMLElement>(`li[data-sortable-file="${window.CSS.escape(file)}"]`);
      if (!slot) return undefined;
      slot.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const rect = slot.getBoundingClientRect();
      return { x: rect.left, y: rect.top };
    },
    [columns],
  );

  // A pending focus request (drop, cancel, rollback) follows the card to wherever this render put it.
  useLayoutEffect(applyFocusRequest);

  const sensors = useSensors(
    useSensor(MousePenSensor, { activationConstraint: { distance: 8 } }),
    // Touch: long press, so swiping still scrolls the board sideways.
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    // Keyboard: Space picks up and drops, arrows move, Escape cancels. Enter is kept for opening a card.
    useSensor(ImmediateKeyboardSensor, {
      keyboardCodes: { start: ['Space'], end: ['Space'], cancel: ['Escape'] },
      coordinateGetter,
    }),
  );

  const announcements = useMemo<Announcements>(() => {
    const describe = (file: string) => {
      const task = byFileRef.current.get(file);
      const at = locate(columns, itemsRef.current, file);
      return task && at ? { task, at } : null;
    };
    return {
      onDragStart: ({ active: a }) => {
        const d = describe(String(a.id));
        lastSpoken.current = d ? `${d.at.column}:${d.at.index}` : null;
        return d ? strings.dnd.pickedUp(d.task.id, d.task.title, columnLabel(d.at.column), d.at.index + 1, d.at.total) : undefined;
      },
      // Keyboard steps only (a pointer drag would announce on every pixel).
      // Keyboard steps only (a pointer drag would announce on every pixel). dnd-kit also fires this
      // when it re-measures the card (a refetch changing the layout, scrolling): announce only real
      // moves, or "moved" would replace "Picked up" without any key being pressed.
      onDragMove: ({ active: a }) => {
        if (!keyboard.current) return undefined;
        const d = describe(String(a.id));
        if (!d) return undefined;
        const where = `${d.at.column}:${d.at.index}`;
        if (where === lastSpoken.current) return undefined;
        lastSpoken.current = where;
        return strings.dnd.moved(d.task.id, columnLabel(d.at.column), d.at.index + 1, d.at.total);
      },
      onDragOver: () => undefined,
      onDragEnd: ({ active: a }) => {
        const task = byFileRef.current.get(String(a.id));
        const drop = lastDrop.current;
        return task && drop ? strings.dnd.dropped(task.id, columnLabel(drop.column), drop.index + 1, drop.total) : undefined;
      },
      onDragCancel: ({ active: a }) => {
        const task = byFileRef.current.get(String(a.id));
        return task && lastOrigin.current ? strings.dnd.cancelled(task.id, columnLabel(lastOrigin.current.column)) : undefined;
      },
    };
  }, [columns]);

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

  const onDragStart = ({ active: a, activatorEvent }: DragStartEvent) => {
    const file = String(a.id);
    const column = containerOf(file);
    if (!column) return;
    keyboard.current = activatorEvent instanceof KeyboardEvent;
    lastOrigin.current = { column };
    lastDrop.current = null;
    start.current = { items, column, index: items[column].indexOf(file) };
    setActive(file);
    setOverColumn(column);
    onDragStateChange?.(true);
  };

  const onDragOver = ({ active: a, over }: DragOverEvent) => {
    if (keyboard.current) return; // keyboard moves are applied by the coordinate getter
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
    if (keyboard.current) {
      // The card already sits where the arrows put it.
      const at = locate(columns, itemsRef.current, file);
      if (origin && at) {
        lastDrop.current = at;
        if (!(at.column === origin.column && at.index === origin.index)) onMove?.(file, at.column, at.index);
      } else if (origin) {
        setItems(origin.items);
      }
      end();
      focusCard(file);
      return;
    }
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
    lastDrop.current = { column: to, index: position, total: list.length };
    setItems({ ...items, [to]: list });
    // onMove updates the snapshot in the same batch as end(), so nothing flashes back.
    if (position >= 0 && !(to === origin.column && position === origin.index)) onMove?.(file, to, position);
    end();
  };

  const onDragCancel = ({ active: a }: { active: { id: UniqueIdentifier } }) => {
    if (start.current) setItems(start.current.items);
    const wasKeyboard = keyboard.current;
    end();
    if (wasKeyboard) focusCard(String(a.id));
  };

  const activeTask = active ? byFile.get(active) : undefined;
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
        className="relative grid min-h-0 flex-1 grid-flow-col auto-cols-[minmax(250px,1fr)] snap-x snap-mandatory scroll-px-4 gap-4 overflow-x-auto px-4 pb-4 pt-3 sm:snap-none sm:px-6"
        role="region"
        aria-label={project.name}
        data-board
      >
        <DndContext
          sensors={sensors}
          accessibility={{ announcements, screenReaderInstructions: { draggable: strings.dnd.instructions } }}
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
          {/* No drop animation: while it ran (~250ms), grabbing the same card again was sometimes
              ignored (seen in e2e: 3 of ~90 quick re-grabs failed with it, 0 of 40 without). */}
          <DragOverlay dropAnimation={null}>
            {activeTask ? <TaskCard task={activeTask} warned={warned.has(activeTask.file)} overlay /> : null}
          </DragOverlay>
        </DndContext>
      </div>
    </>
  );
}
