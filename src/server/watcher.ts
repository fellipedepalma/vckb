import type { EventEmitter } from 'node:events';
import path from 'node:path';
import chokidar from 'chokidar';
import { TEMP_FILE_RE } from '../core/fs-utils.js';
import { SLUG_RE } from '../core/paths.js';

/**
 * Observa boards/ e emite "change" ({ project }) com debounce por projeto.
 * Pega tanto escritas da própria API quanto edições feitas por agentes direto nos .md.
 */
export function watchBoards(root: string, events: EventEmitter, debounceMs = 150) {
  const timers = new Map<string, NodeJS.Timeout>();
  const watcher = chokidar.watch(root, {
    ignoreInitial: true,
    depth: 3,
    followSymlinks: false,
    ignored: (p: string) => TEMP_FILE_RE.test(p) || p.includes('.vckb.lock'),
    awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 20 },
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
