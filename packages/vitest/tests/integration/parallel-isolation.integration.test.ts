import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DockerBackend, NodeCommandRunner, SystemClock } from '@babystack/docker'
import { afterAll, describe, expect, it } from 'vitest'

// The 0.5 proof: real parallelism + isolation. Excluded from the default `test`; run via `test:integration`
// with a reachable engine (CI Tier-2, or `BABYSTACK_DOCKER_IT=1` locally). Drives a 4-file fixture suite
// through a NESTED stock `vitest run` and inspects the result.

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')
const fixtureDir = resolve(here, 'fixture-parallel')
const seedLog = resolve(fixtureDir, '.seed-runs.log')
const workerDbLog = resolve(fixtureDir, '.worker-dbs.log')
const reportFile = join(tmpdir(), 'bs-parallel-report.json') // Vitest JSON report (a real contract, not stdout prose)
const vitestBin = resolve(repoRoot, 'node_modules/.bin/vitest')

interface VitestJsonReport {
  numTotalTests?: number
  numPassedTests?: number
  numFailedTests?: number
}
function readReport(): VitestJsonReport {
  try {
    return JSON.parse(readFileSync(reportFile, 'utf8')) as VitestJsonReport
  } catch {
    return {}
  }
}

function countLines(file: string): string[] {
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
  } catch {
    return [] // file absent ⇒ the step never ran (the assertions below surface it)
  }
}

const docker = new DockerBackend({ runner: new NodeCommandRunner(), clock: new SystemClock() })
const gated = process.env['CI'] === undefined && process.env['BABYSTACK_DOCKER_IT'] === undefined

interface RunResult {
  status: number | null
  stdout: string
  stderr: string
  report: VitestJsonReport // structured pass/fail counts from the nested run
  seedRuns: number // how many times the baseline seed ran (must be 1 — built once, in the main process)
  dbNames: Set<string> // the distinct per-worker databases the fixture reported using
}

function runFixtureSuite(): RunResult {
  // Reset the "built once" + per-worker + report markers before each run.
  for (const file of [seedLog, workerDbLog, reportFile]) rmSync(file, { force: true })
  const run = spawnSync(vitestBin, ['run', '--reporter=json', '--outputFile', reportFile], {
    cwd: fixtureDir,
    encoding: 'utf8',
    timeout: 220_000,
    env: { ...process.env, BABYSTACK_DOCKER_IT: '1' },
  })
  return {
    status: run.status,
    stdout: run.stdout ?? '',
    stderr: run.stderr ?? '',
    report: readReport(),
    seedRuns: countLines(seedLog).length,
    dbNames: new Set(countLines(workerDbLog)),
  }
}

function assertGreen(result: RunResult): void {
  // Nested runs are opaque on failure — surface the child's own output.
  if (result.status !== 0) {
    throw new Error(
      `fixture vitest exited ${result.status}:\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
    )
  }
  // Assert the machine-readable report, not reporter prose: all 4 files collected and passed.
  expect(result.report.numTotalTests).toBe(4)
  expect(result.report.numPassedTests).toBe(4)
  expect(result.report.numFailedTests).toBe(0)
}

describe.skipIf(gated)(
  '@babystack/vitest parallelism & isolation (integration, real MySQL)',
  () => {
    afterAll(() => {
      for (const file of [seedLog, workerDbLog, reportFile]) rmSync(file, { force: true })
    })

    it('gives concurrent workers their own isolated databases, from one baseline built once', async () => {
      if (!(await docker.isAvailable()))
        throw new Error('Docker engine not reachable for integration tests')

      const result = runFixtureSuite()
      assertGreen(result) // each file already asserted its own cross-worker sentinel (seed + own row only)

      // Real parallelism happened: ≥2 distinct per-worker databases ran concurrently. (One DB per worker,
      // so the count is bounded by CPUs — 4 on a ≥4-core box; ≥2 is the portable floor. Vitest 4 has no
      // worker floor to pin it to exactly 4.)
      expect(result.dbNames.size).toBeGreaterThanOrEqual(2)
      // The baseline was built ONCE (main process), then reused by every worker — not rebuilt per worker.
      expect(result.seedRuns).toBe(1)
    })

    it('is deterministic across 3 repeated runs', () => {
      for (let i = 0; i < 3; i++) {
        const result = runFixtureSuite()
        assertGreen(result)
        expect(result.seedRuns).toBe(1)
        expect(result.dbNames.size).toBeGreaterThanOrEqual(2) // parallelism must not silently collapse
      }
    })
  },
)
