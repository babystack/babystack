import { defineConfig } from 'vitest/config'

// The ENTIRE test-infra change for this app — three lines. No test file imports babystack or manages a DB.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['@babystack/vitest/global-setup'],
    setupFiles: ['@babystack/vitest/setup'],
    pool: 'forks', // per-worker DB keyed by VITEST_POOL_ID (the isolation model)
    // Real MySQL: first run pulls the image + boots the engine. Generous timeouts for that cold start.
    testTimeout: 240_000,
    hookTimeout: 240_000,
  },
})
