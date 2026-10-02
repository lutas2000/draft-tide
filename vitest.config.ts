import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
    // Native SQLite and real child processes: separate processes, not threads.
    pool: 'forks',
    // Engine and Git integration tests spawn many processes; on GitHub's
    // Windows runners that runs 2–3× slower from one run to the next. A
    // longer limit there keeps a slow machine from failing a correct test
    // (a hang still fails); elsewhere 20 s still catches real slowdowns.
    testTimeout: process.platform === 'win32' ? 60_000 : 20_000,
    hookTimeout: process.platform === 'win32' ? 90_000 : 30_000,
  },
});
