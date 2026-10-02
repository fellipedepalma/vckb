/**
 * The only way the UI talks to the server.
 *
 * - Credentials: the HttpOnly session cookie, sent by the browser on same-origin requests. The token
 *   itself is only ever in the sign-in request body; it is never stored anywhere in JS.
 * - CSRF: every state-changing request carries X-VCKB-CSRF (the browser adds Origin itself).
 * - Concurrency: task writes pass `ifMatch` (the task's etag); a 412 surfaces as ApiError.status.
 * - A 401 outside sign-in is broadcast so the app can return to the sign-in screen.
 */

export const CSRF_HEADER = 'X-VCKB-CSRF';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Seconds from Retry-After (429). */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Thrown when the server can't be reached at all. */
export class NetworkError extends Error {
  constructor() {
    super('network');
    this.name = 'NetworkError';
  }
}

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();

/** Subscribes to "the session is gone" (any 401 except the sign-in attempt itself). */
export function onUnauthorized(fn: Listener): () => void {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

export interface RequestOptions {
  body?: unknown;
  /** Task etag for optimistic concurrency (sent as If-Match). */
  ifMatch?: string;
  signal?: AbortSignal;
  /** Don't broadcast a 401 (used by the sign-in and session probes). */
  quiet401?: boolean;
}

export interface ApiResponse<T> {
  data: T;
  etag?: string;
  status: number;
}

const SAFE_METHODS = new Set(['GET', 'HEAD']);

export async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (!SAFE_METHODS.has(method)) headers[CSRF_HEADER] = '1';
  if (opts.ifMatch) headers['If-Match'] = `"${opts.ifMatch}"`;

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      credentials: 'same-origin',
      cache: 'no-store',
      signal: opts.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new NetworkError();
  }

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    if (res.status === 401 && !opts.quiet401) for (const fn of unauthorizedListeners) fn();
    const message = (data as { error?: unknown } | null)?.error;
    const retry = Number(res.headers.get('Retry-After'));
    throw new ApiError(res.status, typeof message === 'string' ? message : `HTTP ${res.status}`, Number.isFinite(retry) && retry > 0 ? retry : undefined);
  }

  const etag = res.headers.get('ETag')?.replace(/^"|"$/g, '') || undefined;
  return { data: data as T, etag, status: res.status };
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>('GET', path, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('POST', path, { ...opts, body }),
  patch: <T>(path: string, body: unknown, opts?: RequestOptions) => request<T>('PATCH', path, { ...opts, body }),
  delete: (path: string, opts?: RequestOptions) => request<null>('DELETE', path, opts),
};

export const paths = {
  session: '/api/session',
  logout: '/api/session/logout',
  events: '/api/events',
  projects: '/api/projects',
  board: (slug: string) => `/api/projects/${encodeURIComponent(slug)}/board`,
  task: (slug: string, id: string) => `/api/projects/${encodeURIComponent(slug)}/tasks/${encodeURIComponent(id)}`,
};
