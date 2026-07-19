import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Baseline, MysqlService } from '@babystack/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cacheDisabled, resolveInvalidation, shouldReuseBaseline } from '../src/index'

// The trust cliff: a cached baseline may be reused ONLY when its stored hash matches the current inputs.
// These are pure/fs-only — the wake orchestration that calls them is covered by the integration test.

describe('shouldReuseBaseline', () => {
  const baseline = (invalidation?: string): Baseline => ({
    service: 'db',
    ref: '/cache/dump.sql',
    checksum: 'sha256:abc',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...(invalidation !== undefined ? { invalidation } : {}),
  })

  it('reuses only on an exact hash match with no opt-out', () => {
    expect(shouldReuseBaseline(baseline('h1'), 'h1', false)).toBe(true)
  })
  it('rebuilds when there is no cached baseline', () => {
    expect(shouldReuseBaseline(undefined, 'h1', false)).toBe(false)
  })
  it('rebuilds when the hash differs (inputs changed since it was built)', () => {
    expect(shouldReuseBaseline(baseline('h1'), 'h2', false)).toBe(false)
  })
  it('rebuilds a pre-invalidation baseline that has no stored hash', () => {
    expect(shouldReuseBaseline(baseline(undefined), 'h1', false)).toBe(false)
  })
  it('rebuilds when the force flag is set, even on a match', () => {
    // `force` is what `--rebuild` and `$BABYSTACK_NO_CACHE` resolve TO; the env parsing itself is covered
    // by the `cacheDisabled` suite below.
    expect(shouldReuseBaseline(baseline('h1'), 'h1', true)).toBe(false)
  })
})

describe('cacheDisabled (BABYSTACK_NO_CACHE parsing)', () => {
  const original = process.env.BABYSTACK_NO_CACHE
  const set = (value: string | undefined): void => {
    if (value === undefined) delete process.env.BABYSTACK_NO_CACHE
    else process.env.BABYSTACK_NO_CACHE = value
  }
  afterEach(() => {
    set(original)
  })

  // Only genuinely-falsey values leave the cache ON; anything else opts out. A regression that treated
  // '0'/'false'/'' as truthy would force needless rebuilds on every wake.
  const cases: Array<[string | undefined, boolean]> = [
    [undefined, false],
    ['', false],
    ['0', false],
    ['false', false],
    ['FALSE', false],
    ['1', true],
    ['true', true],
    ['yes', true],
  ]
  it.each(cases)('BABYSTACK_NO_CACHE=%o → disabled=%s', (value, expected) => {
    set(value)
    expect(cacheDisabled()).toBe(expected)
  })
})

describe('resolveInvalidation', () => {
  let dir: string

  const service = (over: Partial<MysqlService> = {}): MysqlService => ({
    engine: 'mysql',
    image: 'mysql:8.4',
    baseline: { build: ['pnpm db:migrate'], invalidateWhenChanged: ['migrations/**'] },
    ...over,
  })
  const configPath = (): string => join(dir, 'babystack.config.ts')
  async function scaffold(opts: { migration?: string; config?: string } = {}): Promise<void> {
    await mkdir(join(dir, 'migrations'), { recursive: true })
    await writeFile(
      join(dir, 'migrations', '001_init.sql'),
      opts.migration ?? 'CREATE TABLE a (id INT);',
    )
    await writeFile(configPath(), opts.config ?? 'export default {}\n')
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bs-inval-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('is stable for identical inputs', async () => {
    await scaffold()
    expect(await resolveInvalidation(service(), configPath())).toBe(
      await resolveInvalidation(service(), configPath()),
    )
  })

  it('changes when a watched migration/seed file changes (the trust cliff)', async () => {
    await scaffold({ migration: 'CREATE TABLE a (id INT);' })
    const before = await resolveInvalidation(service(), configPath())
    await writeFile(join(dir, 'migrations', '001_init.sql'), 'CREATE TABLE a (id INT); -- changed')
    expect(await resolveInvalidation(service(), configPath())).not.toBe(before)
  })

  it('changes when a NEW watched file appears', async () => {
    await scaffold()
    const before = await resolveInvalidation(service(), configPath())
    await writeFile(join(dir, 'migrations', '002_more.sql'), 'CREATE TABLE b (id INT);')
    expect(await resolveInvalidation(service(), configPath())).not.toBe(before)
  })

  it('changes when a build command changes', async () => {
    await scaffold()
    const before = await resolveInvalidation(service(), configPath())
    const after = await resolveInvalidation(
      service({
        baseline: {
          build: ['pnpm db:migrate', 'pnpm db:seed'],
          invalidateWhenChanged: ['migrations/**'],
        },
      }),
      configPath(),
    )
    expect(after).not.toBe(before)
  })

  it('changes when the engine image changes', async () => {
    await scaffold()
    const before = await resolveInvalidation(service({ image: 'mysql:8.4' }), configPath())
    const after = await resolveInvalidation(service({ image: 'mysql:8.0' }), configPath())
    expect(after).not.toBe(before)
  })

  it('changes when the config file text changes', async () => {
    await scaffold({ config: 'export default { note: 1 }\n' })
    const before = await resolveInvalidation(service(), configPath())
    await writeFile(configPath(), 'export default { note: 2 }\n')
    expect(await resolveInvalidation(service(), configPath())).not.toBe(before)
  })

  it('is deterministic with no watched files configured', async () => {
    await scaffold()
    const bare = service({ baseline: { build: ['pnpm db:migrate'] } })
    expect(await resolveInvalidation(bare, configPath())).toBe(
      await resolveInvalidation(bare, configPath()),
    )
  })

  it('changes when a watched file is DELETED', async () => {
    await scaffold()
    const before = await resolveInvalidation(service(), configPath())
    await rm(join(dir, 'migrations', '001_init.sql'))
    expect(await resolveInvalidation(service(), configPath())).not.toBe(before)
  })

  it('is stable via the service-derived fallback when the config file is unreadable', async () => {
    // No config file exists at the path (only the migrations dir) — resolveInvalidation must still yield a
    // stable hash (from JSON.stringify(service) + the watched files) rather than throw, so a programmatic
    // wake(config) with no file on disk keeps working. Watched files are still resolved from its dirname.
    await mkdir(join(dir, 'migrations'), { recursive: true })
    await writeFile(join(dir, 'migrations', '001_init.sql'), 'CREATE TABLE a (id INT);')
    const missing = join(dir, 'does-not-exist.config.ts')
    expect(await resolveInvalidation(service(), missing)).toBe(
      await resolveInvalidation(service(), missing),
    )
  })

  it('composes to a REBUILD decision when a watched file changes (the trust-cliff decision)', async () => {
    // The end-to-end decision `wake` makes, minus Docker: a cached baseline is reused while inputs hold, and
    // the instant a watched migration changes the recomputed hash no longer matches → rebuild.
    await scaffold()
    const h1 = await resolveInvalidation(service(), configPath())
    const cached: Baseline = {
      service: 'db',
      ref: '/cache/dump.sql',
      checksum: 'sha256:abc',
      createdAt: '2026-01-01T00:00:00.000Z',
      invalidation: h1,
    }
    expect(
      shouldReuseBaseline(cached, await resolveInvalidation(service(), configPath()), false),
    ).toBe(true)
    await writeFile(join(dir, 'migrations', '001_init.sql'), 'CREATE TABLE a (id BIGINT);')
    const h2 = await resolveInvalidation(service(), configPath())
    expect(shouldReuseBaseline(cached, h2, false)).toBe(false)
  })
})
