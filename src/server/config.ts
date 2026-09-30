import { defaultAllowedHosts } from './auth.js';

export interface ServerConfig {
  token: string;
  host: string;
  port: number;
  corsOrigins: string[];
  /** Host names accepted in the Host header (VCKB_ALLOWED_HOSTS + loopback + bind address). */
  allowedHosts: string[];
  /** Extra origins accepted by the CSRF check (VCKB_ALLOWED_ORIGINS). */
  allowedOrigins: string[];
  /** Trust X-Forwarded-Proto/For (VCKB_TRUST_PROXY=true). */
  trustProxy: boolean;
}

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8787;

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Reads the server settings from the environment. Returns the problems that must stop the server
 * (`errors`) and the ones worth a warning.
 */
export function readServerConfig(env: NodeJS.ProcessEnv): { config: ServerConfig; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  const token = env.VCKB_TOKEN ?? '';
  if (token.length < 16) errors.push('Set VCKB_TOKEN (min. 16 characters) in .env. See .env.example.');

  const host = env.VCKB_HOST?.trim() || DEFAULT_HOST;
  const rawPort = env.VCKB_PORT?.trim() || String(DEFAULT_PORT);
  const port = Number(rawPort);
  // 0 = any free port chosen by the OS (used by tests).
  if (!/^\d+$/.test(rawPort) || port > 65_535) errors.push(`VCKB_PORT must be a port number (0-65535), got ${JSON.stringify(rawPort)}.`);

  // Inside the container 0.0.0.0 is required (Docker publishes the port on a host IP of your
  // choice); anywhere else it exposes the API to the whole network.
  if (!LOOPBACK.has(host) && env.VCKB_IN_CONTAINER !== '1') {
    warnings.push(`Listening on ${host}: the API is reachable from other machines on that network. Keep VCKB_HOST=127.0.0.1 unless you mean it.`);
  }

  const list = (v: string | undefined) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  const corsOrigins = list(env.VCKB_CORS_ORIGINS);
  const allowedHosts = defaultAllowedHosts(host, list(env.VCKB_ALLOWED_HOSTS));
  const allowedOrigins: string[] = [];
  for (const o of list(env.VCKB_ALLOWED_ORIGINS)) {
    try {
      const { origin } = new URL(o);
      if (origin === 'null') throw new Error();
      allowedOrigins.push(origin);
    } catch {
      errors.push(`VCKB_ALLOWED_ORIGINS: ${JSON.stringify(o)} is not an origin (e.g. https://vckb.example.ts.net).`);
    }
  }
  const trustProxy = env.VCKB_TRUST_PROXY?.trim().toLowerCase() === 'true';

  return { config: { token, host, port, corsOrigins, allowedHosts, allowedOrigins, trustProxy }, errors, warnings };
}
