import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, paths } from './api';
import type { BoardSnapshot, Project } from './types';

export type LoadState<T> =
  | { status: 'loading'; data?: T }
  | { status: 'ready'; data: T }
  | { status: 'error'; error: unknown; data?: T };

/**
 * Loads a resource and exposes `reload`. Keeps the previous data while reloading, so live updates
 * don't flash a loading state; stale responses (from an older request) are ignored.
 */
function useResource<T>(path: string | null) {
  const [state, setState] = useState<LoadState<T>>({ status: 'loading' });
  const seq = useRef(0);

  const reload = useCallback(async () => {
    if (!path) return;
    const mine = ++seq.current;
    setState((s) => (s.status === 'ready' ? s : { status: 'loading', data: s.data }));
    try {
      const { data } = await api.get<T>(path);
      if (mine === seq.current) setState({ status: 'ready', data });
    } catch (error) {
      if (mine === seq.current) setState((s) => ({ status: 'error', error, data: s.data }));
    }
  }, [path]);

  useEffect(() => {
    setState({ status: 'loading' });
    void reload();
  }, [reload]);

  return [state, reload] as const;
}

export const useProjects = () => useResource<Project[]>(paths.projects);
export const useBoard = (slug: string | null) => useResource<BoardSnapshot>(slug ? paths.board(slug) : null);

// ------------------------------------------------------------------ live events

export type LiveStatus = 'connecting' | 'live' | 'reconnecting';

/**
 * Subscribes to /api/events with the native EventSource (the session cookie goes along on the
 * same origin). The browser reconnects by itself after network errors; when the stream is closed
 * for good (e.g. 401), the session is checked and, if still valid, a new stream is opened with backoff.
 */
export function useLiveEvents(onChange: (project: string) => void): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const handler = useRef(onChange);
  handler.current = onChange;

  useEffect(() => {
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let disposed = false;

    const open = () => {
      source = new EventSource(paths.events);
      source.addEventListener('ready', () => {
        attempt = 0;
        setStatus('live');
      });
      source.addEventListener('change', (ev) => {
        try {
          const { project } = JSON.parse((ev as MessageEvent<string>).data) as { project?: unknown };
          if (typeof project === 'string') handler.current(project);
        } catch {
          // malformed event: ignore
        }
      });
      source.onerror = () => {
        if (disposed) return;
        setStatus('reconnecting');
        if (source?.readyState !== EventSource.CLOSED) return; // the browser retries on its own
        source = null;
        // Closed for good: find out whether the session is gone (a 401 goes back to sign-in).
        void api
          .get(paths.session)
          .then(() => {
            if (disposed) return;
            const delay = Math.min(30_000, 1_000 * 2 ** attempt++);
            retry = setTimeout(open, delay);
          })
          .catch((err) => {
            if (disposed || (err instanceof ApiError && err.status === 401)) return;
            retry = setTimeout(open, Math.min(30_000, 1_000 * 2 ** attempt++));
          });
      };
    };

    open();
    return () => {
      disposed = true;
      clearTimeout(retry);
      source?.close();
    };
  }, []);

  return status;
}

// ------------------------------------------------------------------ small helpers

/** Calls `fn` at most once per `ms`, after the last call (trailing debounce). */
export function useDebounced<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  const latest = useRef(fn);
  latest.current = fn;
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return useCallback(
    (...args: A) => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => latest.current(...args), ms);
    },
    [ms],
  );
}

/** Seconds left until a deadline, updated every second; 0 when it has passed. */
export function useCountdown(deadline: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadline === null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [deadline]);
  return deadline === null ? 0 : Math.max(0, Math.ceil((deadline - now) / 1000));
}

/** Current project slug from the URL (/p/<slug>) with history navigation. */
export function useProjectRoute(): [string | null, (slug: string, replace?: boolean) => void] {
  const read = () => {
    const m = /^\/p\/([^/]+)\/?$/.exec(window.location.pathname);
    if (!m) return null;
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return null;
    }
  };
  const [slug, setSlug] = useState<string | null>(read);
  useEffect(() => {
    const onPop = () => setSlug(read());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const go = useCallback((next: string, replace = false) => {
    const url = `/p/${encodeURIComponent(next)}`;
    if (replace) window.history.replaceState(null, '', url);
    else window.history.pushState(null, '', url);
    setSlug(next);
  }, []);
  return [slug, go];
}
