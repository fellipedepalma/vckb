import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Temp/lock files that the watcher and listings must ignore. */
export const TEMP_FILE_RE = /\.tmp-[a-z0-9]+$|\.vckb\.lock$/i;

/**
 * Atomic write: write to a temp file in the same directory, then rename it.
 * On Windows the rename can fail with EPERM/EBUSY while another process (antivirus,
 * editor, watcher) holds the file open, so we retry a few times.
 */
export async function atomicWrite(file: string, data: string): Promise<void> {
  const tmp = `${file}.tmp-${randomBytes(6).toString('hex')}`;
  await fs.writeFile(tmp, data, 'utf8');
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt < 10 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
        await sleep(20 * (attempt + 1));
        continue;
      }
      await fs.rm(tmp, { force: true });
      throw err;
    }
  }
}

export const LOCK_NAME = '.vckb.lock';
const OWNER_FILE = 'owner.json';

export interface LockOptions {
  /** A lock whose owner has not refreshed it for this long is stale (default 10 s). */
  staleMs?: number;
  /** Give up waiting after this long (default 15 s, longer than staleMs so a stale lock is always reached). */
  timeoutMs?: number;
}

export interface LockOwner {
  pid: number;
  host: string;
  /** Random per acquisition: tells "the lock I saw" apart from a newer one at the same path. */
  nonce: string;
  acquiredAt: string;
}

async function readOwner(lock: string): Promise<{ owner: LockOwner | null; ageMs: number } | null> {
  // Age comes from owner.json's mtime (refreshed by the holder), or the dir's if the holder
  // died between mkdir and writing owner.json.
  const ownerFile = path.join(lock, OWNER_FILE);
  const stat = (await fs.stat(ownerFile).catch(() => null)) ?? (await fs.stat(lock).catch(() => null));
  if (!stat) return null; // released meanwhile
  let owner: LockOwner | null = null;
  try {
    const data = JSON.parse(await fs.readFile(ownerFile, 'utf8'));
    if (typeof data?.nonce === 'string') owner = data;
  } catch {
    // missing or half-written owner.json: judged by age only
  }
  return { owner, ageMs: Date.now() - stat.mtimeMs };
}

/**
 * On Windows, mkdir fails with EPERM (not EEXIST) while a directory with the same name is still
 * being deleted by another process. It is transient: retry.
 */
function isPendingDelete(err: unknown): boolean {
  return process.platform === 'win32' && (err as NodeJS.ErrnoException).code === 'EPERM';
}

/** false only when the process is known to be gone. EPERM means it exists under another user. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Stale when its owner is a dead process on this host, or when it has not been refreshed for
 * `staleMs`. PIDs from another host (e.g. a container sharing the boards volume) can't be
 * checked, so those locks expire by age only.
 */
function isStale(info: { owner: LockOwner | null; ageMs: number }, staleMs: number): boolean {
  const { owner, ageMs } = info;
  if (owner && owner.host === os.hostname() && Number.isInteger(owner.pid) && owner.pid > 0 && !processAlive(owner.pid)) {
    return true;
  }
  return ageMs > staleMs;
}

/**
 * Breaks a stale lock without racing other waiters. Breaking is serialized by a second mkdir
 * guard, and the guard holder re-checks staleness before removing: a waiter acting on an old
 * reading can't delete a lock another waiter has just acquired (a fresh lock, even one whose
 * owner.json isn't written yet, is never stale).
 */
async function breakLock(lock: string, staleMs: number): Promise<void> {
  const guard = `${lock}.breaking`;
  try {
    await fs.mkdir(guard);
  } catch (err) {
    if (isPendingDelete(err)) return;
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    // Someone else is breaking it. A guard left by a breaker that died is cleared by age.
    const stat = await fs.stat(guard).catch(() => null);
    if (stat && Date.now() - stat.mtimeMs > staleMs) await fs.rm(guard, { recursive: true, force: true });
    return;
  }
  try {
    const info = await readOwner(lock);
    if (info && isStale(info, staleMs)) await fs.rm(lock, { recursive: true, force: true });
  } finally {
    await fs.rm(guard, { recursive: true, force: true });
  }
}

/**
 * Cross-process lock (server, CLI, agents) based on mkdir, which is atomic. Serializes writes to
 * a board so updates aren't lost and IDs aren't duplicated. Locks left behind by a crashed process
 * are recovered: immediately if its PID is dead on this host, otherwise after `staleMs`.
 */
export async function withLock<T>(dir: string, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
  const staleMs = opts.staleMs ?? 10_000;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const lock = path.join(dir, LOCK_NAME);
  const me: LockOwner = { pid: process.pid, host: os.hostname(), nonce: randomBytes(8).toString('hex'), acquiredAt: new Date().toISOString() };
  const start = Date.now();
  for (;;) {
    try {
      await fs.mkdir(lock);
      break;
    } catch (err) {
      if (isPendingDelete(err)) {
        if (Date.now() - start > timeoutMs) throw err;
        await sleep(10);
        continue;
      }
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const info = await readOwner(lock);
      if (info && isStale(info, staleMs)) {
        await breakLock(lock, staleMs);
        continue;
      }
      if (Date.now() - start > timeoutMs) {
        const who = info?.owner ? ` (held by pid ${info.owner.pid} on ${info.owner.host})` : '';
        throw new Error(`Timed out waiting for lock at ${lock}${who}`);
      }
      await sleep(25);
    }
  }

  const ownerFile = path.join(lock, OWNER_FILE);
  try {
    await fs.writeFile(ownerFile, JSON.stringify(me), 'utf8');
  } catch (err) {
    await fs.rm(lock, { recursive: true, force: true });
    throw err;
  }
  // Heartbeat: a long operation keeps its lock fresh and is never mistaken for a stale one.
  const heartbeat = setInterval(() => {
    const now = new Date();
    fs.utimes(ownerFile, now, now).catch(() => undefined);
  }, Math.max(50, Math.floor(staleMs / 3)));
  heartbeat.unref();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    // Remove only our own lock: never one that replaced it.
    const current = await readOwner(lock);
    if (current?.owner?.nonce === me.nonce) await fs.rm(lock, { recursive: true, force: true });
  }
}
