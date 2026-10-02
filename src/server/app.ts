import type { EventEmitter } from 'node:events';
import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie } from 'hono/cookie';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { serveWeb } from './static.js';
import { VckbError } from '../core/errors.js';
import type { BoardStore, CreateTaskInput, Task, UpdateTaskInput } from '../core/store.js';
import {
  createSession,
  defaultAllowedHosts,
  deriveSessionKey,
  hostnameOf,
  RateLimiter,
  type RateLimitOptions,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  tokenMatches,
  verifySession,
} from './auth.js';

export interface AppOptions {
  store: BoardStore;
  token: string;
  /** Emitter of "change" events ({ project }) coming from the watcher. */
  events?: EventEmitter;
  /** Origins allowed by CORS. Empty = no CORS (same origin only). */
  corsOrigins?: string[];
  /** Request body limit in bytes (default 256 KiB). */
  maxBodyBytes?: number;
  /** SSE ping interval in ms (default 25 s). */
  sseHeartbeatMs?: number;
  /** Host names accepted in the Host header (default: loopback names). Others get 421. */
  allowedHosts?: string[];
  /** Extra origins accepted by the CSRF check besides the request's own Host. */
  allowedOrigins?: string[];
  /** Trust X-Forwarded-Proto / X-Forwarded-For from a reverse proxy (VCKB_TRUST_PROXY=true). */
  trustProxy?: boolean;
  /** Backoff settings for failed logins and failed Bearer tokens. */
  rateLimit?: RateLimitOptions;
  /** Directory of the built web UI (dist/web). When unset, only the API is served. */
  webRoot?: string;
  /** Injectable clock in ms (tests). */
  now?: () => number;
}

/** Applied to every response. The UI must work with it: no inline scripts or styles. */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

/** Header that cookie-authenticated state-changing requests must carry (forces a CORS preflight). */
export const CSRF_HEADER = 'X-VCKB-CSRF';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Compares the Authorization header with the token in constant time.
 * Both sides are hashed with SHA-256 so they have the same length; not even the
 * token length leaks through timing.
 */
export function bearerMatches(header: string | undefined, token: string): boolean {
  if (!header || !token) return false;
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
  return m ? tokenMatches(m[1], token) : false;
}

const STATUS: Record<VckbError['code'], 400 | 404 | 409 | 412> = { INVALID: 400, NOT_FOUND: 404, CONFLICT: 409, PRECONDITION_FAILED: 412 };

/**
 * Parses If-Match (RFC 9110): undefined when absent, ['*'] for any, else the strong entity tags.
 * Weak tags (W/"...") never match with the strong comparison If-Match requires, so they're dropped:
 * a header with only weak or malformed tags always fails the precondition.
 */
export function parseIfMatch(header: string | undefined): string[] | undefined {
  if (header === undefined) return undefined;
  if (header.trim() === '*') return ['*'];
  return header
    .split(',')
    .map((t) => /^"([^"]*)"$/.exec(t.trim())?.[1])
    .filter((t): t is string => t !== undefined);
}

const etagHeader = (etag: string) => `"${etag}"`;

async function readJson(c: Context): Promise<Record<string, unknown>> {
  let data: unknown;
  try {
    data = await c.req.json();
  } catch {
    throw new VckbError('INVALID', 'Request body must be valid JSON');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new VckbError('INVALID', 'Request body must be a JSON object');
  }
  return data as Record<string, unknown>;
}

/** Copies only allowed fields (no arbitrary keys reach the store). */
function pick<T>(src: Record<string, unknown>, keys: (keyof T & string)[]): T {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (Object.hasOwn(src, k)) out[k] = src[k];
  return out as T;
}

const TASK_FIELDS = ['title', 'status', 'priority', 'labels', 'body', 'description', 'checklist', 'position'] as const;

type Env = { Variables: { auth: 'bearer' | 'cookie'; sessionExpiresAt: number | null } };

export function createApp(opts: AppOptions) {
  const { store, token, events } = opts;
  if (!token) throw new Error('VCKB_TOKEN is not set');

  const now = opts.now ?? Date.now;
  const sessionKey = deriveSessionKey(token);
  const allowedHosts = new Set((opts.allowedHosts ?? defaultAllowedHosts('127.0.0.1')).map(hostnameOf));
  const allowedOrigins = new Set((opts.allowedOrigins ?? []).map((o) => o.toLowerCase()));
  const loginLimiter = new RateLimiter(opts.rateLimit);
  const bearerLimiter = new RateLimiter(opts.rateLimit);

  /** The Host header, not c.req.url: node-server takes the URL from an absolute-form request line. */
  const hostOf = (c: Context) => (c.req.header('host') ?? new URL(c.req.url).host).toLowerCase();

  const clientOf = (c: Context): string => {
    if (opts.trustProxy) {
      // The address appended by our own proxy is the last one; earlier entries are client-supplied.
      const hops = (c.req.header('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (hops.length) return hops[hops.length - 1];
    }
    try {
      return getConnInfo(c).remote.address ?? 'unknown';
    } catch {
      return 'unknown'; // no socket (in-process requests in tests)
    }
  };

  const isHttps = (c: Context): boolean =>
    new URL(c.req.url).protocol === 'https:' ||
    (opts.trustProxy === true && c.req.header('x-forwarded-proto')?.split(',')[0].trim().toLowerCase() === 'https');

  /** Why a cookie-authenticated state-changing request fails the CSRF check, or null if it passes. */
  const csrfProblem = (c: Context): string | null => {
    if (!c.req.header(CSRF_HEADER)) return `missing ${CSRF_HEADER} header`;
    const origin = c.req.header('origin');
    if (!origin || origin === 'null') return 'missing Origin header';
    if (allowedOrigins.has(origin.toLowerCase())) return null;
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return 'invalid Origin header';
    }
    return url.host.toLowerCase() === hostOf(c) ? null : 'Origin does not match Host';
  };

  const tooMany = (c: Context, waitMs: number) => {
    c.header('Retry-After', String(Math.ceil(waitMs / 1000)));
    return c.json({ error: 'Too many failed attempts; try again later' }, 429);
  };

  const sessionCookie = (c: Context, value: string, maxAge: number) =>
    setCookie(c, SESSION_COOKIE, value, { httpOnly: true, sameSite: 'Strict', path: '/api', maxAge, secure: isHttps(c) });

  const app = new Hono<Env>();
  const api = new Hono<Env>();

  app.use('*', async (c, next) => {
    // DNS rebinding: a page on evil.example resolving to 127.0.0.1 still sends "Host: evil.example".
    if (!allowedHosts.has(hostnameOf(hostOf(c)))) {
      c.res = c.json({ error: 'Misdirected request: host not allowed (see VCKB_ALLOWED_HOSTS)' }, 421);
    } else {
      await next();
    }
    c.res.headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    c.res.headers.set('X-Content-Type-Options', 'nosniff');
    c.res.headers.set('Referrer-Policy', 'no-referrer');
    if (c.req.path.startsWith('/api')) c.res.headers.set('Cache-Control', 'no-store');
  });

  if (opts.corsOrigins?.length) {
    api.use(
      '*',
      cors({
        origin: opts.corsOrigins,
        allowMethods: ['GET', 'POST', 'PATCH', 'DELETE'],
        allowHeaders: ['Authorization', 'Content-Type', 'If-Match', CSRF_HEADER],
        exposeHeaders: ['ETag'],
        maxAge: 600,
      }),
    );
  }

  api.use(
    '*',
    bodyLimit({
      maxSize: opts.maxBodyBytes ?? 256 * 1024,
      onError: (c) => c.json({ error: 'Request body too large' }, 413),
    }),
  );

  // ------------------------------------------------------ session (web UI)

  /** Exchanges VCKB_TOKEN for the session cookie. Rate limited per client, exponential backoff. */
  api.post('/session', async (c) => {
    const problem = csrfProblem(c);
    if (problem) return c.json({ error: `CSRF check failed: ${problem}` }, 403);
    const client = clientOf(c);
    const wait = loginLimiter.retryAfterMs(client, now());
    if (wait > 0) return tooMany(c, wait);
    const body = await readJson(c);
    if (typeof body.token !== 'string' || !tokenMatches(body.token, token)) {
      loginLimiter.fail(client, now());
      return c.json({ error: 'Invalid token' }, 401);
    }
    loginLimiter.succeed(client);
    const session = createSession(sessionKey, now());
    sessionCookie(c, session.value, SESSION_TTL_SECONDS);
    return c.json({ expiresAt: new Date(session.expiresAt * 1000).toISOString() });
  });

  api.post('/session/logout', (c) => {
    const problem = c.req.header('authorization') ? null : csrfProblem(c);
    if (problem) return c.json({ error: `CSRF check failed: ${problem}` }, 403);
    sessionCookie(c, '', 0);
    return c.body(null, 204);
  });

  // ------------------------------------------------------ authentication

  api.use('*', async (c, next) => {
    const authorization = c.req.header('authorization');
    if (authorization !== undefined) {
      // Bearer: not sent automatically by browsers, so no CSRF check. Failures are rate limited.
      const client = clientOf(c);
      const wait = bearerLimiter.retryAfterMs(client, now());
      if (wait > 0) return tooMany(c, wait);
      if (!bearerMatches(authorization, token)) {
        bearerLimiter.fail(client, now());
        c.header('WWW-Authenticate', 'Bearer');
        return c.json({ error: 'Unauthorized' }, 401);
      }
      bearerLimiter.succeed(client);
      c.set('auth', 'bearer');
      c.set('sessionExpiresAt', null);
      return next();
    }
    const expiresAt = verifySession(sessionKey, getCookie(c, SESSION_COOKIE), now());
    if (expiresAt === null) {
      c.header('WWW-Authenticate', 'Bearer');
      return c.json({ error: 'Unauthorized' }, 401);
    }
    // The cookie is sent automatically, so state changes must prove they come from our own page.
    if (MUTATING.has(c.req.method)) {
      const problem = csrfProblem(c);
      if (problem) return c.json({ error: `CSRF check failed: ${problem}` }, 403);
    }
    c.set('auth', 'cookie');
    c.set('sessionExpiresAt', expiresAt);
    return next();
  });

  api.get('/session', (c) => {
    const expiresAt = c.get('sessionExpiresAt');
    return c.json({ authenticated: true, via: c.get('auth'), expiresAt: expiresAt ? new Date(expiresAt * 1000).toISOString() : null });
  });

  // ------------------------------------------------------ board API

  api.get('/projects', async (c) => c.json(await store.listProjects()));

  api.post('/projects', async (c) => {
    const body = await readJson(c);
    const project = await store.createProject(pick(body, ['name', 'slug', 'description', 'columns']));
    return c.json(project, 201);
  });

  api.get('/projects/:slug', async (c) => c.json(await store.getProject(c.req.param('slug'))));

  api.get('/projects/:slug/tasks', async (c) => {
    const status = c.req.query('status') || undefined;
    const label = c.req.query('label') || undefined;
    return c.json(await store.listTasks(c.req.param('slug'), { status, label }));
  });

  api.post('/projects/:slug/tasks', async (c) => {
    const body = await readJson(c);
    const task = await store.createTask(c.req.param('slug'), pick<CreateTaskInput>(body, [...TASK_FIELDS]));
    c.header('ETag', etagHeader(task.etag));
    return c.json(task, 201);
  });

  // Task reads send an ETag (content hash); PATCH, DELETE and notes honor If-Match (412 if the file
  // changed on disk since it was read, e.g. edited by an agent while the UI had it open).
  const withEtag = (c: Context, task: Task) => {
    c.header('ETag', etagHeader(task.etag));
    return c.json(task);
  };
  const ifMatch = (c: Context) => ({ ifMatch: parseIfMatch(c.req.header('if-match')) });

  api.get('/projects/:slug/tasks/:id', async (c) => withEtag(c, await store.getTask(c.req.param('slug'), c.req.param('id'))));

  api.patch('/projects/:slug/tasks/:id', async (c) => {
    const body = await readJson(c);
    const patch = pick<UpdateTaskInput>(body, [...TASK_FIELDS, 'order']);
    const renumbered: { id: string; file: string; etag: string }[] = [];
    const task = await store.updateTask(c.req.param('slug'), c.req.param('id'), patch, { ...ifMatch(c), renumbered });
    // Other cards this move renumbered (their files, and etags, changed), in the body: in a header a
    // big column (500 cards -> ~30 KB) would exceed what common reverse proxies accept.
    c.header('ETag', etagHeader(task.etag));
    return c.json({ ...task, renumbered: Object.fromEntries(renumbered.map((r) => [r.id, r.etag])) });
  });

  api.delete('/projects/:slug/tasks/:id', async (c) => {
    await store.deleteTask(c.req.param('slug'), c.req.param('id'), ifMatch(c));
    return c.body(null, 204);
  });

  api.post('/projects/:slug/tasks/:id/notes', async (c) => {
    const body = await readJson(c);
    return withEtag(c, await store.addNote(c.req.param('slug'), c.req.param('id'), body.text as string, ifMatch(c)));
  });

  api.get('/projects/:slug/summary', async (c) => c.json(await store.summary(c.req.param('slug'))));

  api.get('/projects/:slug/board', async (c) => c.json(await store.board(c.req.param('slug'))));

  api.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      let open = true;
      const onChange = (ev: { project: string }) => {
        void stream.writeSSE({ event: 'change', data: JSON.stringify(ev) }).catch(() => undefined);
      };
      events?.on('change', onChange);
      stream.onAbort(() => {
        open = false;
        events?.off('change', onChange);
      });
      await stream.writeSSE({ event: 'ready', data: '{}' });
      while (open) {
        await stream.sleep(opts.sseHeartbeatMs ?? 25_000);
        if (open) await stream.writeSSE({ event: 'ping', data: '' });
      }
    }),
  );

  app.route('/api', api);

  // Built web UI on the same origin (so the session cookie, CSRF check and CSP all apply to it).
  // /api keeps its own JSON 404s; everything else is the UI with an SPA fallback.
  if (opts.webRoot) {
    const web = serveWeb(opts.webRoot);
    app.get('*', async (c): Promise<Response> => {
      if (c.req.path === '/api' || c.req.path.startsWith('/api/')) return c.json({ error: 'Not found' }, 404);
      return web(c);
    });
  }

  app.onError((err, c) => {
    if (err instanceof VckbError) return c.json({ error: err.message }, STATUS[err.code]);
    console.error('[vckb]', err);
    return c.json({ error: 'Internal error' }, 500);
  });

  app.notFound((c) => c.json({ error: 'Not found' }, 404));

  return app;
}
