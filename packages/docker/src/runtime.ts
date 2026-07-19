import { spawn } from 'node:child_process'
import type { Clock, CommandOptions, CommandResult, CommandRunner } from '@babystack/core'

/**
 * Runtime implementations of the pure-core ports. The core only ever sees the {@link Clock} /
 * {@link CommandRunner} interfaces; these are the concrete, real-world versions adapters inject.
 * (They live here in @babystack/docker — the lowest real-I/O adapter — until a non-docker consumer
 * needs them independently, at which point they extract to their own runtime package.)
 */

/** Real wall-clock. */
export class SystemClock implements Clock {
  now(): string {
    return new Date().toISOString()
  }
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

/**
 * Real command runner: spawns argv directly (no shell, so a stray `;` in an argument is inert) and
 * captures output. Honors the credential boundary — the child gets ONLY `options.env` (an EMPTY env if
 * omitted), never the ambient process env, so no source/app secret leaks into a spawned command.
 */
export class NodeCommandRunner implements CommandRunner {
  run(argv: readonly string[], options?: CommandOptions): Promise<CommandResult> {
    const [command, ...args] = argv
    if (command === undefined) return Promise.reject(new Error('NodeCommandRunner.run: empty argv'))
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        env: options?.env ?? {}, // empty by default — the credential boundary
        ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
      })
      let stdout = ''
      let stderr = ''
      // setEncoding('utf8') → Node's StringDecoder buffers partial multibyte sequences across chunk
      // boundaries, so a UTF-8 char split by a ~64KB pipe chunk is NOT mangled into U+FFFD. (Per-chunk
      // `Buffer.toString()` would corrupt it — and that corruption would be baked into the cached baseline.)
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => (stdout += chunk))
      child.stderr?.on('data', (chunk: string) => (stderr += chunk))
      child.on('error', reject) // e.g. ENOENT when the binary isn't found on the given PATH
      child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
      child.stdin?.end(options?.stdin ?? undefined)
    })
  }
}

/**
 * The MINIMAL env the `docker` CLI needs to work (find its binary + reach its daemon/context) and nothing
 * more — reconciling "CommandRunner defaults to an empty env" with "docker needs PATH + its context vars",
 * without letting any app/DB secret cross the boundary.
 */
const DOCKER_ENV_KEYS = [
  'PATH',
  'HOME',
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CONFIG',
  'DOCKER_TLS_VERIFY',
  'DOCKER_CERT_PATH',
] as const

export function dockerEnvAllowlist(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of DOCKER_ENV_KEYS) {
    const value = source[key]
    if (value !== undefined) env[key] = value
  }
  return env
}
