import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { serve } from '@hono/node-server';
import { loadEnv } from '../core/env.js';
import { resolveBoardsDir } from '../core/paths.js';
import { BoardStore } from '../core/store.js';
import { createApp } from './app.js';
import { readServerConfig } from './config.js';
import { watchBoards } from './watcher.js';

loadEnv();

const { config, errors, warnings } = readServerConfig(process.env);
for (const e of errors) console.error(`[vckb] ${e}`);
if (errors.length) process.exit(1);
for (const w of warnings) console.warn(`[vckb] warning: ${w}`);
const { token, host, port, corsOrigins } = config;
const boardsDir = resolveBoardsDir();

await fs.mkdir(boardsDir, { recursive: true });

const events = new EventEmitter();
events.setMaxListeners(100);
const store = new BoardStore(boardsDir);
const app = createApp({ store, token, events, corsOrigins });
const watcher = watchBoards(boardsDir, events);

const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  console.log(`[vckb] API at http://${host}:${info.port}/api  (boards: ${boardsDir})`);
});

const shutdown = async () => {
  await watcher.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
