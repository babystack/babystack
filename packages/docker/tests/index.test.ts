import { describe, expect, it } from 'vitest'
import { DockerBackend } from '../src/index'
import { FakeClock, FakeCommandRunner } from './fakes'

const DOCKER_ENV = { PATH: '/usr/bin' }
const make = (
  handler?: (argv: readonly string[]) => { code: number; stdout: string; stderr: string },
) => {
  const runner = new FakeCommandRunner(handler)
  const backend = new DockerBackend({ runner, clock: new FakeClock(), dockerEnv: DOCKER_ENV })
  return { runner, backend }
}

describe('DockerBackend.isAvailable', () => {
  it('is true when `docker info` exits 0, false otherwise', async () => {
    expect(await make(() => ({ code: 0, stdout: '', stderr: '' })).backend.isAvailable()).toBe(true)
    expect(
      await make(() => ({ code: 1, stdout: '', stderr: 'cannot connect' })).backend.isAvailable(),
    ).toBe(false)
  })
})

describe('DockerBackend.provision', () => {
  const handler = (argv: readonly string[]) => {
    if (argv[1] === 'run') return { code: 0, stdout: 'container123\n', stderr: '' }
    if (argv[1] === 'port') return { code: 0, stdout: '127.0.0.1:53312\n', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }

  it('emits the expected `docker run` argv (labels, env, loopback ephemeral port) and parses the mapping', async () => {
    const { runner, backend } = make(handler)
    const container = await backend.provision({
      image: 'mysql:8.4',
      containerPort: 3306,
      env: { MYSQL_ROOT_PASSWORD: 'pw' },
      runId: 'r1',
    })
    expect(container).toEqual({ id: 'container123', host: '127.0.0.1', port: 53312 })
    expect(runner.calls[0]?.argv).toEqual([
      'docker',
      'run',
      '-d',
      '--label',
      'babystack=1',
      '--label',
      'babystack.run=r1',
      '-e',
      'MYSQL_ROOT_PASSWORD=pw',
      '-p',
      '127.0.0.1::3306',
      'mysql:8.4',
    ])
    expect(runner.calls[1]?.argv).toEqual(['docker', 'port', 'container123', '3306/tcp'])
  })

  it('invokes docker with ONLY the docker env (credential boundary — no ambient/source vars)', async () => {
    const { runner, backend } = make(handler)
    await backend.provision({ image: 'mysql:8.4', containerPort: 3306 })
    expect(runner.calls[0]?.options?.env).toEqual(DOCKER_ENV)
  })

  it('throws PROVISION_FAILED on a failed run or an unparseable port', async () => {
    await expect(
      make(() => ({ code: 1, stdout: '', stderr: 'boom' })).backend.provision({
        image: 'x',
        containerPort: 3306,
      }),
    ).rejects.toMatchObject({ code: 'PROVISION_FAILED' })
    await expect(
      make((argv) =>
        argv[1] === 'run'
          ? { code: 0, stdout: 'id\n', stderr: '' }
          : { code: 0, stdout: 'garbage\n', stderr: '' },
      ).backend.provision({ image: 'x', containerPort: 3306 }),
    ).rejects.toMatchObject({ code: 'PROVISION_FAILED' })
  })

  it('disposes the container (no leak) when `docker port` fails after `docker run` succeeded', async () => {
    // Ordinary "bad image exits immediately" path: run creates the container, port then fails.
    const { runner, backend } = make((argv) => {
      if (argv[1] === 'run') return { code: 0, stdout: 'leaky\n', stderr: '' }
      if (argv[1] === 'port') return { code: 1, stdout: '', stderr: 'no container running' }
      return { code: 0, stdout: '', stderr: '' }
    })
    await expect(backend.provision({ image: 'bad', containerPort: 3306 })).rejects.toMatchObject({
      code: 'PROVISION_FAILED',
    })
    expect(runner.calls.some((c) => c.argv.join(' ') === 'docker rm -f -v leaky')).toBe(true)
  })
})

describe('DockerBackend.waitReady', () => {
  it('retries the authenticated probe until it exits 0', async () => {
    let n = 0
    const { runner, backend } = make(() => ({ code: n++ < 2 ? 1 : 0, stdout: '', stderr: '' }))
    await backend.waitReady('c', ['mysql', '-e', 'SELECT 1'])
    const execs = runner.calls.filter((c) => c.argv[1] === 'exec')
    expect(execs).toHaveLength(3) // 2 failures + 1 success
    expect(execs[0]?.argv).toEqual(['docker', 'exec', 'c', 'mysql', '-e', 'SELECT 1'])
  })

  it('throws WAIT_READY_TIMEOUT when the probe never succeeds', async () => {
    const { backend } = make(() => ({ code: 1, stdout: '', stderr: '' }))
    await expect(
      backend.waitReady('c', ['false'], { timeoutMs: 1000, intervalMs: 500 }),
    ).rejects.toMatchObject({ code: 'WAIT_READY_TIMEOUT' })
  })
})

describe('DockerBackend.exec', () => {
  it('emits `docker exec` and adds -i + stdin when piping input', async () => {
    const { runner, backend } = make()
    await backend.exec('c', ['echo', 'hi'])
    await backend.exec('c', ['sh'], 'piped')
    expect(runner.calls[0]?.argv).toEqual(['docker', 'exec', 'c', 'echo', 'hi'])
    expect(runner.calls[1]?.argv).toEqual(['docker', 'exec', '-i', 'c', 'sh'])
    expect(runner.calls[1]?.options?.stdin).toBe('piped')
  })
})

describe('DockerBackend.dispose', () => {
  it('emits `docker rm -f -v` and is idempotent (swallows "no such container")', async () => {
    const { runner, backend } = make(() => ({
      code: 1,
      stdout: '',
      stderr: 'Error: No such container: c',
    }))
    await expect(backend.dispose('c')).resolves.toBeUndefined()
    expect(runner.calls[0]?.argv).toEqual(['docker', 'rm', '-f', '-v', 'c'])
  })

  it('throws DISPOSE_FAILED on a real failure', async () => {
    const { backend } = make(() => ({ code: 1, stdout: '', stderr: 'permission denied' }))
    await expect(backend.dispose('c')).rejects.toMatchObject({ code: 'DISPOSE_FAILED' })
  })
})

describe('DockerBackend.find', () => {
  it('lists running containers matching ALL labels (discovery)', async () => {
    const { runner, backend } = make((argv) =>
      argv[1] === 'ps'
        ? { code: 0, stdout: 'idA\nidB\n', stderr: '' }
        : { code: 0, stdout: '', stderr: '' },
    )
    expect(await backend.find({ babystack: '1', 'babystack.project': 'abc' })).toEqual([
      'idA',
      'idB',
    ])
    expect(runner.calls[0]?.argv).toEqual([
      'docker',
      'ps',
      '-q',
      '--no-trunc',
      '--filter',
      'label=babystack=1',
      '--filter',
      'label=babystack.project=abc',
    ])
  })

  it('returns [] when the ps command fails', async () => {
    const { backend } = make(() => ({ code: 1, stdout: '', stderr: 'boom' }))
    expect(await backend.find({ babystack: '1' })).toEqual([])
  })
})

describe('DockerBackend.inspectEnv', () => {
  it('parses the container env into a name→value map (recovers the minted password)', async () => {
    const { backend } = make((argv) =>
      argv[1] === 'inspect'
        ? { code: 0, stdout: '["PATH=/usr/bin","MYSQL_ROOT_PASSWORD=bs_abc123"]\n', stderr: '' }
        : { code: 0, stdout: '', stderr: '' },
    )
    const env = await backend.inspectEnv('id')
    expect(env['MYSQL_ROOT_PASSWORD']).toBe('bs_abc123')
    expect(env['PATH']).toBe('/usr/bin')
  })
})

describe('DockerBackend.hostPort', () => {
  it('parses the mapped loopback host port', async () => {
    const { backend } = make(() => ({ code: 0, stdout: '127.0.0.1:53999\n', stderr: '' }))
    expect(await backend.hostPort('id', 3306)).toEqual({ host: '127.0.0.1', port: 53999 })
  })
})

describe('DockerBackend.gc', () => {
  const handler = (argv: readonly string[]) => {
    if (argv[1] === 'ps') {
      const runScoped = argv.some((a) => a.startsWith('label=babystack.run='))
      return { code: 0, stdout: runScoped ? 'id2\n' : 'id1\nid2\nid3\n', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }

  it('reaps every babystack-labeled container', async () => {
    const { runner, backend } = make(handler)
    expect(await backend.gc()).toEqual(['id1', 'id2', 'id3'])
    expect(runner.calls.at(-1)?.argv).toEqual(['docker', 'rm', '-f', '-v', 'id1', 'id2', 'id3'])
  })

  it('spares the current run when exceptRunId is given', async () => {
    const { runner, backend } = make(handler)
    expect(await backend.gc({ exceptRunId: 'r1' })).toEqual(['id1', 'id3'])
    expect(runner.calls.at(-1)?.argv).toEqual(['docker', 'rm', '-f', '-v', 'id1', 'id3'])
  })
})
