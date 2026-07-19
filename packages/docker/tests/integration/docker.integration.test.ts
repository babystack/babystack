import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DockerBackend, NodeCommandRunner, SystemClock } from '../../src/index'

// Real Docker. Excluded from the default `test` run (vitest.config `exclude`); run via `test:integration`
// with a reachable Docker engine (locally, or the CI Tier-2 job). Uses a small always-running image
// (redis:7-alpine) so it exercises provision → waitReady → exec → dispose → gc without a 500MB mysql pull.

const backend = new DockerBackend({ runner: new NodeCommandRunner(), clock: new SystemClock() })
const IMAGE = 'redis:7-alpine'
const RUN_ID = 'babystack-itest'
const created: string[] = []

describe.skipIf(process.env.CI === undefined && process.env.BABYSTACK_DOCKER_IT === undefined)(
  'DockerBackend (integration, real Docker)',
  () => {
    beforeAll(async () => {
      if (!(await backend.isAvailable()))
        throw new Error('Docker engine not reachable for integration tests')
    })
    afterAll(async () => {
      for (const id of created) await backend.dispose(id)
    })

    it('reports the engine as available', async () => {
      expect(await backend.isAvailable()).toBe(true)
    })

    it('provisions → waitReady → exec → disposes a real container (dispose is idempotent)', async () => {
      const container = await backend.provision({
        image: IMAGE,
        containerPort: 6379,
        runId: RUN_ID,
      })
      created.push(container.id)
      expect(container.host).toBe('127.0.0.1')
      expect(container.port).toBeGreaterThan(0)

      await backend.waitReady(container.id, ['redis-cli', 'ping'], {
        timeoutMs: 30_000,
        intervalMs: 500,
      })
      const res = await backend.exec(container.id, ['redis-cli', 'ping'])
      expect(res.stdout.trim()).toBe('PONG')

      await backend.dispose(container.id)
      await expect(backend.dispose(container.id)).resolves.toBeUndefined() // idempotent
    }, 90_000)

    it('gc reaps a labeled orphan', async () => {
      const container = await backend.provision({
        image: IMAGE,
        containerPort: 6379,
        runId: RUN_ID,
      })
      created.push(container.id)
      const reaped = await backend.gc()
      expect(reaped).toContain(container.id)
    }, 90_000)
  },
)
