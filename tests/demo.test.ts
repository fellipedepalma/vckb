import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PACKAGE_ROOT } from '../src/core/paths.js';

/**
 * `npm run demo` (scripts/demo.mjs) end to end, in a temp VCKB_DEMO_DIR (never the real .demo/),
 * on a free port and with --no-open. Each start runs a full build, so this is slow.
 */

const REAL_DEMO = path.join(PACKAGE_ROOT, '.demo');
const realDemoBefore = existsSync(REAL_DEMO) ? statSync(REAL_DEMO).mtimeMs : null;
const dir = mkdtempSync(path.join(tmpdir(), 'vckb-demo-test-'));
const started: ChildProcess[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

const portIsFree = (port: number) =>
  new Promise<boolean>((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function startDemo(port: number) {
  let output = '';
  const child = spawn(process.execPath, ['scripts/demo.mjs', '--no-open'], {
    cwd: PACKAGE_ROOT,
    env: { ...process.env, VCKB_DEMO_DIR: dir, VCKB_DEMO_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  started.push(child);
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`demo exited (${child.exitCode}):\n${output}`);
    // Ready for the owner = the server answers AND the banner (URL, token) has been printed.
    try {
      if ((await fetch(`http://127.0.0.1:${port}/`)).status === 200 && output.includes('VCKB demo is running')) break;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  const serverPid = Number(readFileSync(path.join(dir, 'server.pid'), 'utf8'));
  return { child, serverPid, output: () => output };
}

/** Stops the demo by the PIDs it started (script and server), then waits for the port. */
async function stopDemo(demo: { child: ChildProcess; serverPid: number }, port: number) {
  demo.child.kill();
  if (pidAlive(demo.serverPid)) process.kill(demo.serverPid);
  for (let i = 0; i < 40 && (!(await portIsFree(port)) || pidAlive(demo.serverPid)); i++) await sleep(100);
  expect(pidAlive(demo.serverPid), 'server PID gone').toBe(false);
  expect(await portIsFree(port), `port ${port} free`).toBe(true);
}

afterAll(async () => {
  // Even if the test failed half-way: stop what this test started (script and server PIDs).
  for (const c of started) if (c.exitCode === null) c.kill();
  const pidFile = path.join(dir, 'server.pid');
  const serverPid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : 0;
  if (serverPid && pidAlive(serverPid)) process.kill(serverPid);
  for (let i = 0; i < 40 && serverPid && pidAlive(serverPid); i++) await sleep(100);
  // Removes the node_modules junction, not its target. Retries: Windows may hold files briefly.
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  expect(existsSync(path.join(PACKAGE_ROOT, 'node_modules', 'hono')), 'repo node_modules untouched').toBe(true);
});

describe('npm run demo', () => {
  it('builds, serves the UI, needs the token, reuses it on the next start and logs', { timeout: 300_000 }, async () => {
    const port = await freePort();

    const first = await startDemo(port);
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
    const token = readFileSync(path.join(dir, 'token'), 'utf8').trim();
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(first.output()).toContain(token); // printed for the owner
    expect(first.output()).toContain('Close this window or press Ctrl+C to stop.');
    expect((await fetch(`http://127.0.0.1:${port}/api/projects`)).status).toBe(401);
    const withToken = await fetch(`http://127.0.0.1:${port}/api/projects`, { headers: { Authorization: `Bearer ${token}` } });
    expect(withToken.status).toBe(200);
    expect(((await withToken.json()) as { slug: string }[]).map((p) => p.slug)).toEqual(['example']);
    expect(existsSync(path.join(dir, 'app', 'dist', 'server', 'index.js'))).toBe(true); // frozen copy
    await stopDemo(first, port);

    const second = await startDemo(port);
    expect(readFileSync(path.join(dir, 'token'), 'utf8').trim()).toBe(token); // reused
    const again = await fetch(`http://127.0.0.1:${port}/api/projects`, { headers: { Authorization: `Bearer ${token}` } });
    expect(again.status).toBe(200);
    await stopDemo(second, port);

    const log = readFileSync(path.join(dir, 'server.log'), 'utf8').trim().split('\n');
    expect(log.length).toBeGreaterThan(5);
    expect(log.filter((l) => l.includes('[demo] ready on')).length).toBe(2);
    expect(log.some((l) => /^\d{4}-\d{2}-\d{2}T\S+ \[server\] \[vckb\] API at/.test(l))).toBe(true);

    // The real .demo/ was never touched.
    expect(existsSync(REAL_DEMO) ? statSync(REAL_DEMO).mtimeMs : null).toBe(realDemoBefore);
  });
});
