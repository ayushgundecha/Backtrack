import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  // Route tests share one FalkorDB tenant graph; run files one at a time like core does.
  test: { include: ['test/**/*.test.ts'], fileParallelism: false },
});
