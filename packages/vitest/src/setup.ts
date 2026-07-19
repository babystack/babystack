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
// One database per worker, keyed by Vitest's pool id. Fail fast if it's unset rather than defaulting to a
// shared '1' — under a non-forks pool every worker would key the same database and silently stomp each
// other (isolation gone). `pool: 'forks'` (required, and Vitest's default) always sets it.
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
