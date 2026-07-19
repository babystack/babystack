import { describe, expect, it } from 'vitest'
import { NodeCommandRunner, SystemClock, dockerEnvAllowlist } from '../src/runtime'

describe('dockerEnvAllowlist', () => {
  it('keeps only docker-relevant vars and drops ambient secrets', () => {
    const env = dockerEnvAllowlist({
      PATH: '/bin',
      HOME: '/home/x',
      DATABASE_URL: 'mysql://secret',
      MYSQL_PASSWORD: 'secret',
    })
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/x' })
  })
})

describe('NodeCommandRunner', () => {
  const runner = new NodeCommandRunner()
  const node = (script: string) => [process.execPath, '-e', script] // absolute path → no PATH needed

  it('runs argv and captures stdout + exit code', async () => {
    const res = await runner.run(node('process.stdout.write("hi")'))
    expect(res).toMatchObject({ code: 0, stdout: 'hi' })
  })

  it('passes ONLY the given env — empty by default (the credential boundary)', async () => {
    const script = 'process.stdout.write(process.env.FOO ?? "none")'
    expect((await runner.run(node(script), { env: { FOO: 'bar' } })).stdout).toBe('bar')
    expect((await runner.run(node(script))).stdout).toBe('none')
  })

  it('pipes stdin to the child', async () => {
    const res = await runner.run(node('process.stdin.pipe(process.stdout)'), { stdin: 'echoed' })
    expect(res.stdout).toBe('echoed')
  })

  it('reassembles a multibyte char split across stream chunks (no U+FFFD corruption)', async () => {
    // Emit the two bytes of 'é' (0xC3 0xA9) in separate ticks → two 'data' events. A per-chunk
    // Buffer.toString() decodes each half to U+FFFD; setEncoding('utf8') buffers the split → 'é'.
    const script =
      'process.stdout.write(Buffer.from([0xc3]));setTimeout(()=>process.stdout.write(Buffer.from([0xa9])),15)'
    expect((await runner.run(node(script))).stdout).toBe('é')
  })
})

describe('SystemClock', () => {
  it('reports an ISO timestamp and sleeps', async () => {
    const clock = new SystemClock()
    expect(Number.isNaN(Date.parse(clock.now()))).toBe(false)
    await expect(clock.sleep(1)).resolves.toBeUndefined()
  })
})
