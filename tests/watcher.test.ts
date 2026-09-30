import { EventEmitter } from 'node:events';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { watchBoards } from '../src/server/watcher.js';
import { tempWorkspace } from './helpers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function watched() {
  const ws = await tempWorkspace();
  await ws.store.createProject({ name: 'App', slug: 'app' });
  const events = new EventEmitter();
  const seen: { at: number; project: string }[] = [];
  events.on('change', (e: { project: string }) => seen.push({ at: Date.now(), project: e.project }));
  const watcher = watchBoards(ws.boards, events, 50);
  await sleep(500); // let chokidar finish its initial scan
  return { ...ws, seen, watcher, tasks: path.join(ws.boards, 'app', 'tasks') };
}

describe('watcher', () => {
  it('emits a change for a file written by hand', async () => {
    const { seen, watcher, tasks } = await watched();
    try {
      await writeFile(path.join(tasks, 'T-001-x.md'), '---\ntitle: x\n---\n');
      await expect.poll(() => seen.length, { timeout: 3_000 }).toBeGreaterThan(0);
      expect(seen[0].project).toBe('app');
    } finally {
      await watcher.close();
    }
  });

  // Regression: with awaitWriteFinish, a file removed while chokidar was still waiting for its size
  // to settle produced neither "add" nor "unlink", so the UI kept showing a task that no longer existed.
  it('a file created and deleted right away still produces a change after the delete', async () => {
    const { seen, watcher, tasks } = await watched();
    try {
      const file = path.join(tasks, 'T-002-flash.md');
      await writeFile(file, '---\ntitle: flash\n---\n');
      await sleep(30);
      const deletedAt = Date.now();
      await rm(file);
      await expect.poll(() => seen.filter((e) => e.at >= deletedAt).length, { timeout: 3_000 }).toBeGreaterThan(0);
    } finally {
      await watcher.close();
    }
  });
});
