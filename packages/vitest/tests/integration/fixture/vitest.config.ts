import { defineConfig } from 'vitest/config'

// The consumer's-eye view — the whole babystack wiring is these two lines. Test code stays untouched.
export default defineConfig({
  test: {
    include: ['app.test.ts'],
    pool: 'forks', // per-worker DB keyed by VITEST_POOL_ID (the isolation model)
    globalSetup: ['@babystack/vitest/global-setup'],
    setupFiles: ['@babystack/vitest/setup'],
    testTimeout: 240_000,
    hookTimeout: 240_000,
  },
})
