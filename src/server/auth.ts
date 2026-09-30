import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Session cookies for the web UI.
 *
 * The browser exchanges VCKB_TOKEN once for an HttpOnly cookie, so page scripts never hold the
 * token. The cookie is stateless: `v1.<expires>.<nonce>.<mac>`, where mac = HMAC-SHA256 over
 * `v1.<expires>.<nonce>` with a key derived from VCKB_TOKEN by HKDF. Rotating VCKB_TOKEN changes
 * the key and invalidates every session; restarts don't.
 */

export const SESSION_COOKIE = 'vckb_session';
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const SESSION_KEY_INFO = 'vckb-session-v1';
const SESSION_RE = /^v1\.(\d{1,12})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{43})$/;

export function deriveSessionKey(token: string): Buffer {
  return Buffer.from(hkdfSync('sha256', token, Buffer.alloc(0), SESSION_KEY_INFO, 32));
}

function mac(key: Buffer, payload: string): Buffer {
  return createHmac('sha256', key).update(payload).digest();
}

export function createSession(key: Buffer, nowMs: number): { value: string; expiresAt: number } {
  const expiresAt = Math.floor(nowMs / 1000) + SESSION_TTL_SECONDS;
  const payload = `v1.${expiresAt}.${randomBytes(12).toString('base64url')}`;
  return { value: `${payload}.${mac(key, payload).toString('base64url')}`, expiresAt };
}

/** Returns the expiry (seconds since epoch) of a valid, unexpired session, or null. */
export function verifySession(key: Buffer, value: string | undefined, nowMs: number): number | null {
  const m = value ? SESSION_RE.exec(value) : null;
  if (!m) return null;
  const given = Buffer.from(m[3], 'base64url');
  const expected = mac(key, `v1.${m[1]}.${m[2]}`);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const expiresAt = Number(m[1]);
  return expiresAt * 1000 > nowMs ? expiresAt : null;
}

/** Constant-time comparison of a presented token with VCKB_TOKEN (hashed: lengths don't leak). */
export function tokenMatches(given: string, token: string): boolean {
  if (!given || !token) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(token).digest();
  return timingSafeEqual(a, b);
}

// ----------------------------------------------------------------- rate limiting

export interface RateLimitOptions {
  /** Failures allowed before the backoff starts (default 5). */
  freeAttempts?: number;
  /** First block duration; doubles with every further failure (default 1 s). */
  baseMs?: number;
  /** Longest block (default 5 min). */
  maxMs?: number;
  /** Failures are forgotten after this long without a new one (default 1 h). */
  forgetMs?: number;
  /** Most clients tracked at once; the oldest entries are dropped beyond it (default 10 000). */
  maxEntries?: number;
}

interface Entry {
  failures: number;
  blockedUntil: number;
  lastFailure: number;
}

/**
 * In-memory, per-client exponential backoff for failed authentications. After `freeAttempts`
 * failures, the client is blocked for baseMs, then 2x, 4x... up to maxMs; while blocked, even a
 * correct credential is refused (otherwise guessing could continue). Success clears the entry.
 */
export class RateLimiter {
  private readonly entries = new Map<string, Entry>();
  private readonly o: Required<RateLimitOptions>;

  constructor(opts: RateLimitOptions = {}) {
    this.o = { freeAttempts: 5, baseMs: 1_000, maxMs: 5 * 60_000, forgetMs: 60 * 60_000, maxEntries: 10_000, ...opts };
  }

  /** Milliseconds until `client` may try again (0 = allowed now). */
  retryAfterMs(client: string, now: number): number {
    const e = this.entries.get(client);
    if (!e) return 0;
    if (now - e.lastFailure > this.o.forgetMs) {
      this.entries.delete(client);
      return 0;
    }
    return Math.max(0, e.blockedUntil - now);
  }

  fail(client: string, now: number): void {
    const e = this.entries.get(client) ?? { failures: 0, blockedUntil: 0, lastFailure: now };
    e.failures++;
    e.lastFailure = now;
    const over = e.failures - this.o.freeAttempts;
    if (over > 0) e.blockedUntil = now + Math.min(this.o.maxMs, this.o.baseMs * 2 ** Math.min(over - 1, 30));
    this.entries.delete(client); // re-insert: Map order = least recently failed first
    this.entries.set(client, e);
    while (this.entries.size > this.o.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }

  succeed(client: string): void {
    this.entries.delete(client);
  }
}

// ----------------------------------------------------------------- hosts and origins

/** "Example.com:8787" -> "example.com"; "[::1]:8787" -> "[::1]". */
export function hostnameOf(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  if (h.split(':').length > 2) return `[${h}]`; // bare IPv6 such as "::1"
  return h.replace(/:\d*$/, '');
}

const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]']);

/**
 * Host names the server answers to (the port is not compared: DNS rebinding works through names).
 * Default: loopback names plus the bind address when it is a specific one.
 */
export function defaultAllowedHosts(bindHost: string, extra: string[] = []): string[] {
  const hosts = ['localhost', '127.0.0.1', '[::1]'];
  const bind = hostnameOf(bindHost);
  if (bind && !WILDCARD_HOSTS.has(bind)) hosts.push(bind);
  return [...new Set([...hosts, ...extra].map(hostnameOf).filter(Boolean))];
}
