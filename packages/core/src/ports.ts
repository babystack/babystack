/**
 * Injected ports — the ONLY channels through which babystack reaches time or the outside world.
 * The pure core defines them here and never touches the real clock, randomness, or `child_process`;
 * adapters receive concrete implementations, and tests pass fakes. This is what keeps the core
 * deterministic and Docker-free to unit-test.
 */

/** Wall-clock, injected so nothing reads the real clock directly (determinism, lint-enforced). */
export interface Clock {
  /** Current time as an ISO-8601 string. */
  now(): string
  /** Resolve after `ms` — a fake resolves instantly and advances virtual time. */
  sleep(ms: number): Promise<void>
}

export interface CommandResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export interface CommandOptions {
  /**
   * The COMPLETE environment for the child process. The runner MUST NOT inherit the ambient shell env
   * (never `{ ...process.env }`); if omitted, the child runs with an EMPTY environment. This is the
   * credential boundary — only explicitly-minted vars ever reach a spawned command.
   */
  readonly env?: Readonly<Record<string, string>>
  readonly cwd?: string
  /** Data piped to the child's stdin (e.g. a dump reloaded via `mysql < dump.sql`). */
  readonly stdin?: string
}

/**
 * Runs an external command given as an argv array — never a shell string, so a stray `; rm -rf` in an
 * argument is inert. Every shell-out in babystack flows through this single seam, so tests can assert
 * exact commands (and the env handed to them) while the pure core stays free of `child_process`.
 */
export interface CommandRunner {
  run(argv: readonly string[], options?: CommandOptions): Promise<CommandResult>
}
