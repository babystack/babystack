/**
 * `@babystack/vitest` — the Vitest delivery vehicle for the babystack engine.
 *
 * The two hooks consumers wire into `vitest.config.ts` live at their own subpaths (so Vitest imports each
 * as its own module): `@babystack/vitest/global-setup` (once, main process) and `@babystack/vitest/setup`
 * (per file, in each worker). This entrypoint re-exports the shared resolver/lifecycle helpers from
 * `@babystack/runtime` for programmatic use (the same helpers the `baby` CLI uses).
 *
 * It also re-exports `defineConfig` (and the config types) from `@babystack/core`, so the Vitest wedge is a
 * SINGLE install: `pnpm add -D @babystack/vitest`, then `import { defineConfig } from '@babystack/vitest'` in
 * your `babystack.config.ts` — no separate `@babystack/core`/`@babystack/mysql` needed.
 */
export { defineConfig } from '@babystack/core'
export type {
  BabystackConfig,
  ServiceConfig,
  MysqlService,
  BaselineConfig,
  TestPolicy,
} from '@babystack/core'
export {
  buildEnvAllowlist,
  createMysqlAdapter,
  leaseEnv,
  loadConfig,
  provisionStack,
  resolveMysqlService,
  toProvisionSpec,
  toSeedSpec,
  type AdapterOptions,
} from '@babystack/runtime'
