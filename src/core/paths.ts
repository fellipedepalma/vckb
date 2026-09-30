import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VckbError } from './errors.js';

/** Project slug: lowercase letters, digits and hyphens; no leading/trailing hyphen. */
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
/** Canonical task ID: T-001, T-042, T-1234. */
export const TASK_ID_RE = /^T-\d{3,6}$/;
/** Column name: same alphabet as slugs, up to 32 characters. */
export const COLUMN_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/** Package root (works both from src/ via tsx and from the compiled dist/). */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Data directory. Precedence: `--dir` (relative to cwd) > `VCKB_BOARDS_DIR` > `./boards`.
 * A relative VCKB_BOARDS_DIR is resolved from the VCKB install directory (not the cwd),
 * so the CLI finds the same boards from whatever project it is called in.
 */
export function resolveBoardsDir(override?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (override) return path.resolve(process.cwd(), override);
  return path.resolve(PACKAGE_ROOT, env.VCKB_BOARDS_DIR || './boards');
}

/** Windows device names cannot be used as folder names (con, nul, com1...). */
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com\d|lpt\d)$/;

export function assertSlug(slug: unknown): string {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug) || WINDOWS_RESERVED_RE.test(slug)) {
    throw new VckbError('INVALID', `Invalid project slug: ${JSON.stringify(slug)} (use a-z, 0-9 and hyphens)`);
  }
  return slug;
}

/** Accepts "T-1", "t-001", "T-0042" and returns the canonical form (at least 3 digits). */
export function normalizeTaskId(id: unknown): string {
  const m = typeof id === 'string' ? /^T-(\d{1,6})$/i.exec(id.trim()) : null;
  if (!m) throw new VckbError('INVALID', `Invalid task ID: ${JSON.stringify(id)} (format: T-001)`);
  return formatTaskId(Number(m[1]));
}

export function formatTaskId(n: number): string {
  return `T-${String(n).padStart(3, '0')}`;
}

/**
 * Joins paths making sure the result stays inside `base`.
 * Defense in depth: slugs/IDs are already validated by regex before reaching this point.
 */
export function safeJoin(base: string, ...parts: string[]): string {
  const root = path.resolve(base);
  const target = path.resolve(root, ...parts);
  const rel = path.relative(root, target);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new VckbError('INVALID', 'Path escapes the boards directory');
  }
  return target;
}
