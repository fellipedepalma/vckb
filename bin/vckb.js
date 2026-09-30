#!/usr/bin/env node
// In a checkout (src/ present) run the TypeScript sources via tsx, always up to date;
// in the production image (dist/ only) use the build.
import { existsSync } from 'node:fs';

const src = new URL('../src/cli/index.ts', import.meta.url);
if (existsSync(src)) {
  const { register } = await import('tsx/esm/api');
  register();
  await import(src.href);
} else {
  await import(new URL('../dist/cli/index.js', import.meta.url).href);
}
