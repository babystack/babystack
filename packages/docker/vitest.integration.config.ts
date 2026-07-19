import { defineConfig } from 'vitest/config'

// Integration tests only — real Docker required. Kept separate from vitest.config.ts (which EXCLUDES
// tests/integration so the default `pnpm test` stays Docker-free and fast). Run via `test:integration`.
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 90_000,
    hookTimeout: 90_000,
  },
})
