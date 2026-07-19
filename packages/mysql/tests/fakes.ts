import type { Clock, CommandOptions, CommandResult, CommandRunner } from '@babystack/core'

/** Deterministic clock: `sleep` advances virtual time instantly. */
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

/** Records every docker invocation and returns a scripted result keyed on argv. */
export class FakeCommandRunner implements CommandRunner {
  readonly calls: { argv: readonly string[]; options: CommandOptions | undefined }[] = []
  constructor(
    private readonly handler: (argv: readonly string[]) => CommandResult = () => ({
      code: 0,
      stdout: '',
      stderr: '',
    }),
  ) {}
  async run(argv: readonly string[], options?: CommandOptions): Promise<CommandResult> {
    this.calls.push({ argv, options })
    return this.handler(argv)
  }
}
