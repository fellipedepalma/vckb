import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli/run.js';
import { PACKAGE_ROOT, resolveBoardsDir } from '../src/core/paths.js';
import { watchBoards } from '../src/server/watcher.js';
import { tempWorkspace } from './helpers.js';

const saved = process.env.VCKB_BOARDS_DIR;
afterEach(() => {
  if (saved === undefined) delete process.env.VCKB_BOARDS_DIR;
  else process.env.VCKB_BOARDS_DIR = saved;
});

describe('VCKB_BOARDS_DIR', () => {
  it('resolve: padrão ./boards da instalação, env relativo à instalação, --dir relativo ao cwd', () => {
    expect(resolveBoardsDir(undefined, {})).toBe(path.join(PACKAGE_ROOT, 'boards'));
    expect(resolveBoardsDir(undefined, { VCKB_BOARDS_DIR: '../meus-boards' })).toBe(path.resolve(PACKAGE_ROOT, '../meus-boards'));
    const abs = path.resolve('/tmp/x/boards');
    expect(resolveBoardsDir(undefined, { VCKB_BOARDS_DIR: abs })).toBe(abs);
    expect(resolveBoardsDir('rel', { VCKB_BOARDS_DIR: abs })).toBe(path.resolve(process.cwd(), 'rel'));
  });

  it('CLI usa VCKB_BOARDS_DIR quando não há --dir', async () => {
    const { store, boards } = await tempWorkspace();
    await store.createProject({ name: 'Só no temp', slug: 'so-no-temp' });
    process.env.VCKB_BOARDS_DIR = boards;
    let out = '';
    const code = await run(['projects'], { out: (s) => (out += s), err: () => undefined });
    expect(code).toBe(0);
    expect(out).toBe('so-no-temp  —  Só no temp\n');
  });

  it('watcher observa o diretório configurado', async () => {
    const { store, boards } = await tempWorkspace();
    await store.createProject({ name: 'w', slug: 'w' });
    const events = new EventEmitter();
    const watcher = watchBoards(boards, events, 50);
    try {
      await new Promise((r) => setTimeout(r, 300)); // chokidar pronto
      const got = new Promise<{ project: string }>((resolve) => events.once('change', resolve));
      await store.createTask('w', { title: 'mudança' });
      await expect(got).resolves.toEqual({ project: 'w' });
    } finally {
      await watcher.close();
    }
  });

  it('servidor real (subprocesso) serve os boards de VCKB_BOARDS_DIR', async () => {
    const { store, boards } = await tempWorkspace();
    await store.createProject({ name: 'Temp', slug: 'temp-srv' });
    const token = 'subprocess-token-0123456789';
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, VCKB_BOARDS_DIR: boards, VCKB_TOKEN: token, VCKB_PORT: '0', VCKB_HOST: '127.0.0.1' },
    });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let buf = '';
        child.stdout.on('data', (d) => {
          buf += d;
          const m = /API em (http:\/\/127\.0\.0\.1:\d+)\/api\s+\(boards: (.+)\)/.exec(buf);
          if (m) {
            expect(m[2]).toBe(boards);
            resolve(m[1]);
          }
        });
        child.stderr.on('data', (d) => (buf += d));
        child.on('exit', (c) => reject(new Error(`servidor saiu (${c}): ${buf}`)));
      });
      const res = await fetch(`${url}/api/projects`, { headers: { Authorization: `Bearer ${token}` } });
      expect((await res.json()).map((p: { slug: string }) => p.slug)).toEqual(['temp-srv']);
    } finally {
      child.kill();
    }
  }, 20_000);
});
