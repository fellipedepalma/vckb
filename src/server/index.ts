import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { serve } from '@hono/node-server';
import { loadEnv } from '../core/env.js';
import { resolveBoardsDir } from '../core/paths.js';
import { BoardStore } from '../core/store.js';
import { createApp } from './app.js';
import { watchBoards } from './watcher.js';

loadEnv();

const token = process.env.VCKB_TOKEN ?? '';
if (token.length < 16) {
  console.error('[vckb] Defina VCKB_TOKEN (mínimo 16 caracteres) no .env. Veja .env.example.');
  process.exit(1);
}

const host = process.env.VCKB_HOST || '127.0.0.1';
const port = Number(process.env.VCKB_PORT || 8787);
const corsOrigins = (process.env.VCKB_CORS_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const boardsDir = resolveBoardsDir();

await fs.mkdir(boardsDir, { recursive: true });

const events = new EventEmitter();
events.setMaxListeners(100);
const store = new BoardStore(boardsDir);
const app = createApp({ store, token, events, corsOrigins });
const watcher = watchBoards(boardsDir, events);

const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  console.log(`[vckb] API em http://${host}:${info.port}/api  (boards: ${boardsDir})`);
});

const shutdown = async () => {
  await watcher.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
