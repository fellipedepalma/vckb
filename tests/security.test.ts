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
  '../outside',
  'a/../../outside',
  '..\\..\\outside',
  'C:\\Windows',
  '/etc',
  '.',
  '.git',
  'UpperCase',
  'with space',
  '-leading-hyphen',
  'x'.repeat(65),
  '',
];

const MALICIOUS_IDS = ['../board', '..\\..\\x', 'T-001/../../x', 'T-001.md', 'T-1234567', '../../etc/passwd', 'T-', 'X-001'];

describe('path traversal — core', () => {
  it('safeJoin rejects any path that escapes the base', () => {
    const base = path.resolve('/tmp/boards');
    expect(safeJoin(base, 'app', 'tasks')).toBe(path.join(base, 'app', 'tasks'));
    for (const p of ['..', '../x', 'a/../../x', '/etc/passwd', path.resolve('/tmp/boards-evil')]) {
      expect(() => safeJoin(base, p), p).toThrow(/escapes the boards directory/);
    }
    expect(() => safeJoin(base, '.'), 'the base itself is not a valid target').toThrow();
  });

  it('malicious IDs are rejected by the regex', () => {
    for (const id of MALICIOUS_IDS) expect(() => normalizeTaskId(id), id).toThrow(/Invalid task ID/);
  });

  it('the store rejects malicious slugs in every operation and nothing is written outside the boards dir', async () => {
    const { store, base } = await tempWorkspace();
    await store.createProject({ name: 'ok', slug: 'ok' });
    for (const slug of MALICIOUS_SLUGS) {
      await expect(store.createProject({ name: 'x', slug }), slug).rejects.toThrow(/Invalid project slug/);
      await expect(store.createTask(slug, { title: 'x' }), slug).rejects.toThrow(/Invalid/);
      await expect(store.listTasks(slug), slug).rejects.toThrow(/Invalid/);
    }
    for (const id of MALICIOUS_IDS) {
      await expect(store.updateTask('ok', id, { title: 'x' }), id).rejects.toThrow(/Invalid task ID/);
      await expect(store.deleteTask('ok', id), id).rejects.toThrow(/Invalid task ID/);
    }
    expect((await readdir(base)).sort()).toEqual(['boards']);
    expect(await readdir(path.join(base, 'boards'))).toEqual(['ok']);
  });
});

describe('path traversal — API', () => {
  const encoded = [
    '..',
    '%2e%2e',
    '..%2F..%2Foutside',
    '%2E%2E%5C%2E%2E%5Coutside',
    'a%2F..%2F..%2Foutside',
    '%00',
    'C%3A%5CWindows',
  ];

  it('URL-encoded slugs are rejected (400/404), never 2xx', async () => {
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
    for (const s of ['../outside', '..\\outside', 'Outside']) {
      const res = await req('POST', '/api/projects', { name: 'x', slug: s });
      expect(res.status, s).toBe(400);
    }
    expect((await readdir(base)).sort()).toEqual(['boards']);
  });

  it('URL-encoded IDs are rejected', async () => {
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

describe('authentication', () => {
  it('bearerMatches only accepts the exact token', () => {
    expect(bearerMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(`bearer ${TOKEN}`, TOKEN)).toBe(true);
    for (const h of [undefined, '', TOKEN, `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(0, -1)}`, 'Bearer ', `Basic ${TOKEN}`, `Bearer ${TOKEN} extra`]) {
      expect(bearerMatches(h, TOKEN), String(h)).toBe(false);
    }
    expect(bearerMatches('Bearer ', ''), 'an empty token never authenticates').toBe(false);
  });

  it('the API answers 401 without a token or with a wrong one, SSE included', async () => {
    const { app } = await apiSetup();
    for (const url of ['/api/projects', '/api/events', '/api/projects/x/summary']) {
      expect((await app.request(url)).status, url).toBe(401);
      expect((await app.request(url, { headers: { Authorization: 'Bearer wrong' } })).status, url).toBe(401);
    }
  });

  it('createApp refuses to start without a token', async () => {
    const { store } = await tempWorkspace();
    const { createApp } = await import('../src/server/app.js');
    expect(() => createApp({ store, token: '' })).toThrow(/VCKB_TOKEN/);
  });
});

describe('body limit', () => {
  it('answers 413 above the limit', async () => {
    const { req } = await apiSetup({ maxBodyBytes: 1024 });
    await req('POST', '/api/projects', { name: 'ok', slug: 'ok' });
    const res = await req('POST', '/api/projects/ok/tasks', { title: 'x', description: 'a'.repeat(5000) });
    expect(res.status).toBe(413);
  });

  it('the store also limits the Markdown body size', async () => {
    const { req } = await apiSetup({ maxBodyBytes: 10 * 1024 * 1024 });
    await req('POST', '/api/projects', { name: 'ok', slug: 'ok' });
    const res = await req('POST', '/api/projects/ok/tasks', { title: 'x', body: 'a'.repeat(100_001) });
    expect(res.status).toBe(400);
  });
});

describe('CORS', () => {
  it('sends no CORS headers without VCKB_CORS_ORIGINS', async () => {
    const { req } = await apiSetup();
    const res = await req('GET', '/api/projects', undefined, { Origin: 'https://evil.example' });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('with configured origins, allows only those', async () => {
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

describe('hostile .md files (audit findings)', () => {
  it('"---js" frontmatter is NOT executed (some frontmatter libraries would eval it)', async () => {
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

  it('a "---js" .md in the boards dir shows up as an invalid file, executing nothing', async () => {
    const { store, boards } = await tempWorkspace();
    await store.createProject({ name: 'ok', slug: 'ok' });
    const { writeFile } = await import('node:fs/promises');
    const g = globalThis as { __pwned?: boolean };
    g.__pwned = false;
    await writeFile(path.join(boards, 'ok', 'tasks', 'T-001-x.md'), '---js\n{ id: "T-001", title: (globalThis.__pwned = true, "x") }\n---\n');
    expect((await store.summary('ok')).warnings).toContainEqual({ code: 'invalid_file', file: 'T-001-x.md', message: 'T-001-x.md: frontmatter must be YAML' });
    expect(g.__pwned).toBe(false);
  });

  it('a checklist with a huge line is processed in linear time (no ReDoS)', async () => {
    const { getChecklist } = await import('../src/core/task-file.js');
    const evil = `## Checklist\n- [ ] a${' '.repeat(100_000)}!\n`;
    const t = performance.now();
    getChecklist(evil);
    expect(performance.now() - t).toBeLessThan(50);
  });

  it('Windows device names are rejected as slugs', async () => {
    const { store } = await tempWorkspace();
    for (const slug of ['con', 'nul', 'aux', 'prn', 'com1', 'lpt9']) {
      await expect(store.createProject({ name: 'x', slug }), slug).rejects.toThrow(/Invalid project slug/);
    }
  });

  it('__proto__ in frontmatter does not pollute objects', async () => {
    const { parseTask } = await import('../src/core/task-file.js');
    const t = parseTask('---\nid: T-001\ntitle: x\n__proto__:\n  polluted: true\n---\n');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(t.extra)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Web UI session (cookie) authentication, CSRF, Host allow-list, rate limiting
// ---------------------------------------------------------------------------

const T0 = Date.parse('2026-09-30T12:00:00Z');
const UI = { Origin: 'http://localhost', 'X-VCKB-CSRF': '1' };

async function sessionSetup(opts: Parameters<typeof apiSetup>[0] = {}) {
  const clock = { t: T0 };
  const ctx = await apiSetup({ now: () => clock.t, ...opts });
  await ctx.req('POST', '/api/projects', { name: 'ok', slug: 'ok' });
  /** Request with no Authorization header (browser-like). */
  const raw = (method: string, url: string, headers: Record<string, string> = {}, body?: unknown) =>
    ctx.app.request(url, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const login = (token = TOKEN, headers: Record<string, string> = UI, url = '/api/session') => raw('POST', url, headers, { token });
  const cookieOf = (res: Response) => /vckb_session=([^;]*)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';
  const withCookie = (cookie: string, extra: Record<string, string> = {}) => ({ Cookie: `vckb_session=${cookie}`, ...extra });
  return { ...ctx, clock, raw, login, cookieOf, withCookie };
}

describe('session cookie', () => {
  it('login sets vckb_session with HttpOnly, SameSite=Strict, Path=/api, Max-Age=7 days, no Secure over http', async () => {
    const { login } = await sessionSetup();
    const res = await login();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ expiresAt: '2026-10-07T12:00:00.000Z' });
    const set = res.headers.get('set-cookie')!;
    expect(set).toMatch(/^vckb_session=v1\.\d+\.[\w-]{16}\.[\w-]{43};/);
    for (const attr of ['Max-Age=604800', 'Path=/api', 'HttpOnly', 'SameSite=Strict']) expect(set).toContain(attr);
    expect(set).not.toMatch(/Secure/i);
  });

  it('Secure over HTTPS; X-Forwarded-Proto is honored only with trustProxy', async () => {
    const direct = await sessionSetup();
    const https = await direct.login(TOKEN, { ...UI, Origin: 'https://localhost' }, 'https://localhost/api/session');
    expect(https.headers.get('set-cookie')).toContain('Secure');
    const spoofed = await direct.login(TOKEN, { ...UI, 'X-Forwarded-Proto': 'https' });
    expect(spoofed.headers.get('set-cookie')).not.toContain('Secure');
    const proxied = await sessionSetup({ trustProxy: true });
    expect((await proxied.login(TOKEN, { ...UI, 'X-Forwarded-Proto': 'https' })).headers.get('set-cookie')).toContain('Secure');
  });

  it('a valid cookie authenticates reads, /session and SSE', async () => {
    const { login, raw, cookieOf, withCookie } = await sessionSetup();
    const cookie = cookieOf(await login());
    expect((await raw('GET', '/api/projects', withCookie(cookie))).status).toBe(200);
    expect(await (await raw('GET', '/api/session', withCookie(cookie))).json()).toEqual({
      authenticated: true,
      via: 'cookie',
      expiresAt: '2026-10-07T12:00:00.000Z',
    });
    const sse = await raw('GET', '/api/events', withCookie(cookie));
    expect(sse.status).toBe(200);
    expect(sse.headers.get('content-type')).toMatch(/text\/event-stream/);
    await sse.body!.cancel();
  });

  it('rejects garbage, tampered and forged cookies', async () => {
    const { login, raw, cookieOf, withCookie } = await sessionSetup();
    const cookie = cookieOf(await login());
    const [v, exp, nonce, mac] = cookie.split('.');
    const flip = (s: string) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
    const bad = [
      'garbage',
      '',
      `${v}.${Number(exp) + 3600}.${nonce}.${mac}`, // extended expiry
      `${v}.${exp}.${flip(nonce)}.${mac}`,
      `${v}.${exp}.${nonce}.${flip(mac)}`,
      `v2.${exp}.${nonce}.${mac}`,
      `${cookie}x`,
    ];
    for (const c of bad) expect((await raw('GET', '/api/projects', withCookie(c))).status, c).toBe(401);
  });

  it('the HMAC key is derived with HKDF, never the raw token: a cookie signed with the token itself fails', async () => {
    const { createHmac } = await import('node:crypto');
    const { raw, withCookie } = await sessionSetup();
    const payload = `v1.${T0 / 1000 + 3600}.AAAAAAAAAAAAAAAA`;
    const forged = `${payload}.${createHmac('sha256', TOKEN).update(payload).digest('base64url')}`;
    expect((await raw('GET', '/api/projects', withCookie(forged))).status).toBe(401);
  });

  it('expires after 7 days', async () => {
    const { login, raw, cookieOf, withCookie, clock } = await sessionSetup();
    const cookie = cookieOf(await login());
    clock.t = T0 + 7 * 86_400_000 - 1_000;
    expect((await raw('GET', '/api/projects', withCookie(cookie))).status).toBe(200);
    clock.t = T0 + 7 * 86_400_000;
    expect((await raw('GET', '/api/projects', withCookie(cookie))).status).toBe(401);
  });

  it('changing VCKB_TOKEN invalidates every existing session', async () => {
    const { login, cookieOf, store } = await sessionSetup();
    const cookie = cookieOf(await login());
    const { createApp } = await import('../src/server/app.js');
    const rotated = createApp({ store, token: 'a-brand-new-token-0123456789', now: () => T0 });
    const res = await rotated.request('/api/projects', { headers: { Cookie: `vckb_session=${cookie}` } });
    expect(res.status).toBe(401);
  });

  it('logout clears the cookie (Max-Age=0) and needs the CSRF proof', async () => {
    const { raw, login, cookieOf, withCookie } = await sessionSetup();
    const cookie = cookieOf(await login());
    expect((await raw('POST', '/api/session/logout', withCookie(cookie))).status).toBe(403);
    const res = await raw('POST', '/api/session/logout', withCookie(cookie, UI));
    expect(res.status).toBe(204);
    const set = res.headers.get('set-cookie')!;
    expect(set).toMatch(/^vckb_session=;/);
    expect(set).toContain('Max-Age=0');
    expect(set).toContain('Path=/api');
  });
});

describe('CSRF (cookie-authenticated state changes)', () => {
  it('rejects mutations without X-VCKB-CSRF, without Origin, with "null" or a foreign Origin', async () => {
    const { login, raw, cookieOf, withCookie } = await sessionSetup();
    const cookie = cookieOf(await login());
    const cases: [Record<string, string>, RegExp][] = [
      [{ Origin: 'http://localhost' }, /missing X-VCKB-CSRF/],
      [{ 'X-VCKB-CSRF': '1' }, /missing Origin/],
      [{ 'X-VCKB-CSRF': '1', Origin: 'null' }, /missing Origin/],
      [{ 'X-VCKB-CSRF': '1', Origin: 'http://evil.example' }, /does not match Host/],
      [{ 'X-VCKB-CSRF': '1', Origin: 'http://localhost.evil.example' }, /does not match Host/],
      [{ 'X-VCKB-CSRF': '1', Origin: 'http://localhost:3000' }, /does not match Host/], // another local dev server
    ];
    const targets: [string, string, unknown?][] = [
      ['POST', '/api/projects/ok/tasks', { title: 'x' }],
      ['PATCH', '/api/projects/ok/tasks/T-001', { title: 'x' }],
      ['DELETE', '/api/projects/ok/tasks/T-001'],
      ['POST', '/api/projects', { name: 'x' }],
    ];
    for (const [headers, error] of cases) {
      for (const [method, url, body] of targets) {
        const res = await raw(method, url, withCookie(cookie, headers), body);
        expect(res.status, `${method} ${url} ${JSON.stringify(headers)}`).toBe(403);
        expect((await res.json()).error).toMatch(error);
      }
    }
    expect(await (await raw('GET', '/api/projects/ok/tasks', withCookie(cookie))).json()).toEqual([]);
  });

  it('accepts a mutation with the header and a same-host Origin (or one in allowedOrigins)', async () => {
    const { login, raw, cookieOf, withCookie } = await sessionSetup({ allowedOrigins: ['https://vckb.tailnet.ts.net'] });
    const cookie = cookieOf(await login());
    const created = await raw('POST', '/api/projects/ok/tasks', withCookie(cookie, UI), { title: 'from the UI' });
    expect(created.status).toBe(201);
    const origin = { ...UI, Origin: 'https://vckb.tailnet.ts.net' };
    expect((await raw('PATCH', '/api/projects/ok/tasks/T-001', withCookie(cookie, origin), { priority: 'high' })).status).toBe(200);
  });

  it('Bearer requests do not need the CSRF header or Origin (not an automatic credential)', async () => {
    const { app } = await sessionSetup();
    const res = await app.request('/api/projects/ok/tasks', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'from an agent' }),
    });
    expect(res.status).toBe(201);
  });

  it('a wrong Bearer never falls back to a valid cookie', async () => {
    const { login, raw, cookieOf, withCookie } = await sessionSetup();
    const cookie = cookieOf(await login());
    expect((await raw('GET', '/api/projects', withCookie(cookie, { Authorization: 'Bearer wrong' }))).status).toBe(401);
  });

  it('login itself needs the CSRF proof', async () => {
    const { login } = await sessionSetup();
    expect((await login(TOKEN, { Origin: 'http://evil.example', 'X-VCKB-CSRF': '1' })).status).toBe(403);
    expect((await login(TOKEN, { Origin: 'http://localhost' })).status).toBe(403);
  });
});

describe('Host allow-list (DNS rebinding)', () => {
  it('answers 421 to a Host outside the list, before authentication', async () => {
    const { app } = await sessionSetup();
    const auth = { Authorization: `Bearer ${TOKEN}` };
    for (const host of ['evil.example', 'evil.example:8787', '127.0.0.1.evil.example', '192.168.0.10']) {
      expect((await app.request(`http://${host}/api/projects`, { headers: auth })).status, host).toBe(421);
      expect((await app.request('/api/projects', { headers: { ...auth, Host: host } })).status, `Host: ${host}`).toBe(421);
    }
    expect((await app.request('http://evil.example/api/projects')).status).toBe(421);
    for (const host of ['localhost:8787', '127.0.0.1:8787', '[::1]:8787', 'LOCALHOST']) {
      expect((await app.request('/api/projects', { headers: { ...auth, Host: host } })).status, host).toBe(200);
    }
  });

  it('extra hosts (e.g. a Tailscale name) can be allowed', async () => {
    const { defaultAllowedHosts } = await import('../src/server/auth.js');
    const { app } = await sessionSetup({ allowedHosts: defaultAllowedHosts('0.0.0.0', ['vckb.tailnet.ts.net', '100.101.102.103']) });
    const auth = { Authorization: `Bearer ${TOKEN}` };
    for (const host of ['vckb.tailnet.ts.net', '100.101.102.103:8787', 'localhost']) {
      expect((await app.request('/api/projects', { headers: { ...auth, Host: host } })).status, host).toBe(200);
    }
    expect((await app.request('/api/projects', { headers: { ...auth, Host: '0.0.0.0' } })).status).toBe(421);
  });

  it('config: loopback + bind address + VCKB_ALLOWED_HOSTS; wildcard bind addresses are not hosts', async () => {
    const { readServerConfig } = await import('../src/server/config.js');
    const env = { VCKB_TOKEN: TOKEN };
    expect(readServerConfig(env).config.allowedHosts).toEqual(['localhost', '127.0.0.1', '[::1]']);
    expect(readServerConfig({ ...env, VCKB_HOST: '100.64.0.7' }).config.allowedHosts).toContain('100.64.0.7');
    const docker = readServerConfig({ ...env, VCKB_HOST: '0.0.0.0', VCKB_IN_CONTAINER: '1', VCKB_ALLOWED_HOSTS: 'Box.ts.net:8787, ::1' });
    expect(docker.config.allowedHosts).toEqual(['localhost', '127.0.0.1', '[::1]', 'box.ts.net']);
    expect(readServerConfig({ ...env, VCKB_ALLOWED_ORIGINS: 'https://box.ts.net/, not-an-origin' })).toMatchObject({
      config: { allowedOrigins: ['https://box.ts.net'] },
      errors: [expect.stringMatching(/not-an-origin/)],
    });
    expect(readServerConfig({ ...env, VCKB_TRUST_PROXY: 'true' }).config.trustProxy).toBe(true);
    expect(readServerConfig({ ...env, VCKB_TRUST_PROXY: '1' }).config.trustProxy).toBe(false);
  });
});

describe('rate limiting', () => {
  it('login: exponential backoff per client; blocked clients are refused even with the right token', async () => {
    const { login, clock } = await sessionSetup({ rateLimit: { freeAttempts: 2, baseMs: 1_000 } });
    expect((await login('wrong')).status).toBe(401);
    expect((await login('wrong')).status).toBe(401);
    expect((await login('wrong')).status).toBe(401); // 3rd failure: blocked for 1 s
    let res = await login();
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('1');
    clock.t += 1_000;
    expect((await login('wrong')).status).toBe(401); // 4th failure: blocked for 2 s
    res = await login();
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('2');
    clock.t += 2_000;
    expect((await login()).status).toBe(200); // success clears the record
    expect((await login('wrong')).status).toBe(401);
    expect((await login()).status).toBe(200);
  });

  it('the block is capped at maxMs', async () => {
    const { login, clock } = await sessionSetup({ rateLimit: { freeAttempts: 0, baseMs: 1_000, maxMs: 4_000 } });
    for (let i = 0; i < 10; i++) {
      expect((await login('wrong')).status).toBe(401);
      clock.t += 60_000;
    }
    await login('wrong');
    expect((await login()).headers.get('retry-after')).toBe('4');
  });

  it('is per client: another address is not blocked (X-Forwarded-For used only with trustProxy)', async () => {
    const { login } = await sessionSetup({ trustProxy: true, rateLimit: { freeAttempts: 0 } });
    const from = (ip: string) => ({ ...UI, 'X-Forwarded-For': `203.0.113.9, ${ip}` });
    expect((await login('wrong', from('10.0.0.1'))).status).toBe(401);
    expect((await login(TOKEN, from('10.0.0.1'))).status).toBe(429);
    expect((await login(TOKEN, from('10.0.0.2'))).status).toBe(200);
  });

  it('default (no trustProxy): X-Forwarded-For is ignored, so clients behind a proxy share one bucket', async () => {
    const { login } = await sessionSetup({ rateLimit: { freeAttempts: 0 } });
    const from = (ip: string) => ({ ...UI, 'X-Forwarded-For': ip });
    expect((await login('wrong', from('10.0.0.1'))).status).toBe(401);
    // A different forwarded address does not escape the block: only the socket address counts.
    expect((await login(TOKEN, from('10.0.0.2'))).status).toBe(429);
    expect((await login(TOKEN, UI)).status).toBe(429);
  });

  it('trustProxy: only the hop appended by the trusted proxy (rightmost) counts; forged entries are ignored', async () => {
    const { login } = await sessionSetup({ trustProxy: true, rateLimit: { freeAttempts: 0 } });
    const xff = (value: string) => ({ ...UI, 'X-Forwarded-For': value });
    expect((await login('wrong', xff('1.1.1.1, 10.0.0.1'))).status).toBe(401);
    // Same real client (10.0.0.1) forging a different leftmost entry: still blocked.
    expect((await login(TOKEN, xff('2.2.2.2, 10.0.0.1'))).status).toBe(429);
    expect((await login(TOKEN, xff('10.0.0.2, 10.0.0.1'))).status).toBe(429);
    // Another real client (10.0.0.2) is not affected, even when it forges 10.0.0.1 on the left.
    expect((await login(TOKEN, xff('10.0.0.1, 10.0.0.2'))).status).toBe(200);
  });

  it('failed Bearer tokens are rate limited too', async () => {
    const { app } = await sessionSetup({ rateLimit: { freeAttempts: 3 } });
    const call = (token: string) => app.request('/api/projects', { headers: { Authorization: `Bearer ${token}` } });
    for (let i = 0; i < 4; i++) expect((await call('wrong')).status).toBe(401);
    const blocked = await call(TOKEN);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('requests without any credential are not counted as failures', async () => {
    const { app, login } = await sessionSetup({ rateLimit: { freeAttempts: 0 } });
    for (let i = 0; i < 5; i++) expect((await app.request('/api/projects')).status).toBe(401);
    expect((await login()).status).toBe(200);
  });
});

describe('security headers', () => {
  it('CSP, nosniff, no-referrer on every response; no-store on the API (errors included)', async () => {
    const { app, req } = await sessionSetup();
    const responses = [
      await req('GET', '/api/projects'),
      await app.request('/api/projects'), // 401
      await req('GET', '/api/nope'), // 404
      await app.request('http://evil.example/api/projects'), // 421
    ];
    for (const res of responses) {
      expect(res.headers.get('content-security-policy'), String(res.status)).toBe(
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });
});
