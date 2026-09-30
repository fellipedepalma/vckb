import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeTaskId, safeJoin } from '../src/core/paths.js';
import { bearerMatches } from '../src/server/app.js';
import { apiSetup, TOKEN } from './api-helpers.js';
import { tempWorkspace } from './helpers.js';

const MALICIOUS_SLUGS = [
  '..',
  '../..',
  '../fora',
  'a/../../fora',
  '..\\..\\fora',
  'C:\\Windows',
  '/etc',
  '.',
  '.git',
  'Maiusculo',
  'com espaço',
  '-comeca-com-hifen',
  'x'.repeat(65),
  '',
];

const MALICIOUS_IDS = ['../board', '..\\..\\x', 'T-001/../../x', 'T-001.md', 'T-1234567', '../../etc/passwd', 'T-', 'X-001'];

describe('path traversal — núcleo', () => {
  it('safeJoin recusa qualquer caminho que escape da base', () => {
    const base = path.resolve('/tmp/boards');
    expect(safeJoin(base, 'app', 'tasks')).toBe(path.join(base, 'app', 'tasks'));
    for (const p of ['..', '../x', 'a/../../x', '/etc/passwd', path.resolve('/tmp/boards-evil')]) {
      expect(() => safeJoin(base, p), p).toThrow(/fora do diretório/);
    }
    expect(() => safeJoin(base, '.'), 'a própria base não é alvo válido').toThrow();
  });

  it('IDs maliciosos são rejeitados pela regex', () => {
    for (const id of MALICIOUS_IDS) expect(() => normalizeTaskId(id), id).toThrow(/ID de tarefa inválido/);
  });

  it('store rejeita slugs maliciosos em todas as operações e nada é escrito fora de boards/', async () => {
    const { store, base } = await tempWorkspace();
    await store.createProject({ name: 'ok', slug: 'ok' });
    for (const slug of MALICIOUS_SLUGS) {
      await expect(store.createProject({ name: 'x', slug }), slug).rejects.toThrow(/Slug de projeto inválido/);
      await expect(store.createTask(slug, { title: 'x' }), slug).rejects.toThrow(/inválido/);
      await expect(store.listTasks(slug), slug).rejects.toThrow(/inválido/);
    }
    for (const id of MALICIOUS_IDS) {
      await expect(store.updateTask('ok', id, { title: 'x' }), id).rejects.toThrow(/ID de tarefa inválido/);
      await expect(store.deleteTask('ok', id), id).rejects.toThrow(/ID de tarefa inválido/);
    }
    expect((await readdir(base)).sort()).toEqual(['boards']);
    expect(await readdir(path.join(base, 'boards'))).toEqual(['ok']);
  });
});

describe('path traversal — API', () => {
  const encoded = [
    '..',
    '%2e%2e',
    '..%2F..%2Ffora',
    '%2E%2E%5C%2E%2E%5Cfora',
    'a%2F..%2F..%2Ffora',
    '%00',
    'C%3A%5CWindows',
  ];

  it('slugs codificados em URL são rejeitados (400/404), nunca 2xx', async () => {
    const { req, base } = await apiSetup();
    await req('POST', '/api/projects', { name: 'ok', slug: 'ok' });
    for (const s of encoded) {
      for (const [method, url, body] of [
        ['GET', `/api/projects/${s}/tasks`],
        ['POST', `/api/projects/${s}/tasks`, { title: 'x' }],
        ['GET', `/api/projects/${s}/summary`],
      ] as const) {
        const res = await req(method, url, body);
        expect([400, 404], `${method} ${url}`).toContain(res.status);
      }
    }
    for (const s of ['../fora', '..\\fora', 'Fora']) {
      const res = await req('POST', '/api/projects', { name: 'x', slug: s });
      expect(res.status, s).toBe(400);
    }
    expect((await readdir(base)).sort()).toEqual(['boards']);
  });

  it('IDs codificados em URL são rejeitados', async () => {
    const { req } = await apiSetup();
    await req('POST', '/api/projects', { name: 'ok', slug: 'ok' });
    for (const id of ['..%2Fboard', '..%5C..%5Cx', 'T-001%2F..%2F..%2Fx', 'T-001.md']) {
      const res = await req('PATCH', `/api/projects/ok/tasks/${id}`, { title: 'x' });
      expect([400, 404], id).toContain(res.status);
      const del = await req('DELETE', `/api/projects/ok/tasks/${id}`);
      expect([400, 404], id).toContain(del.status);
    }
  });
});

describe('autenticação', () => {
  it('bearerMatches só aceita o token exato', () => {
    expect(bearerMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(`bearer ${TOKEN}`, TOKEN)).toBe(true);
    for (const h of [undefined, '', TOKEN, `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(0, -1)}`, 'Bearer ', `Basic ${TOKEN}`, `Bearer ${TOKEN} extra`]) {
      expect(bearerMatches(h, TOKEN), String(h)).toBe(false);
    }
    expect(bearerMatches('Bearer ', ''), 'token vazio nunca autentica').toBe(false);
  });

  it('API responde 401 sem token ou com token errado, inclusive no SSE', async () => {
    const { app } = await apiSetup();
    for (const url of ['/api/projects', '/api/events', '/api/projects/x/summary']) {
      expect((await app.request(url)).status, url).toBe(401);
      expect((await app.request(url, { headers: { Authorization: 'Bearer errado' } })).status, url).toBe(401);
    }
  });

  it('createApp recusa subir sem token', async () => {
    const { store } = await tempWorkspace();
    const { createApp } = await import('../src/server/app.js');
    expect(() => createApp({ store, token: '' })).toThrow(/VCKB_TOKEN/);
  });
});

describe('limite de corpo', () => {
  it('responde 413 acima do limite', async () => {
    const { req } = await apiSetup({ maxBodyBytes: 1024 });
    await req('POST', '/api/projects', { name: 'ok', slug: 'ok' });
    const res = await req('POST', '/api/projects/ok/tasks', { title: 'x', description: 'a'.repeat(5000) });
    expect(res.status).toBe(413);
  });

  it('o store também limita o tamanho do corpo Markdown', async () => {
    const { req } = await apiSetup({ maxBodyBytes: 10 * 1024 * 1024 });
    await req('POST', '/api/projects', { name: 'ok', slug: 'ok' });
    const res = await req('POST', '/api/projects/ok/tasks', { title: 'x', body: 'a'.repeat(100_001) });
    expect(res.status).toBe(400);
  });
});

describe('CORS', () => {
  it('sem VCKB_CORS_ORIGINS não envia cabeçalhos CORS', async () => {
    const { req } = await apiSetup();
    const res = await req('GET', '/api/projects', undefined, { Origin: 'https://evil.example' });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('com origens configuradas libera só as listadas', async () => {
    const { req, app } = await apiSetup({ corsOrigins: ['http://localhost:5173'] });
    const ok = await req('GET', '/api/projects', undefined, { Origin: 'http://localhost:5173' });
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    const evil = await req('GET', '/api/projects', undefined, { Origin: 'https://evil.example' });
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
    const preflight = await app.request('/api/projects', {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'PATCH' },
    });
    expect(preflight.status).toBe(204);
  });
});

describe('arquivos .md hostis (achados da auditoria)', () => {
  it('frontmatter "---js" NÃO é executado (gray-matter usaria eval)', async () => {
    const { parseTask } = await import('../src/core/task-file.js');
    const g = globalThis as { __pwned?: boolean };
    g.__pwned = false;
    for (const lang of ['js', 'javascript', 'JS', ' js ', 'coffee', 'json']) {
      const raw = `---${lang}\n{ id: "T-001", title: (globalThis.__pwned = true, "x") }\n---\n`;
      expect(() => parseTask(raw), lang).toThrow(/YAML/);
    }
    expect(g.__pwned).toBe(false);
    expect(parseTask('---yaml\nid: T-001\ntitle: ok\n---\n').title).toBe('ok');
  });

  it('um .md "---js" em boards/ vira arquivo inválido na listagem, sem executar nada', async () => {
    const { store, boards } = await tempWorkspace();
    await store.createProject({ name: 'ok', slug: 'ok' });
    const { writeFile } = await import('node:fs/promises');
    const g = globalThis as { __pwned?: boolean };
    g.__pwned = false;
    await writeFile(path.join(boards, 'ok', 'tasks', 'T-001-x.md'), '---js\n{ id: "T-001", title: (globalThis.__pwned = true, "x") }\n---\n');
    expect((await store.summary('ok')).invalidFiles).toEqual([{ file: 'T-001-x.md', error: 'frontmatter deve ser YAML' }]);
    expect(g.__pwned).toBe(false);
  });

  it('checklist com linha gigante é processado em tempo linear (sem ReDoS)', async () => {
    const { getChecklist } = await import('../src/core/task-file.js');
    const evil = `## Checklist\n- [ ] a${' '.repeat(100_000)}!\n`;
    const t = performance.now();
    getChecklist(evil);
    expect(performance.now() - t).toBeLessThan(50);
  });

  it('slugs com nome de dispositivo do Windows são rejeitados', async () => {
    const { store } = await tempWorkspace();
    for (const slug of ['con', 'nul', 'aux', 'prn', 'com1', 'lpt9']) {
      await expect(store.createProject({ name: 'x', slug }), slug).rejects.toThrow(/Slug de projeto inválido/);
    }
  });

  it('frontmatter com __proto__ não contamina objetos', async () => {
    const { parseTask } = await import('../src/core/task-file.js');
    const t = parseTask('---\nid: T-001\ntitle: x\n__proto__:\n  polluted: true\n---\n');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(t.extra)).toEqual([]);
  });
});
