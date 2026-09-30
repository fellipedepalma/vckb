import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { PACKAGE_ROOT } from '../src/core/paths.js';
import { readServerConfig } from '../src/server/config.js';

const TOKEN = 'x'.repeat(16);

describe('D: server bind configuration', () => {
  it('defaults to 127.0.0.1:8787 with no warnings', () => {
    const { config, errors, warnings } = readServerConfig({ VCKB_TOKEN: TOKEN });
    expect(config).toMatchObject({ host: '127.0.0.1', port: 8787, corsOrigins: [] });
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('warns when binding to a non-loopback address outside a container, not inside one', () => {
    expect(readServerConfig({ VCKB_TOKEN: TOKEN, VCKB_HOST: '0.0.0.0' }).warnings[0]).toMatch(/reachable from other machines/);
    expect(readServerConfig({ VCKB_TOKEN: TOKEN, VCKB_HOST: '0.0.0.0', VCKB_IN_CONTAINER: '1' }).warnings).toEqual([]);
  });

  it('refuses a short token and an invalid port', () => {
    expect(readServerConfig({ VCKB_TOKEN: 'short' }).errors[0]).toMatch(/VCKB_TOKEN/);
    expect(readServerConfig({ VCKB_TOKEN: TOKEN, VCKB_PORT: '0' }).errors).toEqual([]); // OS-assigned
    for (const p of ['-1', '65536', 'abc', '80x']) {
      expect(readServerConfig({ VCKB_TOKEN: TOKEN, VCKB_PORT: p }).errors, p).toHaveLength(1);
    }
  });
});

/** Resolves compose-style "${VAR:-default}" using an empty environment (what you get with no .env). */
const withDefaults = (s: string) => s.replace(/\$\{[A-Z_]+:-([^}]*)\}/g, '$1');

describe('D: Docker files (static checks; Docker is not needed)', () => {
  it('docker-compose.yml publishes on 127.0.0.1 by default, with a configurable IP', async () => {
    const compose = yaml.load(await readFile(path.join(PACKAGE_ROOT, 'docker-compose.yml'), 'utf8')) as {
      services: { vckb: Record<string, unknown> & { ports: string[]; environment: Record<string, string>; user: string } };
    };
    const svc = compose.services.vckb;
    expect(svc.ports).toHaveLength(1);
    expect(svc.ports[0]).toContain('${VCKB_BIND_IP:-127.0.0.1}');
    expect(withDefaults(svc.ports[0])).toBe('127.0.0.1:8787:8787');
    expect(svc.ports.join()).not.toMatch(/0\.0\.0\.0/);
    expect(svc.environment.VCKB_HOST).toBe('0.0.0.0'); // inside the container
  });

  it('the container runs as a non-root user by default and is hardened', async () => {
    const compose = yaml.load(await readFile(path.join(PACKAGE_ROOT, 'docker-compose.yml'), 'utf8')) as {
      services: { vckb: { user: string; read_only: boolean; cap_drop: string[]; security_opt: string[]; volumes: string[] } };
    };
    const svc = compose.services.vckb;
    const [uid, gid] = withDefaults(svc.user).split(':').map(Number);
    expect(uid).toBeGreaterThan(0);
    expect(gid).toBeGreaterThan(0);
    expect(svc.read_only).toBe(true);
    expect(svc.cap_drop).toEqual(['ALL']);
    expect(svc.security_opt).toContain('no-new-privileges:true');
    expect(svc.volumes.map(withDefaults)).toEqual(['./boards:/data']);
  });

  it('the Dockerfile ends as a numeric non-root USER, listens on 0.0.0.0 and gives /data to that user', async () => {
    const df = await readFile(path.join(PACKAGE_ROOT, 'Dockerfile'), 'utf8');
    const users = [...df.matchAll(/^USER\s+(\S+)/gm)].map((m) => m[1]);
    expect(users.at(-1)).toBe('1000:1000');
    expect(df).toMatch(/VCKB_HOST=0\.0\.0\.0/);
    expect(df).toMatch(/VCKB_IN_CONTAINER=1/);
    expect(df).toMatch(/chown 1000:1000 \/data/);
  });

  it('.dockerignore keeps secrets and data out of the build context', async () => {
    const ignore = (await readFile(path.join(PACKAGE_ROOT, '.dockerignore'), 'utf8')).split(/\r?\n/);
    for (const entry of ['.env', 'boards', 'node_modules', '.git']) expect(ignore).toContain(entry);
  });
});
