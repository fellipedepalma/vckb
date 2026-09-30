import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import { BoardStore } from '../src/core/store.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** Isolated temp dir per test; `boards` lives inside it (leaving room "outside" to check traversal). */
export async function tempWorkspace() {
  const base = await mkdtemp(path.join(tmpdir(), 'vckb-test-'));
  dirs.push(base);
  const boards = path.join(base, 'boards');
  const store = new BoardStore(boards, { now: () => new Date(2026, 8, 30, 12) });
  return { base, boards, store };
}
