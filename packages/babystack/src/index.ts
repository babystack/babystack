// The flagship `babystack` package is a thin front door: it re-exports the public API of the pure core
// (most importantly `defineConfig`, which your `babystack.config.ts` imports) and ships the `baby` CLI bin
// (see bin/baby.js). The real implementation lives in the scoped packages — `@babystack/core` (this
// re-export), `@babystack/cli` (the CLI), and `@babystack/vitest` / `@babystack/mysql` (the test wedge).
export * from '@babystack/core'
