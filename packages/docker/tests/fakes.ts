import type { Clock, CommandOptions, CommandResult, CommandRunner } from '@babystack/core'

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

/** Records every invocation (argv + env) and returns a scripted result keyed on argv. */
export class FakeCommandRunner implements CommandRunner {
  readonly calls: RecordedCommand[] = []
  constructor(private readonly handler: (argv: readonly string[]) => CommandResult = ok) {}
  async run(argv: readonly string[], options?: CommandOptions): Promise<CommandResult> {
    this.calls.push({ argv, options })
    return this.handler(argv)
  }
}
