import { BabystackError } from '@babystack/core'
import type { Clock, CommandResult, CommandRunner } from '@babystack/core'
import { dockerEnvAllowlist } from './runtime'

export { NodeCommandRunner, SystemClock, dockerEnvAllowlist } from './runtime'

/** Label every babystack-owned container carries. GC filters strictly on it, so user containers are safe. */
export const OWNER_LABEL = 'babystack'
/**
 * Per-run label. `gc({exceptRunId})` uses it to spare the CALLER's OWN run — note it does NOT spare
 * OTHER concurrent runs (it reaps every babystack container whose run != exceptRunId). Auto-gc-on-start is
 * therefore not yet wired (it would reap a co-running suite's live container); see the roadmap.
 */
export const RUN_LABEL = 'babystack.run'

export interface DockerBackendDeps {
  readonly runner: CommandRunner
  readonly clock: Clock
  /** Minimal env the `docker` CLI is invoked with. Defaults to {@link dockerEnvAllowlist}. */
  readonly dockerEnv?: Readonly<Record<string, string>>
}

export interface ProvisionContainerOptions {
  readonly image: string
  /** Container port to publish (e.g. 3306), bound to an ephemeral 127.0.0.1 host port. */
  readonly containerPort: number
  /** Env baked into the container (e.g. `MYSQL_ROOT_PASSWORD`). */
  readonly env?: Readonly<Record<string, string>>
  /** Extra labels, merged with the babystack owner/run labels. */
  readonly labels?: Readonly<Record<string, string>>
  /** Run id stamped as {@link RUN_LABEL}, so GC can spare this run. */
  readonly runId?: string
}

export interface Container {
  readonly id: string
  readonly host: string
  readonly port: number
}

export interface WaitReadyOptions {
  readonly timeoutMs?: number
  readonly intervalMs?: number
}

export interface GcOptions {
  /** Spare containers stamped with this run id (a live run reaping only OTHER runs' leftovers). */
  readonly exceptRunId?: string
}

/**
 * The generic Docker "muscle": shells out to the `docker` CLI to provision, probe, exec, dispose, and GC
 * real containers. Engine-agnostic — MySQL specifics live in @babystack/mysql, which drives this. Every
 * command flows through the injected {@link CommandRunner}, so it unit-tests against a fake with zero Docker.
 */
export class DockerBackend {
  private readonly runner: CommandRunner
  private readonly clock: Clock
  private readonly dockerEnv: Readonly<Record<string, string>>

  constructor(deps: DockerBackendDeps) {
    this.runner = deps.runner
    this.clock = deps.clock
    this.dockerEnv = deps.dockerEnv ?? dockerEnvAllowlist()
  }

  /** Run a `docker …` command with the minimal docker env (never the ambient/source env). */
  private docker(args: readonly string[], stdin?: string): Promise<CommandResult> {
    const options = stdin === undefined ? { env: this.dockerEnv } : { env: this.dockerEnv, stdin }
    return this.runner.run(['docker', ...args], options)
  }

  /** Is a Docker engine reachable? (Powers `baby doctor`.) Never throws — reports a boolean. */
  async isAvailable(): Promise<boolean> {
    try {
      const { code } = await this.docker(['info'])
      return code === 0
    } catch {
      return false // `docker` not on PATH, etc.
    }
  }

  /** Provision a detached container on an ephemeral loopback port; returns its id + mapped host port. */
  async provision(options: ProvisionContainerOptions): Promise<Container> {
    const args = ['run', '-d', '--label', `${OWNER_LABEL}=1`]
    if (options.runId !== undefined) args.push('--label', `${RUN_LABEL}=${options.runId}`)
    for (const [key, value] of Object.entries(options.labels ?? {}))
      args.push('--label', `${key}=${value}`)
    for (const [key, value] of Object.entries(options.env ?? {})) args.push('-e', `${key}=${value}`)
    // 127.0.0.1:: → loopback-only, kernel-picked free port (never a fixed 3306 that could collide).
    args.push('-p', `127.0.0.1::${options.containerPort}`, options.image)

    const run = await this.docker(args)
    if (run.code !== 0)
      throw new BabystackError('PROVISION_FAILED', `docker run failed: ${run.stderr.trim()}`)
    const id = run.stdout.trim()

    // The container now EXISTS. If anything past here fails (a bad image that exits immediately makes
    // `docker port` return nothing), dispose it before rethrowing — otherwise it leaks (provision runs
    // outside createStack's cleanup, and gc isn't wired into the lifecycle yet).
    try {
      const { host, port } = await this.hostPort(id, options.containerPort)
      return { id, host, port }
    } catch (error) {
      await this.dispose(id).catch(() => {}) // best-effort; don't mask the original failure
      throw error
    }
  }

  /** The loopback host + ephemeral host port a container's port is published on. */
  async hostPort(id: string, containerPort: number): Promise<{ host: string; port: number }> {
    const result = await this.docker(['port', id, `${containerPort}/tcp`])
    if (result.code !== 0)
      throw new BabystackError('PROVISION_FAILED', `docker port failed: ${result.stderr.trim()}`)
    // e.g. "127.0.0.1:53312" (may be several lines for v4/v6) — take the first mapping's host port.
    const mapped = result.stdout.trim().split('\n')[0]?.trim()
    const port = mapped ? Number(mapped.slice(mapped.lastIndexOf(':') + 1)) : NaN
    if (!Number.isInteger(port) || port <= 0) {
      throw new BabystackError(
        'PROVISION_FAILED',
        `could not parse host port from "${result.stdout.trim()}"`,
      )
    }
    return { host: '127.0.0.1', port }
  }

  /** Find RUNNING babystack containers matching ALL given labels — powers cross-invocation discovery. */
  async find(labels: Readonly<Record<string, string>>): Promise<string[]> {
    const filters = Object.entries(labels).flatMap(([k, v]) => ['--filter', `label=${k}=${v}`])
    const result = await this.docker(['ps', '-q', '--no-trunc', ...filters])
    if (result.code !== 0) return []
    return split(result.stdout)
  }

  /**
   * Read a container's baked-in env (name→value). Used to recover the minted `MYSQL_ROOT_PASSWORD` from a
   * container a PRIOR command started — so the password lives only in Docker, never in a babystack file.
   */
  async inspectEnv(id: string): Promise<Record<string, string>> {
    const result = await this.docker(['inspect', '--format', '{{json .Config.Env}}', id])
    if (result.code !== 0)
      throw new BabystackError(
        'PROVISION_FAILED',
        `docker inspect failed for ${id}: ${result.stderr.trim()}`,
      )
    // Guard the parse: `.Config.Env` includes MYSQL_ROOT_PASSWORD, so a malformed payload must NOT reach an
    // error message (a JSON parse error embeds the raw input — that would leak the minted password to logs).
    let entries: string[]
    try {
      entries = JSON.parse(result.stdout.trim() || '[]') as string[]
    } catch {
      throw new BabystackError(
        'PROVISION_FAILED',
        `docker inspect returned unparseable env for ${id}`,
      )
    }
    const env: Record<string, string> = {}
    for (const entry of entries) {
      const eq = entry.indexOf('=')
      if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1)
    }
    return env
  }

  /** Exec a command inside a container (optionally piping stdin). */
  exec(id: string, argv: readonly string[], stdin?: string): Promise<CommandResult> {
    const flags = stdin === undefined ? ['exec'] : ['exec', '-i']
    return this.docker([...flags, id, ...argv], stdin)
  }

  /**
   * Block until an AUTHENTICATED probe succeeds inside the container (exit 0) — NOT a port ping, which
   * passes seconds before the engine accepts connections. Bounded by the injected {@link Clock}.
   */
  async waitReady(
    id: string,
    probe: readonly string[],
    options: WaitReadyOptions = {},
  ): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 30_000
    const intervalMs = options.intervalMs ?? 500
    const deadline = Date.parse(this.clock.now()) + timeoutMs
    for (;;) {
      const { code } = await this.exec(id, probe)
      if (code === 0) return
      if (Date.parse(this.clock.now()) >= deadline) {
        throw new BabystackError(
          'WAIT_READY_TIMEOUT',
          `container ${id} not ready after ${timeoutMs}ms`,
        )
      }
      await this.clock.sleep(intervalMs)
    }
  }

  /** Best-effort container logs (diagnostics). */
  async logs(id: string): Promise<string> {
    const { stdout, stderr } = await this.docker(['logs', id])
    return stdout + stderr
  }

  /**
   * Remove a container AND its volumes. Idempotent: an already-gone container is a success (swallowed),
   * so this is safe on a partially-provisioned or already-disposed instance.
   */
  async dispose(id: string): Promise<void> {
    const { code, stderr } = await this.docker(['rm', '-f', '-v', id])
    if (code === 0) return
    if (/no such container/i.test(stderr)) return // already gone — idempotent success
    throw new BabystackError('DISPOSE_FAILED', `docker rm failed for ${id}: ${stderr.trim()}`)
  }

  /**
   * Reap leftover babystack containers (crashed/killed prior runs). Filters strictly on the owner label
   * so user containers are never touched; `exceptRunId` spares only the run whose id is passed (the
   * caller's own) — every OTHER babystack container is reaped, including a concurrent run's live one, so
   * this is safe to call manually but not (yet) safe to auto-run at startup. Returns the reaped ids.
   */
  async gc(options: GcOptions = {}): Promise<string[]> {
    // `--no-trunc` → full 64-char ids, so they match the id `provision` returns (from `docker run`).
    const list = await this.docker(['ps', '-aq', '--no-trunc', '--filter', `label=${OWNER_LABEL}`])
    if (list.code !== 0) return []
    let ids = split(list.stdout)
    if (options.exceptRunId !== undefined) {
      const filter = `label=${RUN_LABEL}=${options.exceptRunId}`
      const spare = await this.docker(['ps', '-aq', '--no-trunc', '--filter', filter])
      const spared = new Set(split(spare.stdout))
      ids = ids.filter((id) => !spared.has(id))
    }
    if (ids.length > 0) await this.docker(['rm', '-f', '-v', ...ids])
    return ids
  }
}

/** Split docker's newline-separated id output into a clean list. */
function split(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}
