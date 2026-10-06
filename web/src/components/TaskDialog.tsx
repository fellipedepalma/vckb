import { type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ApiError, NetworkError } from '../api';
import { MarkdownPreview } from '../markdown';
import { strings } from '../strings';
import {
  diffForm,
  type FieldError,
  type FormErrors,
  type FormField,
  type FormValues,
  fieldOfServerError,
  isDirty,
  LABEL_RE,
  parseLabels,
  PRIORITIES,
  toFormValues,
  type TaskPatch,
  validateForm,
} from '../task-form';
import type { Task } from '../types';

const d = strings.details;

export interface TaskDialogProps {
  /** The task as it was when the dialog opened (its etag is what the first Save sends). */
  task: Task;
  slug: string;
  columns: string[];
  /** Sends the PATCH (through the board's save queue); rejects with ApiError / NetworkError. */
  onSave: (patch: TaskPatch, etag: string) => Promise<void>;
  /** Reads the task as it is on disk now. */
  onReload: () => Promise<Task>;
  /** The dialog is done (saved, cancelled or discarded). The page puts focus back on the card. */
  onClose: () => void;
}

/** One alert at a time: a discard confirmation or the reason a save did not go through. */
type Notice =
  | { kind: 'discard' }
  | { kind: 'conflict' }
  | { kind: 'duplicateId' }
  | { kind: 'gone' }
  | { kind: 'network' }
  | { kind: 'server'; message: string }
  | { kind: 'rejected'; message: string }
  | { kind: 'reloadFailed'; reason: string };

const DESCRIPTION_TABS = ['edit', 'preview'] as const;
type DescriptionTab = (typeof DESCRIPTION_TABS)[number];

const FOCUSABLE = 'button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])';

function fieldErrorText(error: FieldError): string {
  switch (error.kind) {
    case 'required':
      return d.errors.required;
    case 'tooLong':
      return d.errors.tooLong(error.max);
    case 'lineBreak':
      return d.errors.lineBreak;
    case 'badLabel':
      return d.errors.badLabel(error.label);
    case 'tooManyLabels':
      return d.errors.tooManyLabels(error.max);
    case 'unknownValue':
      return d.errors.unknownValue;
    case 'server':
      return error.message;
  }
}

const fieldClass =
  'w-full rounded-md border border-line-strong bg-bg px-3 py-2 text-[14px] text-text placeholder:text-muted disabled:text-muted aria-[invalid=true]:border-danger';
const labelClass = 'mb-1.5 block text-[11px] font-medium uppercase tracking-widest text-muted';
const buttonClass =
  'rounded-md border px-4 py-2 text-[13px] font-semibold focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:text-muted';
const secondaryButton = `${buttonClass} border-line-strong bg-surface-2 text-text hover:border-accent disabled:border-line`;
const primaryButton = `${buttonClass} border-accent bg-accent text-bg hover:bg-text disabled:border-line disabled:bg-surface-2`;

function Field({
  id,
  label,
  hint,
  error,
  labelRight,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: FieldError;
  /** Next to the label (the Edit / Preview tabs of the description). */
  labelRight?: ReactNode;
  children: (props: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }) => ReactNode;
}) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div>
      {labelRight ? (
        <div className="mb-1.5 flex items-end justify-between gap-3">
          <label htmlFor={id} className="block text-[11px] font-medium uppercase tracking-widest text-muted">
            {label}
          </label>
          {labelRight}
        </div>
      ) : (
        <label htmlFor={id} className={labelClass}>
          {label}
        </label>
      )}
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })}
      {hint && (
        <p id={hintId} className="mt-1.5 text-[12px] text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="mt-1.5 text-[13px] font-medium text-danger">
          {fieldErrorText(error)}
        </p>
      )}
    </div>
  );
}

export function TaskDialog({ task, slug, columns, onSave, onReload, onClose }: TaskDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const fieldRefs = useRef<Partial<Record<FormField, HTMLElement | null>>>({});
  const ids = useId();
  const headingId = `${ids}-heading`;
  const fieldId = (f: FormField) => `${ids}-${f}`;

  // `base` is what the file held when the details were opened (or last reloaded from disk).
  const [base, setBase] = useState<Task>(task);
  const [values, setValues] = useState<FormValues>(() => toFormValues(task));
  const [errors, setErrors] = useState<FormErrors>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const returnFocus = useRef<HTMLElement | null>(null);
  const escHandled = useRef(false);
  const backdropDown = useRef(false);

  // Description: Edit / Preview tabs. The textarea stays mounted (hidden) so its value survives; a
  // hidden element forgets its scroll position, so the selection and scroll are saved when leaving.
  const [tab, setTab] = useState<DescriptionTab>('edit');
  const tabRefs = useRef<Partial<Record<DescriptionTab, HTMLButtonElement | null>>>({});
  const editView = useRef<{ start: number; end: number; direction: 'forward' | 'backward' | 'none'; scrollTop: number } | null>(null);
  const switchTab = (next: DescriptionTab) => {
    if (next === tab) return;
    const area = fieldRefs.current.description as HTMLTextAreaElement | null | undefined;
    if (tab === 'edit' && area) {
      editView.current = { start: area.selectionStart, end: area.selectionEnd, direction: area.selectionDirection ?? 'none', scrollTop: area.scrollTop };
    }
    setTab(next);
  };
  useLayoutEffect(() => {
    const area = fieldRefs.current.description as HTMLTextAreaElement | null | undefined;
    const view = editView.current;
    if (tab !== 'edit' || !area || !view) return;
    area.setSelectionRange(view.start, view.end, view.direction);
    area.scrollTop = view.scrollTop;
  }, [tab]);
  // WAI-ARIA tabs: arrows (wrapping), Home and End move to a tab and select it; only the selected tab is in the Tab order.
  const onTabsKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const at = DESCRIPTION_TABS.indexOf(tab);
    const target =
      e.key === 'ArrowRight' ? (at + 1) % DESCRIPTION_TABS.length
      : e.key === 'ArrowLeft' ? (at + DESCRIPTION_TABS.length - 1) % DESCRIPTION_TABS.length
      : e.key === 'Home' ? 0
      : e.key === 'End' ? DESCRIPTION_TABS.length - 1
      : -1;
    if (target < 0) return;
    e.preventDefault();
    switchTab(DESCRIPTION_TABS[target]);
    tabRefs.current[DESCRIPTION_TABS[target]]?.focus();
  };

  // showModal(): the page behind is inert (no clicks, no focus, no drag and drop) and Esc is ours.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    fieldRefs.current.title?.focus();
    return () => dialog.close();
  }, []);

  // A notice takes focus (its first button, else the box itself) so keyboard users land on it.
  useEffect(() => {
    if (!notice) return;
    const box = noticeRef.current;
    (box?.querySelector<HTMLElement>('button') ?? box)?.focus();
  }, [notice]);

  // Focusing a control inside the disabled fieldset does nothing, so a field to focus after a failed
  // save is remembered and focused once the render that re-enabled the form is done.
  const focusAfterRender = useRef<FormField | null>(null);
  useEffect(() => {
    if (focusAfterRender.current && !saving) {
      fieldRefs.current[focusAfterRender.current]?.focus();
      focusAfterRender.current = null;
    }
  });
  const focusField = (field: FormField) => {
    focusAfterRender.current = field;
  };
  const showNotice = (n: Notice) => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && dialogRef.current?.contains(active) && !noticeRef.current?.contains(active)) returnFocus.current = active;
    setNotice(n);
  };
  const dismissNotice = () => {
    setNotice(null);
    const target = returnFocus.current && dialogRef.current?.contains(returnFocus.current) ? returnFocus.current : fieldRefs.current.title;
    target?.focus();
  };

  const dirty = isDirty(base, values);
  const requestClose = () => {
    if (saving) return;
    if (dirty) showNotice({ kind: 'discard' });
    else onClose();
  };

  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    setStatus('');
    // Editing a field clears its own error (the next Save checks everything again).
    setErrors((e) => (e[key] ? { ...e, [key]: undefined } : e));
  };

  const fail = (err: unknown) => {
    if (err instanceof NetworkError) return showNotice({ kind: 'network' });
    if (err instanceof ApiError) {
      if (err.status === 412) return showNotice({ kind: 'conflict' });
      if (err.status === 409) return showNotice({ kind: 'duplicateId' });
      if (err.status === 404) return showNotice({ kind: 'gone' });
      if (err.status === 400) {
        const field = fieldOfServerError(err.message);
        if (field) {
          setErrors({ [field]: { kind: 'server', message: err.message } });
          if (field === 'description') setTab('edit');
          focusField(field);
          return;
        }
        return showNotice({ kind: 'rejected', message: err.message });
      }
      return showNotice({ kind: 'server', message: err.message });
    }
    showNotice({ kind: 'server', message: strings.errors.generic });
  };

  const submit = async () => {
    if (saving) return;
    const found = validateForm(values, columns);
    const first = (['title', 'status', 'priority', 'labels', 'description'] as const).find((f) => found[f]);
    if (first) {
      setErrors(found);
      setNotice(null);
      if (first === 'description') setTab('edit');
      focusField(first);
      return;
    }
    const patch = diffForm(base, values);
    if (Object.keys(patch).length === 0) {
      onClose(); // nothing changed: nothing to send
      return;
    }
    setErrors({});
    setNotice(null);
    setSaving(true);
    setStatus(d.saving);
    try {
      await onSave(patch, base.etag);
      onClose();
    } catch (err) {
      setSaving(false);
      setStatus('');
      fail(err);
    }
  };

  const reloadFromDisk = async () => {
    setSaving(true);
    setStatus(d.saving);
    try {
      const fresh = await onReload();
      setBase(fresh);
      setValues(toFormValues(fresh));
      setErrors({});
      setNotice(null);
      setSaving(false);
      setStatus(d.reloaded);
      fieldRefs.current.title?.focus();
    } catch (err) {
      setSaving(false);
      setStatus('');
      const reason = err instanceof NetworkError ? strings.errors.network : err instanceof ApiError ? err.message : strings.errors.generic;
      showNotice({ kind: 'reloadFailed', reason });
    }
  };

  const onFormSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDialogElement>) => {
    if (e.key === 'Escape') {
      // Handled here, not left to the dialog: a second Escape must not slip past the confirmation.
      e.preventDefault();
      escHandled.current = true;
      setTimeout(() => (escHandled.current = false), 0);
      if (notice?.kind === 'discard') dismissNotice();
      else requestClose();
      return;
    }
    // Holding Enter on the card repeats into the dialog; never let that submit the form.
    if (e.key === 'Enter' && e.repeat) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Tab') {
      const items = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter(
        (el) => !(el as HTMLButtonElement).disabled && el.getClientRects().length > 0,
      );
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !dialogRef.current?.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !dialogRef.current?.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  const labels = parseLabels(values.labels);

  return (
    <dialog
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      onKeyDown={onKeyDown}
      onCancel={(e) => {
        e.preventDefault();
        if (!escHandled.current) requestClose();
      }}
      // A click on the dim area closes (with the confirmation when dirty), but only if it also
      // started there: selecting text inside and releasing outside must not close it.
      onPointerDown={(e) => (backdropDown.current = e.target === e.currentTarget)}
      onClick={(e) => {
        if (e.target === e.currentTarget && backdropDown.current) requestClose();
        backdropDown.current = false;
      }}
      className="m-auto w-[min(560px,calc(100vw-32px))] max-w-none flex-col overflow-hidden rounded-[11px] border border-line-strong bg-surface p-0 text-text shadow-[0_24px_64px_rgba(0,0,0,0.6)] open:flex max-h-[min(720px,calc(100dvh-32px))] animate-modal-in backdrop:bg-bg/80 max-sm:max-h-[calc(100dvh-16px)] max-sm:w-[calc(100vw-16px)]"
    >
      <form onSubmit={onFormSubmit} noValidate className="flex min-h-0 flex-1 flex-col">
        <fieldset disabled={saving} className="contents">
          <header className="flex shrink-0 items-start gap-3 border-b border-line px-5 py-4">
            <h2 id={headingId} className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-mono text-[13px] font-semibold uppercase tracking-wider text-accent">{task.id}</span>
              <span className="text-[11px] font-medium uppercase tracking-widest text-muted">{d.heading}</span>
            </h2>
            <button
              type="button"
              aria-label={d.close}
              onClick={requestClose}
              className="-mr-2 -mt-1 rounded-md px-2 py-1 text-[20px] leading-none text-muted hover:text-text focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent disabled:text-muted"
            >
              <span aria-hidden="true">×</span>
            </button>
          </header>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
            <Field id={fieldId('title')} label={d.fields.title} error={errors.title}>
              {(p) => (
                <input
                  {...p}
                  ref={(el) => void (fieldRefs.current.title = el)}
                  type="text"
                  value={values.title}
                  autoComplete="off"
                  onChange={(e) => set('title', e.target.value)}
                  className={fieldClass}
                />
              )}
            </Field>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field id={fieldId('status')} label={d.fields.status} error={errors.status}>
                {(p) => (
                  <select {...p} ref={(el) => void (fieldRefs.current.status = el)} value={values.status} onChange={(e) => set('status', e.target.value)} className={fieldClass}>
                    {!columns.includes(values.status) && <option value={values.status}>{values.status}</option>}
                    {columns.map((c) => (
                      <option key={c} value={c}>
                        {strings.board.columnName(c)}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field id={fieldId('priority')} label={d.fields.priority} error={errors.priority}>
                {(p) => (
                  <select {...p} ref={(el) => void (fieldRefs.current.priority = el)} value={values.priority} onChange={(e) => set('priority', e.target.value)} className={fieldClass}>
                    {PRIORITIES.map((pr) => (
                      <option key={pr} value={pr}>
                        {strings.task.priority[pr]}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            </div>

            <Field id={fieldId('labels')} label={d.fields.labels} hint={d.labelsHint} error={errors.labels}>
              {(p) => (
                <>
                  <input
                    {...p}
                    ref={(el) => void (fieldRefs.current.labels = el)}
                    type="text"
                    value={values.labels}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => set('labels', e.target.value)}
                    className={fieldClass}
                  />
                  {labels.length > 0 && (
                    <ul aria-label={d.labelsChips} className="mt-2 flex flex-wrap gap-1">
                      {labels.map((l) => (
                        <li
                          key={l}
                          className={`rounded border px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-widest ${LABEL_RE.test(l) ? 'border-line bg-surface-2 text-muted' : 'border-danger bg-surface-2 text-danger'}`}
                        >
                          {l}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </Field>

            <Field
              id={fieldId('description')}
              label={d.fields.description}
              hint={d.descriptionHint}
              error={errors.description}
              labelRight={
                <div role="tablist" aria-label={d.markdown.tabsLabel} aria-describedby={`${fieldId('description')}-hint`} onKeyDown={onTabsKeyDown} className="-mb-px flex gap-1">
                  {DESCRIPTION_TABS.map((t) => (
                    <button
                      key={t}
                      ref={(el) => void (tabRefs.current[t] = el)}
                      type="button"
                      role="tab"
                      id={`${ids}-tab-${t}`}
                      aria-selected={tab === t}
                      aria-controls={`${ids}-panel-${t}`}
                      tabIndex={tab === t ? 0 : -1}
                      onClick={() => switchTab(t)}
                      className={`border-b-2 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-widest focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent ${tab === t ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-text'}`}
                    >
                      {d.markdown[t]}
                    </button>
                  ))}
                </div>
              }
            >
              {(p) => (
                <>
                  <div role="tabpanel" id={`${ids}-panel-edit`} aria-labelledby={`${ids}-tab-edit`} hidden={tab !== 'edit'}>
                    <textarea
                      {...p}
                      ref={(el) => void (fieldRefs.current.description = el)}
                      rows={7}
                      value={values.description}
                      onChange={(e) => set('description', e.target.value)}
                      className={`${fieldClass} min-h-[11.5rem] resize-y font-sans leading-relaxed`}
                    />
                  </div>
                  <div
                    role="tabpanel"
                    id={`${ids}-panel-preview`}
                    aria-labelledby={`${ids}-tab-preview`}
                    hidden={tab !== 'preview'}
                    tabIndex={0}
                    className="max-h-[min(24rem,55dvh)] min-h-[11.5rem] overflow-auto rounded-md border border-line-strong bg-bg px-3 py-2 text-[14px] text-text focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                  >
                    {tab === 'preview' && <MarkdownPreview source={values.description} />}
                  </div>
                </>
              )}
            </Field>
          </div>

          {notice && (
            <div ref={noticeRef} role="alert" tabIndex={-1} className="shrink-0 border-t border-line bg-surface-2 px-5 py-3 outline-none">
              <NoticeBody
                notice={notice}
                slug={slug}
                onKeep={dismissNotice}
                onDiscard={onClose}
                onReload={() => void reloadFromDisk()}
                onRetry={() => {
                  setNotice(null);
                  void submit();
                }}
              />
            </div>
          )}

          <footer className="flex shrink-0 items-center gap-3 border-t border-line px-5 py-3">
            {/* Left side: kept free for "Delete" (a later block). */}
            <div className="mr-auto" />
            <p role="status" className="text-[12px] text-muted">
              {status}
            </p>
            <button type="button" onClick={requestClose} className={secondaryButton}>
              {d.cancel}
            </button>
            <button type="submit" className={primaryButton}>
              {d.save}
            </button>
          </footer>
        </fieldset>
      </form>
    </dialog>
  );
}

function NoticeBody({
  notice,
  slug,
  onKeep,
  onDiscard,
  onReload,
  onRetry,
}: {
  notice: Notice;
  slug: string;
  onKeep: () => void;
  onDiscard: () => void;
  onReload: () => void;
  onRetry: () => void;
}) {
  const button = (label: string, onClick: () => void, tone: 'plain' | 'danger' = 'plain') => (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md border px-3 py-1.5 text-[13px] font-semibold focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${tone === 'danger' ? 'border-danger text-danger hover:bg-surface' : 'border-line-strong text-text hover:border-accent'}`}
    >
      {label}
    </button>
  );
  const message = (title: string | null, body: string) => (
    <>
      {title && <p className="text-[14px] font-semibold text-text">{title}</p>}
      <p className={`${title ? 'mt-1 ' : ''}text-[13px] text-muted`}>{body}</p>
    </>
  );
  let content: ReactNode;
  let actions: ReactNode;
  switch (notice.kind) {
    case 'discard':
      content = message(d.discard.title, d.discard.body);
      actions = (
        <>
          {button(d.discard.keep, onKeep)}
          {button(d.discard.confirm, onDiscard, 'danger')}
        </>
      );
      break;
    case 'conflict':
      content = message(d.conflict.title, d.conflict.body);
      actions = (
        <>
          {button(d.conflict.keep, onKeep)}
          {button(d.conflict.reload, onReload)}
        </>
      );
      break;
    case 'network':
      content = message(null, d.network);
      actions = (
        <>
          {button(d.retry, onRetry)}
          {button(d.dismiss, onKeep)}
        </>
      );
      break;
    case 'server':
      content = message(null, d.serverError(notice.message));
      actions = (
        <>
          {button(d.retry, onRetry)}
          {button(d.dismiss, onKeep)}
        </>
      );
      break;
    case 'duplicateId':
      content = message(null, d.duplicateId(slug));
      actions = button(d.dismiss, onKeep);
      break;
    case 'gone':
      content = message(null, d.gone);
      actions = button(d.dismiss, onKeep);
      break;
    case 'rejected':
      content = message(null, d.rejected(notice.message));
      actions = button(d.dismiss, onKeep);
      break;
    case 'reloadFailed':
      content = message(null, d.reloadFailed(notice.reason));
      actions = (
        <>
          {button(d.retry, onReload)}
          {button(d.dismiss, onKeep)}
        </>
      );
      break;
  }
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="min-w-0 flex-1 basis-60">{content}</div>
      <div className="flex gap-2">{actions}</div>
    </div>
  );
}
