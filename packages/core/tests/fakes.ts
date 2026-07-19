import { BabystackError } from '../src/index'
import type {
  Baseline,
  BabystackErrorCode,
  EngineAdapter,
  EnvMap,
  Instance,
  Lease,
  ProvisionSpec,
  SeedSpec,
} from '../src/index'
import type { Clock, CommandOptions, CommandResult, CommandRunner } from '../src/ports'

/** Deterministic clock: `sleep` advances virtual time instantly (no real wall-clock in tests). */
export class FakeClock implements Clock {
  private ms: number
  constructor(startMs = 0) {
    this.ms = startMs
  }
  now(): string {
    return new Date(this.ms).toISOString()
  }
  async sleep(ms: number): Promise<void> {
    this.ms += ms
  }
}

export interface RecordedCommand {
  readonly argv: readonly string[]
  readonly options: CommandOptions | undefined
}

const ok = (): CommandResult => ({ code: 0, stdout: '', stderr: '' })

/** Records every invocation (argv + env) and returns a scripted result. */
export class FakeCommandRunner implements CommandRunner {
  readonly calls: RecordedCommand[] = []
  constructor(private readonly handler: (argv: readonly string[]) => CommandResult = () => ok()) {}
  async run(argv: readonly string[], options?: CommandOptions): Promise<CommandResult> {
    this.calls.push({ argv, options })
    return this.handler(argv)
  }
}

/**
 * In-memory EngineAdapter that records the lifecycle it's driven through and routes its side effects
 * through the injected ports — so a test proves the whole loop composes with zero Docker. Failure
 * injection (`failAt`, `failCloseFor`) exercises the error and cleanup paths.
 */
export class FakeEngineAdapter implements EngineAdapter {
  readonly engine = 'mysql' as const
  readonly events: string[] = []
  /** Method names that should throw a typed error (to exercise failure paths). */
  readonly failAt = new Set<string>()
  /** Database names whose closeLease should throw (to exercise partial releaseAll / dispose). */
  readonly failCloseFor = new Set<string>()

  constructor(
    private readonly clock: Clock,
    private readonly cmd: CommandRunner,
  ) {}

  private guard(method: string, code: BabystackErrorCode): void {
    if (this.failAt.has(method)) throw new BabystackError(code, `fake ${method} failure`)
  }

  async provision(spec: ProvisionSpec): Promise<Instance> {
    this.events.push(`provision:${spec.service}`)
    this.guard('provision', 'PROVISION_FAILED')
    return {
      id: 'fake-1',
      service: spec.service,
      engine: this.engine,
      host: '127.0.0.1',
      port: 53312,
    }
  }

  async waitReady(instance: Instance): Promise<void> {
    this.events.push(`waitReady:${instance.id}`)
    this.guard('waitReady', 'WAIT_READY_TIMEOUT')
    await this.clock.sleep(50)
  }

  async buildBaseline(instance: Instance, spec: SeedSpec): Promise<Baseline> {
    this.events.push('buildBaseline')
    this.guard('buildBaseline', 'BASELINE_BUILD_FAILED')
    for (const command of spec.commands) {
      await this.cmd.run(['sh', '-c', command], { env: spec.env })
    }
    return {
      service: instance.service,
      ref: 'fake-dump.sql',
      checksum: 'sha256:fake',
      createdAt: this.clock.now(),
    }
  }

  async openLease(instance: Instance, _baseline: Baseline, key: string): Promise<Lease> {
    this.events.push(`openLease:${key}`)
    this.guard('openLease', 'LEASE_FAILED')
    const database = `babystack_${instance.service}_w${key}`
    return {
      instance,
      database,
      url: `mysql://root:pw@${instance.host}:${instance.port}/${database}`,
    }
  }

  async closeLease(lease: Lease): Promise<void> {
    this.events.push(`closeLease:${lease.database}`)
    if (this.failCloseFor.has(lease.database)) {
      throw new BabystackError('LEASE_FAILED', `fake closeLease failure for ${lease.database}`)
    }
  }

  env(lease: Lease): EnvMap {
    return { DATABASE_URL: lease.url }
  }

  async dispose(instance: Instance): Promise<void> {
    this.events.push(`dispose:${instance.id}`)
  }

  async logs(): Promise<string> {
    return ''
  }
}
