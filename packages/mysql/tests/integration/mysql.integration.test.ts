import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Baseline, Instance } from '@babystack/core'
import {
  DockerBackend,
  NodeCommandRunner,
  SystemClock,
  dockerEnvAllowlist,
} from '@babystack/docker'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MysqlAdapter } from '../../src/index'

// Real Docker + a real mysql:8.4 (first run pulls ~500 MB). Excluded from the default `test`; run via
// `test:integration` with a reachable engine (CI Tier-2, or `BABYSTACK_DOCKER_IT=1` locally). One container
// is provisioned in beforeAll and reused across the two tests.

const clock = new SystemClock()
const docker = new DockerBackend({ runner: new NodeCommandRunner(), clock })
let adapter: MysqlAdapter
let cacheDir: string
let instance: Instance
let baseline: Baseline

const password = () => instance.meta?.['password'] as string

describe.skipIf(process.env.CI === undefined && process.env.BABYSTACK_DOCKER_IT === undefined)(
  'MysqlAdapter (integration, real MySQL)',
  () => {
    beforeAll(async () => {
      if (!(await docker.isAvailable()))
        throw new Error('Docker engine not reachable for integration tests')
      cacheDir = await mkdtemp(join(tmpdir(), 'bs-mysql-it-'))
      adapter = new MysqlAdapter({
        docker,
        clock,
        runner: new NodeCommandRunner(),
        runId: 'mysql-itest',
        options: { cacheDir },
      })
      instance = await adapter.provision({ service: 'db', engine: 'mysql' })
      await adapter.waitReady(instance) // pulls mysql:8.4 (first run) + boots, then a real SELECT 1
    })

    afterAll(async () => {
      if (instance) await adapter.dispose(instance)
      if (cacheDir) await rm(cacheDir, { recursive: true, force: true })
    })

    it('builds a seeded baseline from a host seed command', async () => {
      // Seed via a host command that execs the container's own mysql client (no host MySQL client needed);
      // it targets the build DB through the injected $MYSQL_DATABASE, proving the scrubbed-env injection.
      // Includes a multibyte string (café☕) and a binary column — the trust-cliff regression guard: they
      // must survive build→dump→lease uncorrupted (chunk-safe decode + --hex-blob).
      const seed = `docker exec ${instance.id} mysql -uroot -p${password()} --default-character-set=utf8mb4 "$MYSQL_DATABASE" -e "CREATE TABLE demo (id INT PRIMARY KEY, tag VARCHAR(64), bin VARBINARY(8)); INSERT INTO demo VALUES (42, 'café☕', UNHEX('DEADBEEF'));"`
      baseline = await adapter.buildBaseline(instance, {
        commands: [seed],
        env: dockerEnvAllowlist(),
      })
      expect(baseline.checksum).toMatch(/^sha256:/)
      expect(baseline.bytes ?? 0).toBeGreaterThan(0)
    })

    it('opens a per-worker lease with the seeded data intact, then drops it on close', async () => {
      const lease = await adapter.openLease(instance, baseline, '1')
      expect(lease.database).toBe('babystack_db_w1')

      const query = await docker.exec(instance.id, [
        'mysql',
        '-uroot',
        `-p${password()}`,
        'babystack_db_w1',
        '-N',
        '--default-character-set=utf8mb4',
        '-e',
        'SELECT id, tag, HEX(bin) FROM demo WHERE id = 42',
      ])
      // The seeded row survived build → dump → lease — INCLUDING the multibyte string and binary bytes
      // (would be U+FFFD / mangled without the chunk-safe decode + --hex-blob fixes).
      expect(query.stdout.trim().split('\t')).toEqual(['42', 'café☕', 'DEADBEEF'])

      await adapter.closeLease(lease)
      const gone = await docker.exec(instance.id, [
        'mysql',
        '-uroot',
        `-p${password()}`,
        '-e',
        'USE babystack_db_w1',
      ])
      expect(gone.code).not.toBe(0) // database dropped
    })
  },
)
