import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DockerBackend, NodeCommandRunner, SystemClock } from '@babystack/docker'
import { createConnection } from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { run } from '../../src/index'

// The 0.7 proof: the `baby` command flow across SEPARATE invocations against a real MySQL. The container
// `wake` starts is detached, so a later `home`/`sleep` (a fresh call) rediscovers it by label. Excluded
// from the default `test`; run via `test:integration` (CI Tier-2, or `BABYSTACK_DOCKER_IT=1` locally).

const here = dirname(fileURLToPath(import.meta.url))
const fixtureDir = resolve(here, 'fixture')
const docker = new DockerBackend({ runner: new NodeCommandRunner(), clock: new SystemClock() })
const gated = process.env['CI'] === undefined && process.env['BABYSTACK_DOCKER_IT'] === undefined
const originalCwd = process.cwd()
const watchedFile = resolve(fixtureDir, 'widget-name.txt')
let savedNoCache: string | undefined

describe.skipIf(gated)('baby CLI (integration, real MySQL)', () => {
  // The CLI reads ./babystack.config.ts from the cwd, like a user running `baby` in their project.
  beforeAll(() => {
    process.chdir(fixtureDir)
    // This suite exercises cache REUSE, which `$BABYSTACK_NO_CACHE` would defeat (forcing every wake to
    // rebuild). Neutralize any ambient value so the reuse assertions are meaningful, and restore it after.
    savedNoCache = process.env['BABYSTACK_NO_CACHE']
    delete process.env['BABYSTACK_NO_CACHE']
    rmSync(watchedFile, { force: true }) // start clean — a crashed prior run may have left one behind
  })
  afterAll(async () => {
    await run(['sleep']).catch(() => {}) // ensure the container is gone even if a test failed
    process.chdir(originalCwd)
    rmSync(resolve(fixtureDir, '.babystack'), { recursive: true, force: true })
    rmSync(watchedFile, { force: true }) // the test-managed watched input (not committed)
    if (savedNoCache === undefined) delete process.env['BABYSTACK_NO_CACHE']
    else process.env['BABYSTACK_NO_CACHE'] = savedNoCache
  })

  // Read the current widgets table over a FRESH connection (a `reset` drops+recreates the DB, so reusing an
  // old connection's schema selection would be unsound). Returns rows ordered by id for a stable assertion.
  const widgets = async (url: string): Promise<Array<{ id: number; name: string }>> => {
    const conn = await createConnection(url)
    try {
      const [rows] = await conn.query('SELECT id, name FROM widgets ORDER BY id')
      return rows as unknown as Array<{ id: number; name: string }>
    } finally {
      await conn.end()
    }
  }

  // The DATABASE_URL `baby home` hands back (for asserting what the seeded DB actually serves).
  const homeUrl = async (): Promise<string> => {
    const { env } = JSON.parse((await run(['home', '--json'])).output) as {
      env: Record<string, string>
    }
    const url = env['DATABASE_URL']
    if (url === undefined) throw new Error('home did not return a DATABASE_URL')
    return url
  }

  it('wake → home → reset (the agent loop) → sleep, across separate invocations', async () => {
    if (!(await docker.isAvailable()))
      throw new Error('Docker engine not reachable for integration tests')

    // First wake provisions + seeds; a SECOND wake (separate call) rediscovers the SAME container by label.
    expect(JSON.parse((await run(['wake', '--json'])).output)).toMatchObject({
      alreadyRunning: false,
    })
    expect(JSON.parse((await run(['wake', '--json'])).output)).toMatchObject({
      alreadyRunning: true,
    })

    // `home` hands back a connection URL for a real, seeded database.
    const home = await run(['home', '--json'])
    expect(home.code).toBe(0)
    const { env } = JSON.parse(home.output) as { env: Record<string, string> }
    const url = env['DATABASE_URL']
    if (url === undefined) throw new Error('home did not return a DATABASE_URL')
    expect(url).toMatch(/^mysql:\/\/root:.+@127\.0\.0\.1:\d+\/babystack_cli_wagent$/)
    expect(await widgets(url)).toEqual([{ id: 1, name: 'seeded-widget' }]) // the pristine baseline

    // The agent scribbles on the DB…
    const scribble = await createConnection(url)
    try {
      await scribble.query("INSERT INTO widgets (id, name) VALUES (2, 'agent-scribble')")
    } finally {
      await scribble.end()
    }

    // `home` is NON-DESTRUCTIVE: re-running it (same URL) must NOT wipe the scribble — only `reset` does.
    const home2 = await run(['home', '--json'])
    expect((JSON.parse(home2.output) as { env: Record<string, string> }).env['DATABASE_URL']).toBe(
      url,
    )
    expect(await widgets(url)).toEqual([
      { id: 1, name: 'seeded-widget' },
      { id: 2, name: 'agent-scribble' },
    ])

    // `reset` reloads the pristine baseline in place (same URL) — the scribble is gone, the seed is back.
    expect((await run(['reset', '--json'])).code).toBe(0)
    expect(await widgets(url)).toEqual([{ id: 1, name: 'seeded-widget' }])

    // `sleep` disposes the container; a second `sleep` is an idempotent no-op.
    expect(JSON.parse((await run(['sleep', '--json'])).output)).toMatchObject({ disposed: 1 })
    expect(JSON.parse((await run(['sleep', '--json'])).output)).toMatchObject({ disposed: 0 })

    // Once asleep, `home` reports nothing running (discovery finds no container).
    expect((await run(['home', '--json'])).code).toBe(1)
  })

  // The baseline sidecar, wherever it landed under the project cache (projectId is a path hash).
  const readSidecar = (): { invalidation?: string; createdAt: string } => {
    const projects = resolve(fixtureDir, '.babystack/cache/projects')
    const [id] = readdirSync(projects)
    if (id === undefined) throw new Error('no project cache dir')
    return JSON.parse(readFileSync(resolve(projects, id, 'baselines/cli/baseline.json'), 'utf8'))
  }

  it('rebuilds on a changed input and SERVES fresh seed, reuses on a match, forces with --rebuild', async () => {
    if (!(await docker.isAvailable()))
      throw new Error('Docker engine not reachable for integration tests')

    // Fresh wake (no watched file yet → the default seed name) builds + stamps the baseline hash.
    expect(JSON.parse((await run(['wake', '--json'])).output)).toMatchObject({
      alreadyRunning: false,
    })
    const built = readSidecar()
    expect(built.invalidation).toMatch(/^[0-9a-f]{64}$/) // a sha256 of the current inputs
    expect(await widgets(await homeUrl())).toEqual([{ id: 1, name: 'seeded-widget' }])

    // A second wake with UNCHANGED inputs reuses the cached baseline — no rebuild (createdAt unchanged).
    expect(JSON.parse((await run(['wake', '--json'])).output)).toMatchObject({
      alreadyRunning: true,
    })
    expect(readSidecar().createdAt).toBe(built.createdAt)

    // THE TRUST CLIFF: change a watched input, then `baby wake` alone (no explicit --rebuild) must both
    // re-stamp a NEW hash AND make `baby home` serve the NEW seed — never the stale cached one.
    writeFileSync(watchedFile, 'rebuilt-widget')
    expect((await run(['wake', '--json'])).code).toBe(0)
    const rebuilt = readSidecar()
    expect(rebuilt.invalidation).not.toBe(built.invalidation) // inputs changed → new hash
    expect(rebuilt.createdAt).not.toBe(built.createdAt) // a real rebuild happened
    expect(await widgets(await homeUrl())).toEqual([{ id: 1, name: 'rebuilt-widget' }]) // fresh seed served

    // `--rebuild` forces a fresh baseline even with NO input change — new createdAt, identical hash.
    expect((await run(['wake', '--rebuild', '--json'])).code).toBe(0)
    const forced = readSidecar()
    expect(forced.createdAt).not.toBe(rebuilt.createdAt)
    expect(forced.invalidation).toBe(rebuilt.invalidation) // same inputs → same hash

    expect(JSON.parse((await run(['sleep', '--json'])).output)).toMatchObject({ disposed: 1 })
  })
})
