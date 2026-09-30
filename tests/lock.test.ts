import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LOCK_NAME, withLock } from '../src/core/fs-utils.js';
import { tempWorkspace } from './helpers.js';

const FS_UTILS = pathToFileURL(path.resolve('src/core/fs-utils.ts')).href;

/** PID of a process that has already exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '']);
  await new Promise((r) => child.once('exit', r));
  return child.pid!;
}

async function plantLock(dir: string, owner: object | null, ageMs = 0) {
  const lock = path.join(dir, LOCK_NAME);
  await mkdir(lock);
  const then = new Date(Date.now() - ageMs);
  if (owner) {
    await writeFile(path.join(lock, 'owner.json'), JSON.stringify(owner));
    await utimes(path.join(lock, 'owner.json'), then, then);
  }
  await utimes(lock, then, then);
  return lock;
}

const timed = async <T>(fn: () => Promise<T>) => {
  const t = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - t };
};

describe('B: cross-process lock recovery', () => {
  it('a lock left by a process that was killed mid-write is recovered right away (dead PID)', async () => {
    const { base } = await tempWorkspace();
    // Real crash: a child takes the lock, never releases it, and is SIGKILLed.
    const script = path.join(base, 'holder.mjs');
    await writeFile(
      script,
      `setInterval(() => {}, 1000);\n` + // stay alive until killed
        `const { withLock } = await import(${JSON.stringify(FS_UTILS)});\n` +
        `await withLock(${JSON.stringify(base)}, () => { process.stdout.write('locked\\n'); return new Promise(() => {}); });\n`,
    );
    const child = spawn(process.execPath, ['--import', 'tsx', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (d) => String(d).includes('locked') && resolve());
      child.once('exit', (code) => reject(new Error(`holder exited early (${code})`)));
    });
    const owner = JSON.parse(await readFile(path.join(base, LOCK_NAME, 'owner.json'), 'utf8'));
    expect(owner).toMatchObject({ pid: child.pid, host: os.hostname() });
    expect(child.exitCode).toBeNull(); // still holding the lock
    child.kill('SIGKILL');
    const [, signal] = await new Promise<[number | null, string | null]>((r) => child.once('exit', (c, s) => r([c, s])));
    expect(signal).toBe('SIGKILL');
    // The lock (and its owner.json) survived the crash.
    expect(await readdir(path.join(base, LOCK_NAME))).toEqual(['owner.json']);

    // staleMs is huge: only the dead-PID check can explain a fast acquisition.
    const { value, ms } = await timed(() => withLock(base, async () => 'ran', { staleMs: 60_000, timeoutMs: 5_000 }));
    expect(value).toBe('ran');
    expect(ms).toBeLessThan(2_000);
    expect((await readdir(base)).filter((f) => f.includes(LOCK_NAME))).toEqual([]);
  });

  it('the store recovers from a planted dead-PID lock (createTask does not time out)', async () => {
    const { store, boards } = await tempWorkspace();
    await store.createProject({ name: 'App', slug: 'app' });
    await plantLock(path.join(boards, 'app'), { pid: await deadPid(), host: os.hostname(), nonce: 'dead', acquiredAt: new Date().toISOString() });
    const { value, ms } = await timed(() => store.createTask('app', { title: 'after crash' }));
    expect(value.id).toBe('T-001');
    expect(ms).toBeLessThan(2_000);
    expect(await readdir(path.join(boards, 'app'))).toEqual(['board.json', 'tasks']);
  });

  it('a lock older than staleMs is broken even when its PID cannot be checked (other host)', async () => {
    const { base } = await tempWorkspace();
    await plantLock(base, { pid: process.pid, host: 'some-container', nonce: 'old', acquiredAt: '' }, 5_000);
    expect(await withLock(base, async () => 'ran', { staleMs: 1_000, timeoutMs: 3_000 })).toBe('ran');
  });

  it('a lock without owner.json (crash right after mkdir) expires by age', async () => {
    const { base } = await tempWorkspace();
    await plantLock(base, null, 5_000);
    expect(await withLock(base, async () => 'ran', { staleMs: 1_000, timeoutMs: 3_000 })).toBe('ran');
  });

  it('a live, fresh lock is respected: the waiter times out and leaves it in place', async () => {
    const { base } = await tempWorkspace();
    const lock = await plantLock(base, { pid: process.pid, host: os.hostname(), nonce: 'alive', acquiredAt: '' });
    await expect(withLock(base, async () => 'ran', { staleMs: 5_000, timeoutMs: 300 })).rejects.toThrow(/Timed out waiting for lock.*held by pid/);
    expect(JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8')).nonce).toBe('alive');
  });

  it('a fresh lock from another host is respected too (not broken before staleMs)', async () => {
    const { base } = await tempWorkspace();
    await plantLock(base, { pid: 999_999, host: 'some-container', nonce: 'remote', acquiredAt: '' });
    await expect(withLock(base, async () => 'ran', { staleMs: 5_000, timeoutMs: 300 })).rejects.toThrow(/Timed out/);
  });

  it('the heartbeat keeps a long-running holder from being judged stale', async () => {
    const { base } = await tempWorkspace();
    let inside = 0;
    let maxInside = 0;
    const job = (ms: number) =>
      withLock(
        base,
        async () => {
          maxInside = Math.max(maxInside, ++inside);
          await new Promise((r) => setTimeout(r, ms));
          inside--;
        },
        { staleMs: 150, timeoutMs: 5_000 },
      );
    // The first holder runs 4x longer than staleMs while the second one waits.
    await Promise.all([job(600), new Promise((r) => setTimeout(r, 30)).then(() => job(10))]);
    expect(maxInside).toBe(1);
  });

  it('releasing never deletes a lock that is no longer ours', async () => {
    const { base } = await tempWorkspace();
    const lock = path.join(base, LOCK_NAME);
    await withLock(base, async () => {
      // Simulate our lock having been (wrongly) replaced by another process.
      await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, host: os.hostname(), nonce: 'someone-else' }));
    });
    expect(JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8')).nonce).toBe('someone-else');
  });

  // Regression: breaking by rename-and-verify let a waiter with an old "stale" reading remove a lock
  // another waiter had just acquired (two holders at once). Many rounds make the race show up.
  it('many waiters breaking the same stale lock still get strict mutual exclusion', async () => {
    const { base } = await tempWorkspace();
    const pid = await deadPid();
    let inside = 0;
    let maxInside = 0;
    for (let round = 0; round < 25; round++) {
      await plantLock(base, { pid, host: os.hostname(), nonce: `dead-${round}`, acquiredAt: '' });
      await Promise.all(
        Array.from({ length: 16 }, () =>
          withLock(base, async () => {
            maxInside = Math.max(maxInside, ++inside);
            await new Promise((r) => setTimeout(r, 1));
            inside--;
          }),
        ),
      );
      expect(maxInside, `round ${round}`).toBe(1);
      expect((await readdir(base)).filter((f) => f.includes(LOCK_NAME))).toEqual([]);
    }
  }, 30_000);
});
