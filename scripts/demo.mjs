#!/usr/bin/env node
// `npm run demo`: a local, disposable VCKB to try out (Windows: double-click VCKB-demo.bat).
//
// .demo/ (or $VCKB_DEMO_DIR, used by tests) holds:
//   boards/      a copy of boards/example, made once; your changes persist (--reset starts over)
//   token        a random token made once and reused, so the browser session survives restarts
//   app/dist     a frozen copy of the build: later builds in the repo don't touch a running demo
//   server.log   server output, appended with timestamps
// Flags: --reset (new copy of the example board), --no-open (don't open the browser).
//
// `npm run start:local` (Windows: double-click VCKB-start.bat) is the same script with --local: the
// real thing. Everything lives in ~/.vckb (or $VCKB_CONFIG_DIR, used by tests): server.log, app/ (the
// frozen build) and `token` (made once, never in the repo). The boards are the ones that
// resolveBoardsDir() finds (VCKB_BOARDS_DIR or boardsDir in ~/.vckb/config.json); nothing is copied
// and there is no reset. It refuses to start without a configured boards folder.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const LOCAL = args.has('--local');
const TAG = LOCAL ? 'start' : 'demo';
const DEMO = LOCAL
  ? path.resolve(process.env.VCKB_CONFIG_DIR || path.join(os.homedir(), '.vckb'))
  : path.resolve(process.env.VCKB_DEMO_DIR || path.join(ROOT, '.demo'));
const reset = args.has('--reset');
const open = !args.has('--no-open');
const HOST = '127.0.0.1';
const isWin = process.platform === 'win32';

const paths = {
  boards: path.join(DEMO, 'boards'),
  token: path.join(DEMO, 'token'),
  log: path.join(DEMO, 'server.log'),
  pid: path.join(DEMO, 'server.pid'),
  app: path.join(DEMO, 'app'),
};

const stamp = () => new Date().toISOString();
mkdirSync(DEMO, { recursive: true });
const log = createWriteStream(paths.log, { flags: 'a' });
const note = (line) => {
  console.log(line);
  log.write(`${stamp()} [${TAG}] ${line}\n`);
};

function fail(message, code = 1) {
  console.error(`\n[${TAG}] ${message}`);
  log.write(`${stamp()} [${TAG}] ERROR ${message}\n`);
  return waitForKey().then(() => process.exit(code));
}

/** On an interactive console, keep the window open so the error can be read. */
function waitForKey() {
  if (!process.stdin.isTTY) return Promise.resolve();
  console.log('\nPress any key to close.');
  return new Promise((resolve) => {
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.once('data', () => resolve());
  });
}

// ------------------------------------------------------------------ data

if (LOCAL && reset) console.error('--reset is only for the demo; ignored.');
if (!LOCAL && reset && existsSync(paths.boards)) {
  rmSync(paths.boards, { recursive: true, force: true });
  note('--reset: boards recreated from boards/example');
}
if (!LOCAL && !existsSync(paths.boards)) {
  cpSync(path.join(ROOT, 'boards', 'example'), path.join(paths.boards, 'example'), { recursive: true });
}

let token = existsSync(paths.token) ? readFileSync(paths.token, 'utf8').trim() : '';
if (!/^[0-9a-f]{48}$/.test(token)) {
  token = randomBytes(24).toString('hex');
  writeFileSync(paths.token, `${token}\n`, { mode: 0o600 });
}

// ------------------------------------------------------------------ build + frozen copy

note('Building (npm run build)…');
const build = spawnSync(isWin ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit', shell: isWin });
if (build.status !== 0) await fail(`npm run build failed (exit ${build.status}). Run "npm ci" and try again.`, build.status || 1);

if (LOCAL) {
  // After the build, so the compiled resolveBoardsDir is the one the server will use.
  const { resolveBoardsDir } = await import(pathToFileURL(path.join(ROOT, 'dist', 'core', 'paths.js')).href);
  paths.boards = resolveBoardsDir(undefined, process.env);
  if (paths.boards === path.join(ROOT, 'boards')) {
    await fail(
      `No boards folder is configured. Create ${path.join(DEMO, 'config.json')} with {"boardsDir": "<your boards folder>"} ` +
        'or set VCKB_BOARDS_DIR. (The boards inside the repository are only an example.)',
    );
  }
  mkdirSync(paths.boards, { recursive: true });
  note(`Boards folder: ${paths.boards}`);
}

rmSync(path.join(paths.app, 'dist'), { recursive: true, force: true });
mkdirSync(paths.app, { recursive: true });
cpSync(path.join(ROOT, 'dist'), path.join(paths.app, 'dist'), { recursive: true });
// package.json makes the copy an ES module package; node_modules points at the repo's (junction on
// Windows, so no admin rights are needed). The copy has no .env: the demo never reads yours.
cpSync(path.join(ROOT, 'package.json'), path.join(paths.app, 'package.json'));
if (!existsSync(path.join(paths.app, 'node_modules'))) {
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(paths.app, 'node_modules'), isWin ? 'junction' : 'dir');
}

// ------------------------------------------------------------------ port

const portIsFree = (port) =>
  new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, HOST, () => srv.close(() => resolve(true)));
  });

const basePort = Number(process.env.VCKB_DEMO_PORT || 8787);
let port = null;
for (let p = basePort; p <= basePort + 10; p++) {
  if (await portIsFree(p)) {
    port = p;
    break;
  }
}
if (port === null) await fail(`Ports ${basePort}-${basePort + 10} are all in use. Set VCKB_DEMO_PORT to another port.`);
if (port !== basePort) note(`Port ${basePort} is in use; using ${port}.`);

// ------------------------------------------------------------------ server

const url = `http://${HOST}:${port}/`;
log.write(`${stamp()} [${TAG}] ===== starting on ${url} (boards: ${paths.boards}) =====\n`);
const server = spawn(process.execPath, [path.join(paths.app, 'dist', 'server', 'index.js')], {
  cwd: paths.app,
  env: { ...process.env, VCKB_HOST: HOST, VCKB_PORT: String(port), VCKB_BOARDS_DIR: paths.boards, VCKB_TOKEN: token },
  stdio: ['ignore', 'pipe', 'pipe'],
});
writeFileSync(paths.pid, `${server.pid}\n`);

const pipe = (stream, out, tag) => {
  let rest = '';
  stream.on('data', (chunk) => {
    out.write(chunk);
    const lines = (rest + chunk).split(/\r?\n/);
    rest = lines.pop() ?? '';
    for (const line of lines) log.write(`${stamp()} [${tag}] ${line}\n`);
  });
};
pipe(server.stdout, process.stdout, 'server');
pipe(server.stderr, process.stderr, 'server:err');

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  note('Stopping the demo server…');
  if (server.exitCode === null) server.kill();
  setTimeout(() => process.exit(0), 3_000).unref();
};
process.on('SIGINT', stop); // Ctrl+C
process.on('SIGTERM', stop);
process.on('SIGHUP', stop); // console window closed (Windows) / terminal hung up

server.on('exit', async (code, signal) => {
  log.write(`${stamp()} [${TAG}] server exited (code ${code}${signal ? `, signal ${signal}` : ''})\n`);
  if (stopping) {
    log.end(() => process.exit(0));
    return;
  }
  console.error(`\n[${TAG}] The server stopped (exit code ${code ?? signal}). Last 20 lines of ${paths.log}:\n`);
  await new Promise((r) => log.end(r));
  const tail = readFileSync(paths.log, 'utf8').trimEnd().split('\n').slice(-20).join('\n');
  console.error(tail);
  await waitForKey();
  process.exit(code || 1);
});

// Wait until it answers, then show where it is.
let up = false;
for (let i = 0; i < 100 && server.exitCode === null && !up; i++) {
  try {
    up = (await fetch(url)).ok;
  } catch {
    await new Promise((r) => setTimeout(r, 200));
  }
}
if (up) {
  const bar = '='.repeat(72);
  console.log(
    `\n${bar}\n  ${LOCAL ? 'VCKB' : 'VCKB demo'} is running\n\n` +
      `  URL:      ${url}\n` +
      `  Token:    ${token}   (paste it on the sign-in screen)\n` +
      `  Boards:   ${paths.boards}\n` +
      `  Log:      ${paths.log}\n\n` +
      (LOCAL
        ? `  The token is kept in ${paths.token}; it only works on ${HOST}.\n`
        : `  The token is local and disposable: it only works for this demo on ${HOST}.\n`) +
      `  Close this window or press Ctrl+C to stop.\n${bar}\n`,
  );
  log.write(`${stamp()} [${TAG}] ready on ${url} (server pid ${server.pid})\n`);
  if (open) {
    const opener = isWin ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(opener[0], opener[1], { stdio: 'ignore', detached: true, windowsVerbatimArguments: isWin }).on('error', () => undefined).unref();
  }
}
