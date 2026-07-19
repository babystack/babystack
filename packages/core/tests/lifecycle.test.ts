import { describe, expect, it } from 'vitest'
import { createStack, type ProvisionSpec, type SeedSpec } from '../src/index'
import { FakeClock, FakeCommandRunner, FakeEngineAdapter } from './fakes'

const spec: ProvisionSpec = { service: 'db', engine: 'mysql', image: 'mysql:8.4' }
const seed: SeedSpec = {
  commands: ['pnpm migrate', 'pnpm seed'],
  env: { DATABASE_URL: 'mysql://minted:pw@127.0.0.1:53312/babystack_build' },
}

describe('createStack (lifecycle orchestrator)', () => {
  it('ORDER: drives provision → waitReady → buildBaseline → acquire×2 → release → dispose with fakes only', async () => {
    const adapter = new FakeEngineAdapter(new FakeClock(), new FakeCommandRunner())
    const stack = await createStack({ adapter }, spec, seed)

    const a = await stack.pool.acquire('1')
    const b = await stack.pool.acquire('2')
    await stack.pool.release('1')
    await stack.dispose()

    expect(adapter.events).toEqual([
      'provision:db',
      'waitReady:fake-1',
      'buildBaseline',
      'openLease:1',
      'openLease:2',
      'closeLease:babystack_db_w1',
      'closeLease:babystack_db_w2',
      'dispose:fake-1',
    ])
    // Distinct worker keys → distinct, isolated databases.
    expect(a.database).toBe('babystack_db_w1')
    expect(b.database).toBe('babystack_db_w2')
    expect(a.url).not.toBe(b.url)
  })

  it('BASELINE_BUILT_ONCE: the seed commands run once regardless of how many workers acquire', async () => {
    const cmd = new FakeCommandRunner()
    const adapter = new FakeEngineAdapter(new FakeClock(), cmd)
    const stack = await createStack({ adapter }, spec, seed)

    await stack.pool.acquire('1')
    await stack.pool.acquire('2')
    await stack.pool.acquire('3')

    expect(adapter.events.filter((e) => e === 'buildBaseline')).toHaveLength(1)
    expect(cmd.calls).toHaveLength(seed.commands.length)
  })

  it('FRESH_PER_FILE: re-acquiring the same worker key reloads a fresh database each time', async () => {
    const adapter = new FakeEngineAdapter(new FakeClock(), new FakeCommandRunner())
    const stack = await createStack({ adapter }, spec, seed)

    await stack.pool.acquire('1') // file A on worker 1
    await stack.pool.acquire('1') // file B on worker 1 → fresh reload

    expect(adapter.events.filter((e) => e === 'openLease:1')).toHaveLength(2)
    await stack.dispose()
  })

  it('ENV_PASSTHROUGH: forwards seed.env to the build commands UNMUTATED (no ambient vars added)', async () => {
    // Core-level claim only: seed.env reaches the CommandRunner exactly as given (a `toEqual` catches
    // any added/removed key). The real ambient-env scrub — a concrete CommandRunner must never do
    // `{ ...process.env }` — is asserted in the adapter phase against the real runner.
    const cmd = new FakeCommandRunner()
    const adapter = new FakeEngineAdapter(new FakeClock(), cmd)
    await createStack({ adapter }, spec, seed)

    expect(cmd.calls).toHaveLength(seed.commands.length)
    expect(cmd.calls[0]?.options?.env).toEqual(seed.env)
  })

  it('CLEANUP_ON_WAITREADY_FAILURE: disposes the provisioned instance and rethrows a typed error', async () => {
    const adapter = new FakeEngineAdapter(new FakeClock(), new FakeCommandRunner())
    adapter.failAt.add('waitReady')

    await expect(createStack({ adapter }, spec, seed)).rejects.toMatchObject({
      code: 'WAIT_READY_TIMEOUT',
    })
    // Provisioned, then torn down; the baseline was never built.
    expect(adapter.events).toEqual(['provision:db', 'waitReady:fake-1', 'dispose:fake-1'])
  })

  it('CLEANUP_ON_BUILD_FAILURE: disposes the instance if buildBaseline fails (no lease opened)', async () => {
    const adapter = new FakeEngineAdapter(new FakeClock(), new FakeCommandRunner())
    adapter.failAt.add('buildBaseline')

    await expect(createStack({ adapter }, spec, seed)).rejects.toMatchObject({
      code: 'BASELINE_BUILD_FAILED',
    })
    expect(adapter.events).toContain('dispose:fake-1')
    expect(adapter.events).not.toContain('openLease:1')
  })

  it('DISPOSE_IDEMPOTENT: a second dispose() is a no-op (adapter.dispose fires exactly once)', async () => {
    const adapter = new FakeEngineAdapter(new FakeClock(), new FakeCommandRunner())
    const stack = await createStack({ adapter }, spec, seed)

    await stack.dispose()
    await stack.dispose()

    expect(adapter.events.filter((e) => e === 'dispose:fake-1')).toHaveLength(1)
  })

  it('DISPOSE_TEARS_DOWN_EVEN_IF_A_LEASE_FAILS: the instance is disposed despite a failing closeLease', async () => {
    const adapter = new FakeEngineAdapter(new FakeClock(), new FakeCommandRunner())
    const stack = await createStack({ adapter }, spec, seed)
    const lease = await stack.pool.acquire('1')
    adapter.failCloseFor.add(lease.database)

    await expect(stack.dispose()).rejects.toBeInstanceOf(AggregateError)
    expect(adapter.events).toContain('dispose:fake-1') // finally-block teardown still ran
  })
})
