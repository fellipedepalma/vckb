import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VckbError } from './errors.js';

/** Slug de projeto: minúsculas, dígitos e hífen; sem começar/terminar com hífen. */
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
/** ID de tarefa canônico: T-001, T-042, T-1234. */
export const TASK_ID_RE = /^T-\d{3,6}$/;
/** Nome de coluna: mesmo alfabeto do slug, até 32 caracteres. */
export const COLUMN_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/** Raiz do pacote (funciona tanto em src/ via tsx quanto em dist/ compilado). */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function resolveBoardsDir(override?: string): string {
  const dir = override ?? process.env.VCKB_BOARDS_DIR ?? path.join(PACKAGE_ROOT, 'boards');
  return path.resolve(dir);
}

/** Nomes de dispositivo do Windows: não podem virar pasta (con, nul, com1...). */
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com\d|lpt\d)$/;

export function assertSlug(slug: unknown): string {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug) || WINDOWS_RESERVED_RE.test(slug)) {
    throw new VckbError('INVALID', `Slug de projeto inválido: ${JSON.stringify(slug)} (use a-z, 0-9 e hífen)`);
  }
  return slug;
}

/** Aceita "T-1", "t-001", "T-0042" e devolve a forma canônica (mínimo 3 dígitos). */
export function normalizeTaskId(id: unknown): string {
  const m = typeof id === 'string' ? /^T-(\d{1,6})$/i.exec(id.trim()) : null;
  if (!m) throw new VckbError('INVALID', `ID de tarefa inválido: ${JSON.stringify(id)} (formato: T-001)`);
  return formatTaskId(Number(m[1]));
}

export function formatTaskId(n: number): string {
  return `T-${String(n).padStart(3, '0')}`;
}

/**
 * Junta caminhos garantindo que o resultado continua dentro de `base`.
 * Defesa em profundidade: slugs/IDs já são validados por regex antes de chegar aqui.
 */
export function safeJoin(base: string, ...parts: string[]): string {
  const root = path.resolve(base);
  const target = path.resolve(root, ...parts);
  const rel = path.relative(root, target);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new VckbError('INVALID', 'Caminho fora do diretório de boards');
  }
  return target;
}
