import { createHash } from 'node:crypto'
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { DockerBackend } from '@babystack/docker'
import { afterEach, describe, expect, it } from 'vitest'
import { MysqlAdapter, normalizeDefiners } from '../src/index'
import { FakeClock, FakeCommandRunner } from './fakes'

// Drive a REAL DockerBackend over a FAKE CommandRunner (shared with the adapter's host runner): asserts
// the docker/host argv + env the adapter emits, with zero Docker. The full loop runs for real in the
// integration test. `mysqldump` is scripted to return a dump with a DEFINER clause (to prove normalization).
const DUMP =
  'CREATE TABLE `demo` (\n  `id` int\n) /*!50013 DEFINER=`root`@`%` SQL SECURITY DEFINER */;\nINSERT INTO `demo` VALUES (42);\n'

const handler = (argv: readonly string[]) => {
  if (argv[1] === 'run') return { code: 0, stdout: 'mysqlctr\n', stderr: '' }
  if (argv[1] === 'port') return { code: 0, stdout: '127.0.0.1:53312\n', stderr: '' }
  if (argv.includes('mysqldump')) return { code: 0, stdout: DUMP, stderr: '' }
  return { code: 0, stdout: '', stderr: '' }
}

const tmp = (tag: string) => join(tmpdir(), `bs-mysql-${process.pid}-${Date.now()}-${tag}`)

const make = (cacheDir = tmp('default'), h = handler) => {
  const runner = new FakeCommandRunner(h)
  const docker = new DockerBackend({
    runner,
    clock: new FakeClock(),
    dockerEnv: { PATH: '/usr/bin' },
  })
  const adapter = new MysqlAdapter({
    docker,
    clock: new FakeClock(1000),
    runner,
    mintSecret: () => 'pw',
    runId: 'r1',
    options: { cacheDir },
  })
  return { runner, adapter }
}

const provisioned = {
  id: 'mysqlctr',
  service: 'db',
  engine: 'mysql' as const,
  host: '127.0.0.1',
  port: 53312,
  meta: { password: 'pw' },
}
const lastArg = (argv: readonly string[]) => String(argv[argv.length - 1])

afterEach(() => {
  delete process.env.DATABASE_URL
})

describe('MysqlAdapter — container lifecycle', () => {
  it('declares the mysql engine', () => {
    expect(make().adapter.engine).toBe('mysql')
  })

  it('provisions a real mysql:8.4 container with a minted root password', async () => {
    const { runner, adapter } = make()
    const instance = await adapter.provision({ service: 'db', engine: 'mysql' })
    expect(instance).toEqual(provisioned)
    const run = runner.calls[0]?.argv ?? []
    expect(run).toContain('mysql:8.4')
    expect(run).toContain('MYSQL_ROOT_PASSWORD=pw')
    expect(run).toContain('babystack.run=r1')
    expect(run).toContain('127.0.0.1::3306')
  })

  it('waitReady runs an authenticated SELECT 1 over TCP (not a port ping, not the socket)', async () => {
    const { runner, adapter } = make()
    await adapter.waitReady(provisioned)
    const exec = runner.calls.find((c) => c.argv[1] === 'exec')?.argv
    // `-h 127.0.0.1` forces TCP so the probe can't pass against the image's temporary
    // `--skip-networking` init server (the ERROR 2002 init-restart race).
    expect(exec).toEqual([
      'docker',
      'exec',
      'mysqlctr',
      'mysql',
      '-h',
      '127.0.0.1',
      '-uroot',
      '-ppw',
      '-e',
      'SELECT 1',
    ])
  })

  it('disposes via the Docker backend', async () => {
    const { runner, adapter } = make()
    await adapter.dispose(provisioned)
    expect(runner.calls[0]?.argv).toEqual(['docker', 'rm', '-f', '-v', 'mysqlctr'])
  })

  it('env(lease) yields the disposable connection env', () => {
    const lease = {
      instance: provisioned,
      database: 'babystack_db_w1',
      url: 'mysql://root:pw@127.0.0.1:53312/babystack_db_w1',
    }
    expect(make().adapter.env(lease)).toEqual({
      DATABASE_URL: 'mysql://root:pw@127.0.0.1:53312/babystack_db_w1',
      MYSQL_HOST: '127.0.0.1',
      MYSQL_PORT: '53312',
      MYSQL_USER: 'root',
      MYSQL_PASSWORD: 'pw',
      MYSQL_DATABASE: 'babystack_db_w1',
    })
  })
})

describe('MysqlAdapter — baseline & leases', () => {
  it('builds a seeded baseline in a scrubbed env, then dumps + caches it (DEFINER normalized)', async () => {
    const { runner, adapter } = make(tmp('baseline'))
    process.env.DATABASE_URL = 'mysql://DECOY' // ambient decoy must NOT reach the seed command
    const baseline = await adapter.buildBaseline(provisioned, {
      commands: ['run-migrations'],
      env: { PATH: '/usr/bin' },
    })

    // a fresh build DB was created
    expect(
      runner.calls.some((c) => lastArg(c.argv).includes('CREATE DATABASE `babystack_db_build`')),
    ).toBe(true)

    // the seed command ran with the minted build URL — the credential boundary held
    const seed = runner.calls.find((c) => c.argv[0] === 'sh' && c.argv[2] === 'run-migrations')
    expect(seed?.options?.env?.DATABASE_URL).toBe(
      'mysql://root:pw@127.0.0.1:53312/babystack_db_build',
    )
    expect(JSON.stringify(seed?.options?.env)).not.toContain('DECOY')
    expect(seed?.options?.env?.MYSQL_DATABASE).toBe('babystack_db_build')

    // dump cached, DEFINER-normalized, checksum over the normalized text
    const onDisk = await readFile(baseline.ref, 'utf8')
    expect(onDisk).toBe(normalizeDefiners(DUMP))
    expect(onDisk).not.toContain('DEFINER=')
    expect(baseline.checksum).toBe(
      `sha256:${createHash('sha256').update(normalizeDefiners(DUMP)).digest('hex')}`,
    )
  })

  it('opens a per-worker lease: a fresh DB loaded from the cached dump over stdin', async () => {
    const { runner, adapter } = make(tmp('lease'))
    const baseline = await adapter.buildBaseline(provisioned, { commands: [], env: {} })
    runner.calls.length = 0 // focus on openLease
    const lease = await adapter.openLease(provisioned, baseline, '1')

    expect(lease.database).toBe('babystack_db_w1')
    expect(lease.url).toBe('mysql://root:pw@127.0.0.1:53312/babystack_db_w1')
    expect(
      runner.calls.some((c) => lastArg(c.argv).includes('CREATE DATABASE `babystack_db_w1`')),
    ).toBe(true)
    const load = runner.calls.find(
      (c) => c.argv.includes('babystack_db_w1') && c.options?.stdin !== undefined,
    )
    expect(load?.argv).toContain('-i') // docker exec -i for the piped dump
    expect(load?.options?.stdin).toBe(normalizeDefiners(DUMP))
  })

  it('closes a lease by dropping its database', async () => {
    const { runner, adapter } = make()
    await adapter.closeLease({ instance: provisioned, database: 'babystack_db_w1', url: 'x' })
    expect(
      runner.calls.some((c) =>
        lastArg(c.argv).includes('DROP DATABASE IF EXISTS `babystack_db_w1`'),
      ),
    ).toBe(true)
  })
})

describe('MysqlAdapter — error mapping', () => {
  it('maps a failing seed command to BASELINE_BUILD_FAILED', async () => {
    const { adapter } = make(tmp('seedfail'), (argv) =>
      argv[0] === 'sh' ? { code: 1, stdout: '', stderr: 'migrate boom' } : handler(argv),
    )
    await expect(
      adapter.buildBaseline(provisioned, { commands: ['migrate'], env: {} }),
    ).rejects.toMatchObject({ code: 'BASELINE_BUILD_FAILED' })
  })

  it('maps a failing mysqldump to BASELINE_BUILD_FAILED', async () => {
    const { adapter } = make(tmp('dumpfail'), (argv) =>
      argv.includes('mysqldump') ? { code: 1, stdout: '', stderr: 'dump boom' } : handler(argv),
    )
    await expect(
      adapter.buildBaseline(provisioned, { commands: [], env: {} }),
    ).rejects.toMatchObject({ code: 'BASELINE_BUILD_FAILED' })
  })

  it('maps a failing build-DB creation to BASELINE_BUILD_FAILED', async () => {
    const { adapter } = make(tmp('createfail'), (argv) =>
      argv.includes('-e') && lastArg(argv).includes('CREATE DATABASE')
        ? { code: 1, stdout: '', stderr: 'denied' }
        : handler(argv),
    )
    await expect(
      adapter.buildBaseline(provisioned, { commands: [], env: {} }),
    ).rejects.toMatchObject({ code: 'BASELINE_BUILD_FAILED' })
  })

  it('maps a failing baseline load to LEASE_FAILED', async () => {
    const { adapter } = make(tmp('loadfail'), (argv) =>
      argv.includes('-i') && argv.includes('babystack_db_w1')
        ? { code: 1, stdout: '', stderr: 'load boom' }
        : handler(argv),
    )
    const baseline = await adapter.buildBaseline(provisioned, { commands: [], env: {} })
    await expect(adapter.openLease(provisioned, baseline, '1')).rejects.toMatchObject({
      code: 'LEASE_FAILED',
    })
  })

  it('throws PROVISION_FAILED when the instance is missing its minted password', async () => {
    await expect(make().adapter.waitReady({ ...provisioned, meta: {} })).rejects.toMatchObject({
      code: 'PROVISION_FAILED',
    })
  })

  it('stores an ABSOLUTE baseline.ref even when cacheDir is relative (survives the worker cwd hop)', async () => {
    const relative = `.babystack-test-${process.pid}-${Date.now()}`
    try {
      const baseline = await make(relative).adapter.buildBaseline(provisioned, {
        commands: [],
        env: {},
      })
      expect(isAbsolute(baseline.ref)).toBe(true)
    } finally {
      await rm(resolve(relative), { recursive: true, force: true })
    }
  })
})

describe('MysqlAdapter — discover (cross-invocation)', () => {
  const makeWithLabels = (
    h: (argv: readonly string[]) => { code: number; stdout: string; stderr: string },
  ) => {
    const runner = new FakeCommandRunner(h)
    const docker = new DockerBackend({
      runner,
      clock: new FakeClock(),
      dockerEnv: { PATH: '/usr/bin' },
    })
    const adapter = new MysqlAdapter({
      docker,
      clock: new FakeClock(),
      runner,
      labels: { 'babystack.project': 'p1' },
    })
    return { runner, adapter }
  }

  it('reconstructs an Instance from a running container (password recovered from docker inspect)', async () => {
    const { runner, adapter } = makeWithLabels((argv) => {
      if (argv[1] === 'ps') return { code: 0, stdout: 'found123\n', stderr: '' }
      if (argv[1] === 'port') return { code: 0, stdout: '127.0.0.1:53999\n', stderr: '' }
      if (argv[1] === 'inspect')
        return { code: 0, stdout: '["MYSQL_ROOT_PASSWORD=bs_disc"]\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const instance = await adapter.discover('db')
    expect(instance).toEqual({
      id: 'found123',
      service: 'db',
      engine: 'mysql',
      host: '127.0.0.1',
      port: 53999,
      meta: { password: 'bs_disc' },
    })
    // discovery is scoped by owner + project label
    const ps = runner.calls.find((c) => c.argv[1] === 'ps')
    expect(ps?.argv).toContain('label=babystack=1')
    expect(ps?.argv).toContain('label=babystack.project=p1')
  })

  it('returns undefined when nothing matching is running', async () => {
    const { adapter } = makeWithLabels(() => ({ code: 0, stdout: '', stderr: '' }))
    expect(await adapter.discover('db')).toBeUndefined()
  })
})

describe('MysqlAdapter — cache integrity & secret redaction', () => {
  it('publishes the baseline atomically — no .tmp file left behind', async () => {
    const { adapter } = make(tmp('atomic'))
    const baseline = await adapter.buildBaseline(provisioned, { commands: [], env: {} })
    const files = await readdir(dirname(baseline.ref))
    expect(files).toContain('dump.sql')
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false)
  })

  it('rejects a corrupt/tampered baseline with BASELINE_CORRUPT before loading it', async () => {
    const { adapter } = make(tmp('corrupt'))
    const baseline = await adapter.buildBaseline(provisioned, { commands: [], env: {} })
    await writeFile(baseline.ref, 'GARBAGE — not the cached dump', 'utf8') // tamper after build
    await expect(adapter.openLease(provisioned, baseline, '1')).rejects.toMatchObject({
      code: 'BASELINE_CORRUPT',
    })
  })

  it('redacts secret-shaped output from a failing seed command’s error', async () => {
    const { adapter } = make(tmp('redact'), (argv) =>
      argv[0] === 'sh'
        ? { code: 1, stdout: '', stderr: 'boom: mysql://root:s3cr3tpw@10.0.0.1/prod refused' }
        : handler(argv),
    )
    let message = ''
    try {
      await adapter.buildBaseline(provisioned, { commands: ['leaky-seed'], env: {} })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('mysql://root:***@') // credentials scrubbed
    expect(message).not.toContain('s3cr3tpw')
  })
})

describe('normalizeDefiners', () => {
  it('strips DEFINER clauses (in mysqldump version comments) so a dump reloads under any user', () => {
    expect(normalizeDefiners('x /*!50013 DEFINER=`root`@`%` SQL */ y')).toBe('x /*!50013 SQL */ y')
  })

  it('leaves a DEFINER-looking substring inside INSERT row data untouched', () => {
    const row = "INSERT INTO notes VALUES (1, 'see DEFINER=`root`@`%` in the manual');"
    expect(normalizeDefiners(row)).toBe(row)
  })
})
