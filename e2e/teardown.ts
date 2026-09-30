import { rmSync } from 'node:fs';

export default function teardown() {
  const dir = process.env.E2E_BOARDS;
  if (dir && /vckb-e2e-/.test(dir)) rmSync(dir, { recursive: true, force: true });
}
