import { EventEmitter } from 'node:events';
import { type AppOptions, createApp } from '../src/server/app.js';
import { tempWorkspace } from './helpers.js';

export const TOKEN = 'test-token-0123456789abcdef';

export async function apiSetup(opts: Partial<Omit<AppOptions, 'store' | 'events'>> = {}) {
  const ws = await tempWorkspace();
  const events = new EventEmitter();
  const app = createApp({ store: ws.store, token: TOKEN, events, sseHeartbeatMs: 50, ...opts });
  const req = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(url, {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
  return { ...ws, app, req, events };
}
