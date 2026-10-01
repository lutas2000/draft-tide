import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
    // Native SQLite and real child processes: separate processes, not threads.
    pool: 'forks',
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
