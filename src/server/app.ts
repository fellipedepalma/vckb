import { createHash, timingSafeEqual } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { VckbError } from '../core/errors.js';
import type { BoardStore, CreateTaskInput, UpdateTaskInput } from '../core/store.js';

export interface AppOptions {
  store: BoardStore;
  token: string;
  /** Emissor de eventos "change" ({ project }) vindo do watcher. */
  events?: EventEmitter;
  /** Origens liberadas para CORS. Vazio = sem CORS (mesma origem apenas). */
  corsOrigins?: string[];
  /** Limite do corpo das requisições em bytes (padrão 256 KiB). */
  maxBodyBytes?: number;
  /** Intervalo do ping SSE em ms (padrão 25 s). */
  sseHeartbeatMs?: number;
}

/**
 * Compara o header Authorization com o token em tempo constante.
 * Os dois lados passam por SHA-256 para ficarem com o mesmo tamanho, então nem o
 * comprimento do token vaza por timing.
 */
export function bearerMatches(header: string | undefined, token: string): boolean {
  if (!header || !token) return false;
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
  if (!m) return false;
  const given = createHash('sha256').update(m[1]).digest();
  const expected = createHash('sha256').update(token).digest();
  return timingSafeEqual(given, expected);
}

const STATUS: Record<VckbError['code'], 400 | 404 | 409> = { INVALID: 400, NOT_FOUND: 404, CONFLICT: 409 };

async function readJson(c: Context): Promise<Record<string, unknown>> {
  let data: unknown;
  try {
    data = await c.req.json();
  } catch {
    throw new VckbError('INVALID', 'Corpo da requisição deve ser JSON válido');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new VckbError('INVALID', 'Corpo da requisição deve ser um objeto JSON');
  }
  return data as Record<string, unknown>;
}

/** Copia só os campos permitidos (nada de chaves arbitrárias chegando ao store). */
function pick<T>(src: Record<string, unknown>, keys: (keyof T & string)[]): T {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (Object.hasOwn(src, k)) out[k] = src[k];
  return out as T;
}

const TASK_FIELDS = ['title', 'status', 'priority', 'labels', 'body', 'description', 'checklist', 'position'] as const;

export function createApp(opts: AppOptions) {
  const { store, token, events } = opts;
  if (!token) throw new Error('VCKB_TOKEN não definido');

  const app = new Hono();
  const api = new Hono();

  if (opts.corsOrigins?.length) {
    api.use(
      '*',
      cors({
        origin: opts.corsOrigins,
        allowMethods: ['GET', 'POST', 'PATCH', 'DELETE'],
        allowHeaders: ['Authorization', 'Content-Type'],
        maxAge: 600,
      }),
    );
  }

  api.use('*', async (c, next) => {
    if (!bearerMatches(c.req.header('Authorization'), token)) {
      c.header('WWW-Authenticate', 'Bearer');
      return c.json({ error: 'Não autorizado' }, 401);
    }
    await next();
  });

  api.use(
    '*',
    bodyLimit({
      maxSize: opts.maxBodyBytes ?? 256 * 1024,
      onError: (c) => c.json({ error: 'Corpo da requisição muito grande' }, 413),
    }),
  );

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
    return c.json(task, 201);
  });

  api.get('/projects/:slug/tasks/:id', async (c) => c.json(await store.getTask(c.req.param('slug'), c.req.param('id'))));

  api.patch('/projects/:slug/tasks/:id', async (c) => {
    const body = await readJson(c);
    const patch = pick<UpdateTaskInput>(body, [...TASK_FIELDS, 'order']);
    return c.json(await store.updateTask(c.req.param('slug'), c.req.param('id'), patch));
  });

  api.delete('/projects/:slug/tasks/:id', async (c) => {
    await store.deleteTask(c.req.param('slug'), c.req.param('id'));
    return c.body(null, 204);
  });

  api.post('/projects/:slug/tasks/:id/notes', async (c) => {
    const body = await readJson(c);
    return c.json(await store.addNote(c.req.param('slug'), c.req.param('id'), body.text as string));
  });

  api.get('/projects/:slug/summary', async (c) => c.json(await store.summary(c.req.param('slug'))));

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

  app.onError((err, c) => {
    if (err instanceof VckbError) return c.json({ error: err.message }, STATUS[err.code]);
    console.error('[vckb]', err);
    return c.json({ error: 'Erro interno' }, 500);
  });

  app.notFound((c) => c.json({ error: 'Não encontrado' }, 404));

  return app;
}
