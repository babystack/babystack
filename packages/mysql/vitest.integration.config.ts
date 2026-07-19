import { defineConfig } from 'vitest/config'

// Integration tests only — real Docker + a real MySQL container. Kept separate from vitest.config.ts (which
// EXCLUDES tests/integration so the default `pnpm test` stays Docker-free). Run via `test:integration`.
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 240_000,
    hookTimeout: 240_000,
  },
})
