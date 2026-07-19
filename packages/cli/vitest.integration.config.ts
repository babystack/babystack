import { defineConfig } from 'vitest/config'

// Integration tests only — real Docker + a real MySQL container, driving the `baby` command flow across
// separate calls. Kept separate from vitest.config.ts (which excludes tests/integration). Run via
// `test:integration` with a reachable engine (CI Tier-2, or `BABYSTACK_DOCKER_IT=1` locally).
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 240_000,
    hookTimeout: 240_000,
  },
})
