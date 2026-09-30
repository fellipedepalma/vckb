import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Context } from 'hono';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/**
 * Serves the built web UI (dist/web) with an SPA fallback: a GET for a path without a file
 * extension that doesn't exist returns index.html, so client-side routes survive a reload.
 * Paths are decoded and must stay inside `root`; dotfiles and unknown file types are never served.
 * Hashed files under /assets/ are cached for a year; index.html is revalidated every time.
 */
export function serveWeb(root: string) {
  const base = path.resolve(root);
  const index = path.join(base, 'index.html');

  const send = async (c: Context, file: string, cache: string) => {
    const type = TYPES[path.extname(file).toLowerCase()];
    if (!type) return null;
    let data: Buffer;
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile()) return null;
      data = await fs.readFile(file);
    } catch {
      return null;
    }
    c.header('Content-Type', type);
    c.header('Cache-Control', cache);
    return c.body(new Uint8Array(data), 200); // Hono strips the body for HEAD
  };

  return async (c: Context) => {
    let rel: string;
    try {
      rel = decodeURIComponent(c.req.path);
    } catch {
      return c.json({ error: 'Not found' }, 404);
    }
    const parts = rel.split('/').filter(Boolean);
    const unsafe = rel.includes('\0') || rel.includes('\\') || parts.some((p) => p.startsWith('.'));
    if (!unsafe && parts.length) {
      const file = path.resolve(base, ...parts);
      if (file.startsWith(base + path.sep)) {
        const immutable = parts[0] === 'assets' ? 'public, max-age=31536000, immutable' : 'no-cache';
        const res = await send(c, file, immutable);
        if (res) return res;
      }
    }
    // Missing file with an extension (e.g. an old asset): a real 404, not the app shell.
    if (unsafe || path.extname(parts.at(-1) ?? '')) return c.json({ error: 'Not found' }, 404);
    return (await send(c, index, 'no-cache')) ?? c.json({ error: 'Web UI not built. Run: npm run build' }, 404);
  };
}
