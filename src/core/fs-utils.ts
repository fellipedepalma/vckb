import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
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

const LOCK_NAME = '.vckb.lock';
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 5_000;

/**
 * Simple cross-process lock (server, CLI, agents) based on mkdir, which is atomic.
 * Serializes writes to a board so updates aren't lost and IDs aren't duplicated.
 */
export async function withLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const lock = path.join(dir, LOCK_NAME);
  const start = Date.now();
  for (;;) {
    try {
      await fs.mkdir(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const stat = await fs.stat(lock).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        await fs.rm(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for lock at ${lock}`);
      }
      await sleep(25);
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lock, { recursive: true, force: true });
  }
}
