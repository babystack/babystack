import { defineConfig } from 'vitest/config'

// Integration tests only — real Docker + a real MySQL container. Kept separate from vitest.config.ts (which
// EXCLUDES tests/integration so the default `pnpm test` stays Docker-free). Run via `test:integration`.
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    // The fixture apps are driven by NESTED `vitest run`s from inside the orchestrator tests — they must
    // NOT be collected by this outer run (fixture* = fixture, fixture-parallel).
    exclude: ['tests/integration/fixture*/**'],
    // Serialize the orchestrator files: each spawns its own nested `vitest run` + real MySQL container, so
    // running them concurrently would thrash one Docker engine (multiple mysqld boots at once).
    fileParallelism: false,
    testTimeout: 240_000,
    hookTimeout: 240_000,
  },
})
