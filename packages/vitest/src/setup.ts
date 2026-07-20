import { isMainThread } from 'node:worker_threads'
import { BabystackError } from '@babystack/core'
import { leaseEnv } from '@babystack/runtime'
import { inject } from 'vitest'
import './provided'

/**
 * Vitest `setupFiles` — runs per test FILE, inside each worker process. Reads the stack coordinates the
 * main process provided, opens a fresh per-worker database from the baseline, and injects its connection
 * env into `process.env` BEFORE any test (and any app module that reads `DATABASE_URL`) runs. Top-level
 * `await` blocks the worker until the DB is ready — this file is ESM-only (Vitest loads setupFiles as ESM).
 */
const { instance, baseline } = inject('babystack')
// Enforce `pool: 'forks'` (required). Under forks, setupFiles run in a child PROCESS's main thread; under
// 'threads'/'vmThreads' they run in a worker THREAD that SHARES one `process.env` with its siblings —
// last-write-wins on `DATABASE_URL`, so tests silently hit the wrong worker's database (isolation gone).
// `VITEST_POOL_ID` is set under threads too, so it alone does NOT catch this — `isMainThread` does.
if (!isMainThread) {
  throw new BabystackError(
    'CONFIG_INVALID',
    "babystack requires `pool: 'forks'` — the 'threads'/'vmThreads' pools share one process.env across workers, so they'd collide on DATABASE_URL. Set `pool: 'forks'` in vitest.config.",
  )
}
// One database per worker, keyed by Vitest's pool id (always set under forks).
const key = process.env['VITEST_POOL_ID']
if (key === undefined) {
  throw new BabystackError(
    'CONFIG_INVALID',
    "VITEST_POOL_ID is not set — babystack requires `pool: 'forks'` so each worker gets its own database.",
  )
}
const env = await leaseEnv(instance, baseline, key)
for (const [name, value] of Object.entries(env)) {
  process.env[name] = value
}
