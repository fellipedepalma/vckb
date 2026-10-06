import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { configDir, configuredBoardsDir, PACKAGE_ROOT, resolveBoardsDir } from '../src/core/paths.js';

/** Where the boards come from: --dir > VCKB_BOARDS_DIR > ~/.vckb/config.json > ./boards (never the real config here). */

const root = mkdtempSync(path.join(os.tmpdir(), 'vckb-config-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function configWith(content: string | null) {
  const dir = mkdtempSync(path.join(root, 'cfg-'));
  if (content !== null) writeFileSync(path.join(dir, 'config.json'), content);
  return { VCKB_CONFIG_DIR: dir };
}

describe('resolveBoardsDir order', () => {
  const fromConfig = path.join(root, 'from-config');
  const fromEnv = path.join(root, 'from-env');

  it('--dir wins over everything', () => {
    const env = { ...configWith(JSON.stringify({ boardsDir: fromConfig })), VCKB_BOARDS_DIR: fromEnv };
    expect(resolveBoardsDir('some/dir', env)).toBe(path.resolve(process.cwd(), 'some/dir'));
  });

  it('VCKB_BOARDS_DIR wins over the config file', () => {
    const env = { ...configWith(JSON.stringify({ boardsDir: fromConfig })), VCKB_BOARDS_DIR: fromEnv };
    expect(resolveBoardsDir(undefined, env)).toBe(fromEnv);
  });

  it('then the boardsDir of config.json', () => {
    expect(resolveBoardsDir(undefined, configWith(JSON.stringify({ boardsDir: fromConfig })))).toBe(fromConfig);
  });

  it('then ./boards in the install directory', () => {
    expect(resolveBoardsDir(undefined, configWith(null))).toBe(path.join(PACKAGE_ROOT, 'boards'));
    expect(resolveBoardsDir(undefined, configWith('{}'))).toBe(path.join(PACKAGE_ROOT, 'boards'));
    expect(resolveBoardsDir(undefined, configWith(JSON.stringify({ boardsDir: '' })))).toBe(path.join(PACKAGE_ROOT, 'boards'));
  });

  it('an empty VCKB_BOARDS_DIR does not count', () => {
    const env = { ...configWith(JSON.stringify({ boardsDir: fromConfig })), VCKB_BOARDS_DIR: '' };
    expect(resolveBoardsDir(undefined, env)).toBe(fromConfig);
  });

  it('a relative boardsDir counts from the config folder, not from the cwd or the install', () => {
    const env = configWith(JSON.stringify({ boardsDir: '../elsewhere' }));
    expect(resolveBoardsDir(undefined, env)).toBe(path.resolve(env.VCKB_CONFIG_DIR, '../elsewhere'));
  });
});

describe('the config file', () => {
  it('lives in ~/.vckb unless VCKB_CONFIG_DIR says otherwise', () => {
    expect(configDir({})).toBe(path.join(os.homedir(), '.vckb'));
    expect(configDir({ VCKB_CONFIG_DIR: root })).toBe(root);
  });

  it('a file that is not JSON, or a boardsDir that is not text, is an error that names the file', () => {
    const bad = configWith('{ nope');
    expect(() => configuredBoardsDir(bad)).toThrow(/config\.json is not valid JSON/);
    expect(() => resolveBoardsDir(undefined, bad)).toThrow(/not valid JSON/);
    expect(() => configuredBoardsDir(configWith(JSON.stringify({ boardsDir: 5 })))).toThrow(/"boardsDir".*must be a text/);
  });

  it('the test setup keeps the real config out of every test', () => {
    expect(process.env.VCKB_CONFIG_DIR).toBeTruthy();
    expect(path.resolve(process.env.VCKB_CONFIG_DIR!)).not.toBe(path.join(os.homedir(), '.vckb'));
    mkdirSync(root, { recursive: true });
    expect(configuredBoardsDir()).toBeNull();
  });
});
