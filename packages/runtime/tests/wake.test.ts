import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Baseline, Instance, MysqlService } from '@babystack/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type SessionEngine, wakeWith } from '../src/index'

// wakeWith is the wake ORCHESTRATION over an injected engine — the branch matrix (reuse · rebuild-on-mismatch
// · dispose-unready-and-reprovision · fresh · dispose-on-partial-init) with NO Docker. A fake SessionEngine
// drives the branches; a real temp dir backs the baseline sidecar so the write/read round-trip is exercised.

const inst = (id: string): Instance => ({
  id,
  service: 'db',
  engine: 'mysql',
  host: '127.0.0.1',
  port: 3306,
  meta: { password: 'bs_test' },
})

const builtBaseline = (): Baseline => ({
  service: 'db',
  ref: '/cache/db/dump.sql',
  checksum: 'sha256:deadbeef',
  createdAt: '2020-01-01T00:00:00.000Z',
})

/** A programmable engine: `running` is what `discover` returns; `readyThrows` makes `waitReady` reject for
 * the FIRST instance only (to simulate a discovered-but-wedged container that a fresh provision then fixes). */
class FakeEngine implements SessionEngine {
  running: Instance | undefined
  readyThrows = false
  buildThrows = false
  private readyCalls = 0
  discover = vi.fn(async (_service: string) => this.running)
  waitReady = vi.fn(async (instance: Instance) => {
    this.readyCalls += 1
    if (this.readyThrows && this.readyCalls === 1) {
      throw new Error(`waitReady failed for ${instance.id}`)
    }
  })
  provision = vi.fn(async (_spec: unknown) => inst('fresh'))
  buildBaseline = vi.fn(async (_instance: Instance, _spec: unknown) => {
    if (this.buildThrows) throw new Error('buildBaseline failed')
    return builtBaseline()
  })
  dispose = vi.fn(async (_instance: Instance) => {})
}

// The on-disk sidecar contract wakeWith reuses — mirror it here to seed the "already running" branch.
async function seedSidecar(cacheDir: string, name: string, baseline: Baseline): Promise<void> {
  const dir = join(cacheDir, 'baselines', name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'baseline.json'), JSON.stringify(baseline), 'utf8')
}

describe('wakeWith', () => {
  let cacheDir: string
  const service: MysqlService = { engine: 'mysql' } // no build → reuse is permitted (reuseUnsafe = false)
  const deps = (engine: SessionEngine, wantHash: string) => ({
    adapter: engine,
    name: 'db',
    service,
    cacheDir,
    wantHash,
  })

  beforeEach(async () => {
    delete process.env.BABYSTACK_NO_CACHE // otherwise cacheDisabled() would force a rebuild
    cacheDir = await mkdtemp(join(tmpdir(), 'bs-wake-'))
  })
  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true })
  })

  it('provisions fresh when nothing is running', async () => {
    const engine = new FakeEngine()
    const result = await wakeWith(deps(engine, 'h1'))
    expect(result.alreadyRunning).toBe(false)
    expect(engine.provision).toHaveBeenCalledOnce()
    expect(engine.buildBaseline).toHaveBeenCalledOnce()
    expect(engine.dispose).not.toHaveBeenCalled()
    expect(result.baseline.invalidation).toBe('h1') // stamped with the current hash
  })

  it('reuses the running container when the cached baseline hash matches', async () => {
    const engine = new FakeEngine()
    engine.running = inst('running')
    await seedSidecar(cacheDir, 'db', { ...builtBaseline(), invalidation: 'h1' })
    const result = await wakeWith(deps(engine, 'h1'))
    expect(result).toMatchObject({ alreadyRunning: true, instance: { id: 'running' } })
    expect(engine.provision).not.toHaveBeenCalled()
    expect(engine.buildBaseline).not.toHaveBeenCalled()
    expect(engine.dispose).not.toHaveBeenCalled()
  })

  it('disposes + re-provisions when the inputs changed (hash mismatch)', async () => {
    const engine = new FakeEngine()
    engine.running = inst('running')
    await seedSidecar(cacheDir, 'db', { ...builtBaseline(), invalidation: 'OLD' })
    const result = await wakeWith(deps(engine, 'NEW'))
    expect(engine.dispose).toHaveBeenCalledWith(expect.objectContaining({ id: 'running' }))
    expect(engine.provision).toHaveBeenCalledOnce()
    expect(result.alreadyRunning).toBe(false)
    expect(result.baseline.invalidation).toBe('NEW')
  })

  it('disposes a discovered-but-unready container and re-provisions fresh (the P1 fix)', async () => {
    const engine = new FakeEngine()
    engine.running = inst('wedged')
    engine.readyThrows = true // waitReady rejects for the discovered container, succeeds for the fresh one
    await seedSidecar(cacheDir, 'db', { ...builtBaseline(), invalidation: 'h1' }) // even a MATCHING sidecar
    const result = await wakeWith(deps(engine, 'h1'))
    // The wedged container must be disposed, not reused, and a fresh one provisioned — never a WAIT_READY throw.
    expect(engine.dispose).toHaveBeenCalledWith(expect.objectContaining({ id: 'wedged' }))
    expect(engine.provision).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ alreadyRunning: false, instance: { id: 'fresh' } })
  })

  it('disposes on partial init when the baseline build fails, and rethrows', async () => {
    const engine = new FakeEngine()
    engine.buildThrows = true
    await expect(wakeWith(deps(engine, 'h1'))).rejects.toThrow(/buildBaseline failed/)
    expect(engine.dispose).toHaveBeenCalledWith(expect.objectContaining({ id: 'fresh' }))
  })
})
