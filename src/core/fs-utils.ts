import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Arquivos temporários/lock que o watcher e as listagens devem ignorar. */
export const TEMP_FILE_RE = /\.tmp-[a-z0-9]+$|\.vckb\.lock$/i;

/**
 * Escrita atômica: grava em arquivo temporário no mesmo diretório e renomeia.
 * No Windows o rename pode falhar com EPERM/EBUSY se outro processo (antivírus,
 * editor, watcher) estiver com o arquivo aberto; tentamos algumas vezes.
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
 * Lock simples entre processos (servidor, CLI, agentes) usando mkdir, que é atômico.
 * Serializa as escritas de um board para não perder atualizações nem duplicar IDs.
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
        throw new Error(`Timeout aguardando lock em ${lock}`);
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
