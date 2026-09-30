import path from 'node:path';
import { config } from 'dotenv';
import { PACKAGE_ROOT } from './paths.js';

/**
 * Carrega o .env da instalação do VCKB (não do cwd), para o CLI chamado dentro de
 * outro projeto não ler o .env daquele projeto. Variáveis já definidas no ambiente vencem.
 */
export function loadEnv(): void {
  config({ path: path.join(PACKAGE_ROOT, '.env'), quiet: true });
}
