import { EventEmitter } from 'node:events';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { loadEnv } from '../core/env.js';
import { PACKAGE_ROOT, resolveBoardsDir } from '../core/paths.js';
import { BoardStore } from '../core/store.js';
import { createApp } from './app.js';
import { readServerConfig } from './config.js';
import { watchBoards } from './watcher.js';

loadEnv();

const { config, errors, warnings } = readServerConfig(process.env);
for (const e of errors) console.error(`[vckb] ${e}`);
if (errors.length) process.exit(1);
for (const w of warnings) console.warn(`[vckb] warning: ${w}`);
const { token, host, port, corsOrigins, allowedHosts, allowedOrigins, trustProxy } = config;
const boardsDir = resolveBoardsDir();

await fs.mkdir(boardsDir, { recursive: true });

const events = new EventEmitter();
events.setMaxListeners(100);
const store = new BoardStore(boardsDir);
// The built UI (npm run build) is served on the same origin when present.
const webDir = path.join(PACKAGE_ROOT, 'dist', 'web');
const webRoot = existsSync(path.join(webDir, 'index.html')) ? webDir : undefined;
const app = createApp({ store, token, events, corsOrigins, allowedHosts, allowedOrigins, trustProxy, webRoot });
const watcher = watchBoards(boardsDir, events);

const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  const url = `http://${host.includes(':') ? `[${host}]` : host}:${info.port}`;
  console.log(`[vckb] API at ${url}/api  (boards: ${boardsDir})`);
  console.log(webRoot ? `[vckb] Web UI at ${url}/` : '[vckb] Web UI not built (npm run build); serving the API only');
});

const shutdown = async () => {
  await watcher.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
