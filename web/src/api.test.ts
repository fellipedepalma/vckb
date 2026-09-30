import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, NetworkError, onUnauthorized, request } from './api';
import { problemFor } from './components/Login';

type Call = { url: string; init: RequestInit };

function mockFetch(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  });
  return calls;
}

const header = (c: Call, name: string) => (c.init.headers as Record<string, string>)[name];

afterEach(() => vi.unstubAllGlobals());

describe('fetch wrapper', () => {
  it('sends the CSRF header on state-changing requests only, always with same-origin credentials', async () => {
    const calls = mockFetch(200, {});
    await api.get('/api/projects');
    await api.post('/api/projects', { name: 'x' });
    await api.patch('/api/projects/x/tasks/T-001', { title: 'y' });
    await api.delete('/api/projects/x/tasks/T-001');
    expect(calls.map((c) => [c.init.method, header(c, 'X-VCKB-CSRF')])).toEqual([
      ['GET', undefined],
      ['POST', '1'],
      ['PATCH', '1'],
      ['DELETE', '1'],
    ]);
    for (const c of calls) expect(c.init.credentials).toBe('same-origin');
  });

  it('sends If-Match with the quoted etag and returns the new ETag', async () => {
    const calls = mockFetch(200, { id: 'T-001' }, { ETag: '"abc123"' });
    const res = await api.patch('/api/projects/x/tasks/T-001', { title: 'y' }, { ifMatch: 'old456' });
    expect(header(calls[0], 'If-Match')).toBe('"old456"');
    expect(res.etag).toBe('abc123');
  });

  it('412 surfaces as ApiError(412) with the server message (the caller must not retry blindly)', async () => {
    mockFetch(412, { error: 'Task T-001 changed on disk since it was read' });
    const err = await api.patch('/api/x', {}, { ifMatch: 'e' }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 412, message: expect.stringMatching(/changed on disk/) });
  });

  it('429 carries Retry-After in seconds', async () => {
    mockFetch(429, { error: 'Too many failed attempts' }, { 'Retry-After': '8' });
    const err = await request('POST', '/api/session', { body: { token: 'x' }, quiet401: true }).catch((e) => e);
    expect(err).toMatchObject({ status: 429, retryAfter: 8 });
  });

  it('a 401 is broadcast (back to sign-in), except for the quiet sign-in/session probes', async () => {
    const heard = vi.fn();
    const off = onUnauthorized(heard);
    mockFetch(401, { error: 'Unauthorized' });
    await api.get('/api/projects').catch(() => undefined);
    expect(heard).toHaveBeenCalledTimes(1);
    await api.post('/api/session', { token: 'x' }, { quiet401: true }).catch(() => undefined);
    expect(heard).toHaveBeenCalledTimes(1);
    off();
  });

  it('a failed connection becomes NetworkError', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(api.get('/api/projects')).rejects.toBeInstanceOf(NetworkError);
  });
});

describe('sign-in problems', () => {
  it('maps statuses to the right message kind', () => {
    const now = 1_000_000;
    expect(problemFor(new ApiError(401, 'x'), now)).toEqual({ kind: 'wrong' });
    expect(problemFor(new ApiError(429, 'x', 12), now)).toEqual({ kind: 'tooMany', until: now + 12_000 });
    expect(problemFor(new ApiError(421, 'x'), now)).toEqual({ kind: 'misdirected' });
    expect(problemFor(new NetworkError(), now)).toEqual({ kind: 'network' });
    expect(problemFor(new ApiError(500, 'x'), now)).toEqual({ kind: 'other', status: 500 });
  });
});
