import { defineConfig } from 'vitest/config';

// Electron GUI end-to-end tests. Run with `pnpm --filter @draft-tide/desktop
// test:e2e`, which builds the e2e variant first (dist-e2e/, debugging switches
// allowed for Playwright; never shipped).
export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.ts'],
    environment: 'node',
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
