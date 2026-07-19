import { describe, expect, it } from 'vitest'
import { BabystackError, createPool } from '../src/index'
import { FakeClock, FakeCommandRunner, FakeEngineAdapter } from './fakes'

async function fixture() {
  const adapter = new FakeEngineAdapter(new FakeClock(), new FakeCommandRunner())
  const instance = await adapter.provision({ service: 'db', engine: 'mysql' })
  const baseline = await adapter.buildBaseline(instance, { commands: [], env: {} })
  adapter.events.length = 0 // ignore fixture setup; assert only on pool behavior below
  return { adapter, instance, baseline }
}

describe('createPool', () => {
  it('ISOLATED_NAMES: distinct worker keys mint distinct databases + urls', async () => {
    const { adapter, instance, baseline } = await fixture()
    const pool = createPool(adapter, instance, baseline)

    const a = await pool.acquire('1')
    const b = await pool.acquire('2')

    expect(a.database).not.toBe(b.database)
    expect(a.url).not.toBe(b.url)
  })

  it('RELEASE: release drops one lease; releaseAll drops the remainder', async () => {
    const { adapter, instance, baseline } = await fixture()
    const pool = createPool(adapter, instance, baseline)

    await pool.acquire('1')
    await pool.acquire('2')
    await pool.release('1')
    await pool.releaseAll()

    expect(adapter.events.filter((e) => e.startsWith('closeLease')).length).toBe(2)
  })

  it('RELEASE_UNKNOWN: releasing a key that was never acquired is a no-op', async () => {
    const { adapter, instance, baseline } = await fixture()
    const pool = createPool(adapter, instance, baseline)

    await pool.release('never')

    expect(adapter.events.filter((e) => e.startsWith('closeLease')).length).toBe(0)
  })

  it('RELEASE_KEEPS_ON_FAILURE: a lease whose close fails stays tracked and can be retried', async () => {
    const { adapter, instance, baseline } = await fixture()
    const pool = createPool(adapter, instance, baseline)
    const a = await pool.acquire('1')

    adapter.failCloseFor.add(a.database)
    await expect(pool.release('1')).rejects.toBeInstanceOf(BabystackError)

    adapter.failCloseFor.delete(a.database)
    await pool.release('1') // still tracked → the retry closes it

    expect(adapter.events.filter((e) => e === `closeLease:${a.database}`)).toHaveLength(2)
  })

  it('RELEASE_ALL_PARTIAL: one failing close does not strand the rest; failures aggregate; retry-safe', async () => {
    const { adapter, instance, baseline } = await fixture()
    const pool = createPool(adapter, instance, baseline)
    const a = await pool.acquire('1')
    const b = await pool.acquire('2')

    adapter.failCloseFor.add(a.database) // worker 1's close fails; worker 2 still closes
    await expect(pool.releaseAll()).rejects.toBeInstanceOf(AggregateError)
    expect(adapter.events.filter((e) => e === `closeLease:${b.database}`)).toHaveLength(1)

    adapter.failCloseFor.delete(a.database)
    await pool.releaseAll() // worker 1 still tracked → retry closes it
    expect(adapter.events.filter((e) => e === `closeLease:${a.database}`)).toHaveLength(2)
  })
})
