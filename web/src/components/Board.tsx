import { useId, useState } from 'react';
import { DONE_COLUMN, filesWithWarnings, groupByColumn, REVIEW_COLUMN } from '../board-model';
import { strings } from '../strings';
import type { BoardSnapshot, BoardWarning, Task } from '../types';

const PRIORITY_EDGE: Record<string, string> = {
  high: 'border-l-salmon',
  medium: 'border-l-steel/70',
  low: 'border-l-transparent',
};

/** Marigold warning triangle. Without a label it is decorative (hidden from assistive tech). */
function WarningMark({ label }: { label?: string }) {
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true };
  return (
    <svg viewBox="0 0 16 16" className="mt-0.5 size-4 shrink-0 text-marigold" {...a11y}>
      {label && <title>{label}</title>}
      <path fill="currentColor" d="M8 1.5 15 14H1L8 1.5Zm-.9 4.6.2 4.3h1.4l.2-4.3H7.1Zm.9 5.4a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8Z" />
    </svg>
  );
}

function Progress({ done, total }: { done: number; total: number }) {
  if (!total) return null;
  const pct = Math.round((done / total) * 100);
  return (
    <span className="flex items-center gap-2" title={strings.task.checklist(done, total)}>
      <span aria-hidden="true" className="h-1 w-12 overflow-hidden rounded-full bg-line">
        <span className={`block h-full rounded-full ${done === total ? 'bg-mint' : 'bg-steel'}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="tabular-nums" aria-hidden="true">
        {done}/{total}
      </span>
      <span className="sr-only">{strings.task.checklist(done, total)}</span>
    </span>
  );
}

/** `quiet`: finished work recedes (no priority edge, muted title) so open work stands out. */
export function TaskCard({ task, warned, quiet = false }: { task: Task; warned: boolean; quiet?: boolean }) {
  const titleId = useId();
  const showPriority = task.priority !== 'medium' && !quiet;
  return (
    <article
      aria-labelledby={titleId}
      className={`rounded-md border border-line/70 border-l-[3px] bg-card px-3 pb-2.5 pt-2 ${quiet ? 'border-l-transparent' : (PRIORITY_EDGE[task.priority] ?? '')}`}
    >
      <div className="flex items-center gap-2 text-[13px] text-muted">
        <span className="font-mono">{task.id}</span>
        {showPriority && (
          <span className={task.priority === 'high' ? 'text-salmon' : 'text-muted'}>{strings.task.priority[task.priority]}</span>
        )}
        <span className="sr-only">{strings.task.priorityFull(task.priority)}</span>
        {warned && (
          <span className="ml-auto">
            <WarningMark label={strings.task.hasWarnings} />
          </span>
        )}
      </div>
      <h3 id={titleId} className={`mt-1 line-clamp-3 text-[15px] font-medium leading-snug [overflow-wrap:anywhere] ${quiet ? 'text-muted' : 'text-ink'}`}>
        {task.title}
      </h3>
      {(task.labels.length > 0 || task.progress.total > 0) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted">
          {task.labels.length > 0 && (
            <ul className="flex flex-wrap gap-x-2" aria-label="Labels">
              {task.labels.map((l) => (
                <li key={l}>#{l}</li>
              ))}
            </ul>
          )}
          <Progress done={task.progress.done} total={task.progress.total} />
        </div>
      )}
    </article>
  );
}

function Column({ name, tasks, warnedFiles }: { name: string; tasks: Task[]; warnedFiles: Set<string> }) {
  const headingId = useId();
  const review = name === REVIEW_COLUMN;
  return (
    <section
      aria-labelledby={headingId}
      className={`flex max-h-full w-[min(85vw,17rem)] shrink-0 snap-start flex-col rounded-[10px] bg-lane sm:w-[17rem] ${
        review ? 'border-t-2 border-marigold' : 'border-t-2 border-transparent'
      }`}
    >
      <header className="px-3 pb-2 pt-2.5">
        <h2 id={headingId} className="flex items-center gap-2 text-[15px] font-semibold">
          <span className={review ? 'text-marigold' : 'text-ink'}>{strings.board.columnName(name)}</span>
          <span
            className={`rounded-full px-2 text-[13px] tabular-nums ${review && tasks.length ? 'bg-marigold font-semibold text-marigold-ink' : 'text-muted'}`}
          >
            <span aria-hidden="true">{tasks.length}</span>
            <span className="sr-only">{strings.board.count(tasks.length)}</span>
          </span>
        </h2>
        {review && tasks.length > 0 && <p className="mt-0.5 text-[13px] text-muted">{strings.board.reviewHint}</p>}
      </header>
      <ol className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {tasks.map((t) => (
          <li key={t.file}>
            <TaskCard task={t} warned={warnedFiles.has(t.file)} quiet={name === DONE_COLUMN} />
          </li>
        ))}
        {tasks.length === 0 && (
          <li className="rounded-md border border-dashed border-line px-3 py-4 text-center text-[13px] text-muted">{strings.board.emptyColumn}</li>
        )}
      </ol>
    </section>
  );
}

export function WarningsBanner({ slug, warnings }: { slug: string; warnings: BoardWarning[] }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (!warnings.length) return null;
  const s = strings.warnings;
  return (
    <aside className="mx-4 mt-3 rounded-md border-l-[3px] border-marigold bg-lane px-4 py-3 sm:mx-6" aria-label={s.title(warnings.length)}>
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <WarningMark />
        <div className="min-w-0 flex-1 text-[15px]">
          <p className="font-semibold">{s.title(warnings.length)}</p>
          <p className="mt-1 text-muted">
            {s.body} <code className="rounded bg-ground px-1.5 py-0.5 font-mono text-[13px] text-ink">{s.report(slug)}</code>{' '}
            <code className="rounded bg-ground px-1.5 py-0.5 font-mono text-[13px] text-ink">{s.fix(slug)}</code>
          </p>
        </div>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((o) => !o)}
          className="rounded-md px-2.5 py-1 text-sm text-ink underline-offset-4 hover:underline"
        >
          {open ? s.hide : s.show}
        </button>
      </div>
      <ul id={listId} hidden={!open} className="mt-3 space-y-1 border-t border-line/60 pt-3 font-mono text-[13px] text-muted">
        {warnings.map((w, i) => (
          <li key={i} className="[overflow-wrap:anywhere]">
            {w.message}
          </li>
        ))}
      </ul>
    </aside>
  );
}

export function Board({ snapshot }: { snapshot: BoardSnapshot }) {
  const { project, tasks, warnings } = snapshot;
  const groups = groupByColumn(project.columns, tasks);
  const warned = filesWithWarnings(warnings);
  return (
    <>
      <WarningsBanner slug={project.slug} warnings={warnings} />
      {tasks.length === 0 && <p className="px-4 pt-4 text-muted sm:px-6">{strings.board.empty}</p>}
      <div
        className="flex min-h-0 flex-1 snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-4 pt-3 sm:snap-none sm:px-6"
        role="region"
        aria-label={project.name}
      >
        {project.columns.map((c) => (
          <Column key={c} name={c} tasks={groups.get(c) ?? []} warnedFiles={warned} />
        ))}
      </div>
    </>
  );
}
