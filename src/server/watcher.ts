import type { EventEmitter } from 'node:events';
import path from 'node:path';
import chokidar from 'chokidar';
import { TEMP_FILE_RE } from '../core/fs-utils.js';
import { SLUG_RE } from '../core/paths.js';

/**
 * Watches the boards directory and emits "change" ({ project }) debounced per project.
 * Catches both the API's own writes and edits made by agents directly on the .md files.
 */
export function watchBoards(root: string, events: EventEmitter, debounceMs = 150) {
  const timers = new Map<string, NodeJS.Timeout>();
  const watcher = chokidar.watch(root, {
    ignoreInitial: true,
    depth: 3,
    followSymlinks: false,
    ignored: (p: string) => TEMP_FILE_RE.test(p) || p.includes('.vckb.lock'),
    // No awaitWriteFinish: when a file disappeared while chokidar waited for its size to settle,
    // neither "add" nor "unlink" was emitted and clients stayed stale. The debounce below already
    // coalesces bursts, VCKB's own writes are atomic renames, and a slow hand-written file keeps
    // emitting "change" until its last write, so the final refetch reads the final content.
  });

  watcher.on('all', (_event, file) => {
    const slug = path.relative(root, file).split(path.sep)[0];
    if (!slug || !SLUG_RE.test(slug)) return;
    clearTimeout(timers.get(slug));
    timers.set(
      slug,
      setTimeout(() => {
        timers.delete(slug);
        events.emit('change', { project: slug });
      }, debounceMs),
    );
  });

  return {
    close: async () => {
      for (const t of timers.values()) clearTimeout(t);
      await watcher.close();
    },
  };
}
