#!/usr/bin/env node
// Num checkout (src/ presente) roda o TypeScript via tsx, sempre atualizado;
// na imagem de produção (só dist/) usa o build.
import { existsSync } from 'node:fs';

const src = new URL('../src/cli/index.ts', import.meta.url);
if (existsSync(src)) {
  const { register } = await import('tsx/esm/api');
  register();
  await import(src.href);
} else {
  await import(new URL('../dist/cli/index.js', import.meta.url).href);
}
