import path from 'node:path';
import { config } from 'dotenv';
import { PACKAGE_ROOT } from './paths.js';

/**
 * Loads the .env from the VCKB install directory (not the cwd), so the CLI called inside
 * another project does not pick up that project's .env. Variables already set in the
 * environment take precedence.
 */
export function loadEnv(): void {
  config({ path: path.join(PACKAGE_ROOT, '.env'), quiet: true });
}
