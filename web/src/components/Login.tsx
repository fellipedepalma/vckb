import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { api, ApiError, NetworkError, paths } from '../api';
import { useCountdown } from '../hooks';
import { strings } from '../strings';

const s = strings.login;

type Problem = { kind: 'wrong' } | { kind: 'tooMany'; until: number } | { kind: 'misdirected' } | { kind: 'network' } | { kind: 'other'; status: number };

/** Message for a failed sign-in; exported for tests. */
export function problemFor(err: unknown, now = Date.now()): Problem {
  if (err instanceof NetworkError) return { kind: 'network' };
  if (err instanceof ApiError) {
    if (err.status === 401) return { kind: 'wrong' };
    if (err.status === 429) return { kind: 'tooMany', until: now + (err.retryAfter ?? 1) * 1000 };
    if (err.status === 421) return { kind: 'misdirected' };
    return { kind: 'other', status: err.status };
  }
  return { kind: 'other', status: 0 };
}

export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const inputId = useId();
  const messageId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const secondsLeft = useCountdown(problem?.kind === 'tooMany' ? problem.until : null);
  const blocked = problem?.kind === 'tooMany' && secondsLeft > 0;

  useEffect(() => input.current?.focus(), []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const field = input.current;
    const token = field?.value.trim() ?? '';
    if (!token || busy || blocked) return;
    setBusy(true);
    setProblem(null);
    try {
      await api.post(paths.session, { token }, { quiet401: true });
      if (field) field.value = ''; // don't keep the token around in the DOM either
      onSignedIn();
    } catch (err) {
      setProblem(problemFor(err));
      field?.select();
    } finally {
      setBusy(false);
    }
  };

  let message: string | null = null;
  if (problem?.kind === 'wrong') message = s.wrongToken;
  if (problem?.kind === 'tooMany') message = secondsLeft > 0 ? s.tooMany(secondsLeft) : s.tooManyDone;
  if (problem?.kind === 'misdirected') message = s.misdirected(window.location.host);
  if (problem?.kind === 'network') message = s.network;
  if (problem?.kind === 'other') message = s.unexpected(problem.status);

  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-[26rem]">
        <div className="mb-8 flex items-center gap-3">
          <div className="flex size-[30px] items-center justify-center rounded-[8px] bg-accent text-surface font-bold">
            <svg className="size-4" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
          </div>
          <div className="flex flex-col">
            <span className="text-[17px] font-bold tracking-widest text-text leading-none">{strings.app.name}</span>
            <span className="text-[11px] uppercase tracking-wider text-muted mt-0.5">{strings.app.fullName}</span>
          </div>
        </div>
        <form onSubmit={submit} className="rounded-[10px] border border-line bg-surface p-6" noValidate>
          <h1 className="text-xl font-semibold">{s.title}</h1>
          <p className="mt-2 text-[15px] leading-relaxed text-muted">{s.intro}</p>

          <label htmlFor={inputId} className="mt-6 block text-sm font-medium">
            {s.tokenLabel}
          </label>
          <input
            ref={input}
            id={inputId}
            name="token"
            type="password"
            autoComplete="current-password"
            spellCheck={false}
            required
            aria-invalid={problem?.kind === 'wrong' || undefined}
            aria-describedby={message ? messageId : undefined}
            className="mt-2 block w-full rounded-md border border-line-strong bg-bg px-3 py-2.5 font-mono text-[15px] text-text placeholder:text-muted/70 focus:border-accent focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          />

          <p id={messageId} role={message ? 'alert' : 'status'} aria-live="assertive" className="mt-3 min-h-[1.5rem] text-sm leading-snug text-danger">
            {message}
          </p>

          <button
            type="submit"
            disabled={busy || blocked}
            className="mt-2 w-full rounded-md bg-text px-4 py-2.5 font-semibold text-surface transition-colors hover:bg-white disabled:cursor-not-allowed disabled:bg-line disabled:text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {busy ? s.submitting : s.submit}
          </button>
          <p className="mt-4 text-[13px] leading-relaxed text-muted">{s.staysPrivate}</p>
        </form>
      </div>
    </main>
  );
}
