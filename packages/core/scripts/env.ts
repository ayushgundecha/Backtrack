/** CLIs read the repository's .env when there is one (Node's built-in loader; no dependency). */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const file = resolve(import.meta.dirname, '../../../.env');
if (existsSync(file)) process.loadEnvFile(file);

export const tenantFromArgs = (argv: string[]): string => {
  const i = argv.indexOf('--tenant');
  return (i >= 0 ? argv[i + 1] : undefined) ?? process.env.BACKTRACK_TENANT ?? 'demo';
};
