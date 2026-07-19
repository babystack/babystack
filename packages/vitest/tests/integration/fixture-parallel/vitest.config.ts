import { defineConfig } from 'vitest/config'

// Force real parallelism: four files, up to four forked workers, each with its own process + process.env.
export default defineConfig({
  test: {
    include: ['*.test.ts'],
    pool: 'forks', // per-worker DB keyed by VITEST_POOL_ID (the isolation model)
    fileParallelism: true,
    maxWorkers: 4,
    globalSetup: ['@babystack/vitest/global-setup'],
    setupFiles: ['@babystack/vitest/setup'],
    testTimeout: 240_000,
    hookTimeout: 240_000,
  },
})
