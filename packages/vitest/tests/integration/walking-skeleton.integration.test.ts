import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@babystack/core'
import { DockerBackend, NodeCommandRunner, SystemClock } from '@babystack/docker'
import { createConnection } from 'mysql2/promise'
import { afterAll, describe, expect, it } from 'vitest'
import { leaseEnv, provisionStack } from '@babystack/runtime'

// The 0.4 proof: the Vitest delivery vehicle, end to end, against a real MySQL. Excluded from the default
// `test`; run via `test:integration` with a reachable engine (CI Tier-2, or `BABYSTACK_DOCKER_IT=1` locally).

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')
const fixtureDir = resolve(here, 'fixture')

const docker = new DockerBackend({ runner: new NodeCommandRunner(), clock: new SystemClock() })
const gated = process.env['CI'] === undefined && process.env['BABYSTACK_DOCKER_IT'] === undefined

describe.skipIf(gated)('@babystack/vitest walking skeleton (integration, real MySQL)', () => {
  // Level 1 — the resolver + lifecycle helpers directly: config → provision → (provide/inject boundary) →
  // per-worker lease → a real host→container connection over DATABASE_URL. Granular, fast to diagnose.
  describe('resolver → provision → lease → connect', () => {
    let stack: Awaited<ReturnType<typeof provisionStack>>['stack'] | undefined
    afterAll(async () => {
      if (stack) await stack.dispose()
    })

    it('hands a worker a fresh real DB reachable over DATABASE_URL', async () => {
      if (!(await docker.isAvailable()))
        throw new Error('Docker engine not reachable for integration tests')
      ;({ stack } = await provisionStack(
        defineConfig({ services: { db: { engine: 'mysql', image: 'mysql:8.4' } } }),
      ))
      // Workers only get the serializable coordinates; re-derive the lease from them, as a worker would.
      const env = await leaseEnv(stack.instance, stack.baseline, '1')
      const url = env['DATABASE_URL']
      expect(url).toMatch(/^mysql:\/\/root:.+@127\.0\.0\.1:\d+\/babystack_db_w1$/)
      if (url === undefined) throw new Error('leaseEnv did not return a DATABASE_URL')

      const conn = await createConnection(url)
      try {
        await conn.query('CREATE TABLE t (id INT PRIMARY KEY)')
        await conn.query('INSERT INTO t VALUES (7)')
        const [rows] = await conn.query('SELECT id FROM t')
        const got = rows as unknown as Array<{ id: number }>
        expect(got[0]?.id).toBe(7) // a real, writable, isolated DB reached over the host connection string
      } finally {
        await conn.end()
      }
    })
  })

  // Level 2 — the real thing: a stock `vitest run` on a fixture app whose test imports NO babystack. Proves
  // globalSetup/setup wiring + zero-test-code + a seeded baseline visible through a per-worker lease.
  it('runs a stock `vitest run` green with zero test-code changes', () => {
    const vitestBin = resolve(repoRoot, 'node_modules/.bin/vitest')
    const reportFile = join(tmpdir(), 'bs-skeleton-report.json')
    rmSync(reportFile, { force: true })
    const run = spawnSync(vitestBin, ['run', '--reporter=json', '--outputFile', reportFile], {
      cwd: fixtureDir,
      encoding: 'utf8',
      timeout: 220_000,
      env: { ...process.env, BABYSTACK_DOCKER_IT: '1' },
    })
    // Nested runs are opaque on failure — surface the child's own output.
    if (run.status !== 0) {
      throw new Error(
        `fixture vitest exited ${run.status} (signal ${run.signal}):\n--- stdout ---\n${run.stdout}\n--- stderr ---\n${run.stderr}`,
      )
    }
    // Assert the machine-readable report (a real contract), not reporter prose.
    let report: { numTotalTests?: number; numPassedTests?: number; numFailedTests?: number } = {}
    try {
      report = JSON.parse(readFileSync(reportFile, 'utf8')) as typeof report
    } finally {
      rmSync(reportFile, { force: true })
    }
    expect(report.numTotalTests).toBe(1)
    expect(report.numPassedTests).toBe(1)
    expect(report.numFailedTests).toBe(0)
  })
})
