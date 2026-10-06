import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PACKAGE_ROOT } from '../src/core/paths.js';
import { BoardStore } from '../src/core/store.js';

/**
 * `npm run start:local` (scripts/demo.mjs --local) end to end, with a temp VCKB_CONFIG_DIR and a temp
 * boards folder: it must never touch the real ~/.vckb, the repository's .demo/ or boards/. Each start
 * runs a full build, so this is slow.
 */

const REAL_CONFIG = path.join(os.homedir(), '.vckb');
const realBefore = existsSync(REAL_CONFIG) ? statSync(REAL_CONFIG).mtimeMs : null;
const root = mkdtempSync(path.join(os.tmpdir(), 'vckb-start-local-test-'));
const started: ChildProcess[] = [];
const pidFiles: string[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
const portIsFree = (port: number) =>
  new Promise<boolean>((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });

function start(configDir: string, port: number, extraEnv: Record<string, string> = {}) {
  let output = '';
  const child = spawn(process.execPath, ['scripts/demo.mjs', '--local', '--no-open'], {
    cwd: PACKAGE_ROOT,
    env: { ...process.env, VCKB_CONFIG_DIR: configDir, VCKB_DEMO_PORT: String(port), VCKB_BOARDS_DIR: '', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  started.push(child);
  pidFiles.push(path.join(configDir, 'server.pid'));
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  return { child, output: () => output };
}

async function waitReady(run: { child: ChildProcess; output: () => string }, port: number) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (run.child.exitCode !== null) throw new Error(`exited (${run.child.exitCode}):\n${run.output()}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/`)).status === 200 && run.output().includes('VCKB is running')) return;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  throw new Error(`not ready:\n${run.output()}`);
}

async function stop(run: { child: ChildProcess }, configDir: string, port: number) {
  run.child.kill();
  const pidFile = path.join(configDir, 'server.pid');
  const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : 0;
  if (pid && pidAlive(pid)) process.kill(pid);
  for (let i = 0; i < 40 && (!(await portIsFree(port)) || (pid && pidAlive(pid))); i++) await sleep(100);
  expect(await portIsFree(port), `port ${port} free`).toBe(true);
}

afterAll(async () => {
  for (const c of started) if (c.exitCode === null) c.kill();
  for (const f of pidFiles) {
    const pid = existsSync(f) ? Number(readFileSync(f, 'utf8')) : 0;
    if (pid && pidAlive(pid)) process.kill(pid);
    for (let i = 0; i < 40 && pid && pidAlive(pid); i++) await sleep(100);
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  expect(existsSync(path.join(PACKAGE_ROOT, 'node_modules', 'hono')), 'repo node_modules untouched').toBe(true);
});

describe('npm run start:local', () => {
  it('serves the boards of config.json with a persistent token, and touches nothing else', { timeout: 300_000 }, async () => {
    const configDir = path.join(root, 'config');
    const boards = path.join(root, 'my-boards');
    await new BoardStore(boards).createProject({ name: 'Mine', slug: 'mine' });
    await new BoardStore(boards).createProject({ name: 'Other', slug: 'other' });
    const { mkdirSync } = await import('node:fs');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ boardsDir: boards }));
    const demoBefore = existsSync(path.join(PACKAGE_ROOT, '.demo')) ? statSync(path.join(PACKAGE_ROOT, '.demo')).mtimeMs : null;

    const port = await freePort();
    const first = start(configDir, port);
    await waitReady(first, port);
    const token = readFileSync(path.join(configDir, 'token'), 'utf8').trim();
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(first.output()).toContain(token);
    expect(first.output()).toContain('VCKB is running');
    expect(first.output()).not.toContain('VCKB demo');
    expect(first.output()).toContain(boards);
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/api/projects`)).status).toBe(401);
    const res = await fetch(`http://127.0.0.1:${port}/api/projects`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { slug: string }[]).map((p) => p.slug).sort()).toEqual(['mine', 'other']); // not "example"
    await stop(first, configDir, port);

    // The same token on the next start.
    const second = start(configDir, port);
    await waitReady(second, port);
    expect(readFileSync(path.join(configDir, 'token'), 'utf8').trim()).toBe(token);
    expect((await fetch(`http://127.0.0.1:${port}/api/projects`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
    await stop(second, configDir, port);

    const log = readFileSync(path.join(configDir, 'server.log'), 'utf8');
    expect(log).toContain('[start] ready on');
    expect(existsSync(path.join(boards, 'example'))).toBe(false); // the example was not copied in
    expect(existsSync(path.join(PACKAGE_ROOT, '.demo')) ? statSync(path.join(PACKAGE_ROOT, '.demo')).mtimeMs : null).toBe(demoBefore);
    expect(existsSync(REAL_CONFIG) ? statSync(REAL_CONFIG).mtimeMs : null).toBe(realBefore);
  });

  it('refuses to start without a boards folder, and says how to configure it', { timeout: 240_000 }, async () => {
    const configDir = path.join(root, 'empty-config');
    const run = start(configDir, await freePort());
    const code = await new Promise<number | null>((resolve) => run.child.once('exit', resolve));
    expect(code).not.toBe(0);
    expect(run.output()).toContain('No boards folder is configured');
    expect(run.output()).toContain('config.json');
    expect(existsSync(path.join(PACKAGE_ROOT, 'boards', 'example'))).toBe(true); // the repo's example is untouched
  });
});
