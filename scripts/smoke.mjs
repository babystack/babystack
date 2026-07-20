// ESM-first package smoke test — loads the BUILT packages by name the way a consumer would, so a broken
// `exports` map, a CJS-interop bug, or a bad bin fails CI instead of shipping. Run after `pnpm -r build`
// (the built dist must exist). No Docker required — this exercises packaging, not the engine.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

// @babystack/core under BOTH resolution paths — ESM `import` (dist/index.js) and CJS `require` (dist/index.cjs).
const esm = await import('@babystack/core')
assert.equal(
  typeof esm.defineConfig,
  'function',
  'ESM import: @babystack/core should export defineConfig()',
)

const cjs = require('@babystack/core')
assert.equal(
  typeof cjs.defineConfig,
  'function',
  'CJS require: @babystack/core should export defineConfig()',
)

// The flagship `babystack` re-exports the core API — verify it resolves by name through its exports map.
const flagship = await import('babystack')
assert.equal(
  typeof flagship.defineConfig,
  'function',
  'babystack (flagship): should re-export defineConfig()',
)

// defineConfig actually runs through the built artifact and validates at the boundary.
const cfg = flagship.defineConfig({
  services: { db: { engine: 'mysql', image: 'mysql:8.4', baseline: { build: ['echo seed'] } } },
})
assert.equal(cfg.services.db.engine, 'mysql', 'defineConfig should return the config object')

// @babystack/vitest — the test wedge. Consumers wire THREE entry points into `vitest.config.ts`, so a
// broken `exports` map or a dist file tsup forgot to emit would break every consumer silently. Verify all
// three resolve.
const vitest = await import('@babystack/vitest')
assert.equal(
  typeof vitest.defineConfig,
  'function',
  '@babystack/vitest: should re-export defineConfig() (the single-install path)',
)
assert.equal(
  typeof vitest.provisionStack,
  'function',
  '@babystack/vitest: should re-export the runtime helpers (provisionStack)',
)
// `./global-setup` only DEFINES its setup/teardown fns at import — safe to execute here.
const globalSetup = await import('@babystack/vitest/global-setup')
assert.equal(
  typeof globalSetup.default,
  'function',
  '@babystack/vitest/global-setup: should default-export the globalSetup fn',
)
assert.equal(
  typeof globalSetup.teardown,
  'function',
  '@babystack/vitest/global-setup: should export teardown()',
)
// `./setup` calls `inject()` at import (worker-only) — importing it here would throw. Resolve it instead
// (execution-free) and confirm the dist file exists, proving the subpath export is wired to a real artifact.
let setupUrl
try {
  setupUrl = import.meta.resolve('@babystack/vitest/setup')
} catch (error) {
  assert.fail(`@babystack/vitest/setup: subpath export should resolve — ${error.message}`)
}
assert.ok(
  existsSync(fileURLToPath(setupUrl)),
  `@babystack/vitest/setup: exports map resolves but the built file is missing (${setupUrl})`,
)

// The `baby` CLI bin (shipped by the flagship) — exercise it end-to-end (Docker-free paths only). The full
// command logic is unit-tested from source; this catches a broken build / bin shim / cross-package resolve.
const bin = join(import.meta.dirname, '..', 'packages', 'babystack', 'bin', 'baby.js')
const help = spawnSync(process.execPath, [bin, 'help'], { encoding: 'utf8' })
assert.equal(help.status, 0, 'baby bin: `baby help` should exit 0')
assert.ok(help.stdout.includes('baby'), 'baby bin: help output should mention the command')
const unknown = spawnSync(process.execPath, [bin, 'frobnicate'], { encoding: 'utf8' })
assert.equal(unknown.status, 1, 'baby bin: an unknown command should exit 1')

console.log(
  'smoke ✓  @babystack/core loads (ESM + CJS); the babystack flagship re-exports defineConfig; @babystack/vitest resolves all three entry points (. / global-setup / setup); the baby CLI bin runs (help → 0, unknown → 1)',
)
