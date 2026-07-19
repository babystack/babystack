/**
 * The core seams. This module is PURE — no I/O, time, or randomness — and imports no sibling adapter.
 * Adapters (docker/mysql/vitest/cli) depend on these types; never the reverse.
 */

/** Engines babystack orchestrates (real) or delegates to LocalStack. Never emulated. */
export type Engine = 'mysql' | 'redis' | 'minio' | 'dynamodb-local' | 'elasticmq' | 'localstack'

/** Phase 0 is test-only. `'dev'` / `'agent'` arrive with later wedges (MCP, Phase 2.5+). */
export type Mode = 'test'

/** Connection info injected into the app/test process, exactly like production. */
export type EnvMap = Readonly<Record<string, string>>

/** What an adapter needs to bring one service up. Decoupled from the user-facing config shape. */
export interface ProvisionSpec {
  readonly service: string
  readonly engine: Engine
  readonly image?: string
}

/** A live, running real engine (one container). Holds many leased databases, keyed per worker. */
export interface Instance {
  readonly id: string
  readonly service: string
  readonly engine: Engine
  readonly host: string
  readonly port: number
  readonly meta?: Readonly<Record<string, unknown>>
}

/**
 * The seeded baseline artifact — built ONCE and reused (Phase 0: a `mysqldump`). This is just DATA; the
 * snapshot MECHANIC lives in the engine adapter. There is no `SnapshotDriver` until a 2nd strategy
 * (copy-on-write) exists to justify the abstraction.
 */
export interface Baseline {
  readonly service: string
  /** Where the artifact lives (e.g. a dump path under `.babystack/cache`). */
  readonly ref: string
  /** Integrity checksum (sha256), computed at build. Verification lands with cross-run cache reuse. */
  readonly checksum: string
  /** ISO-8601. Injected via the {@link Clock} port — the core never reads the wall clock. */
  readonly createdAt: string
  readonly bytes?: number
  /**
   * Content hash over the baseline's inputs (config + build commands + engine image + tool format
   * version + watched migration/seed files) — see {@link computeInvalidationHash}. A cached baseline is
   * only reused when this matches the freshly-computed hash; a mismatch forces a rebuild, so a changed
   * migration/seed can never serve stale seed state (the trust cliff). Optional: the Vitest path rebuilds
   * every run and doesn't set it; the session/CLI path (which reuses across invocations) always does.
   */
  readonly invalidation?: string
}

/**
 * The unit a test worker acquires: a fresh, isolated database loaded from the {@link Baseline}, plus the
 * connection URL to reach it. One `mysqld` ({@link Instance}) holds many leases, one per worker
 * (`VITEST_POOL_ID`). The database is reloaded fresh per test file.
 */
export interface Lease {
  readonly instance: Instance
  /** The per-worker database name (e.g. `babystack_db_w1`). */
  readonly database: string
  /** Connection URL for this lease — disposable, minted creds; never real source credentials. */
  readonly url: string
}

/** How to seed a freshly-provisioned engine into its baseline. */
export interface SeedSpec {
  /** Shell commands run once against a temporary build database (migrate + seed). */
  readonly commands: readonly string[]
  /** The COMPLETE, minted env for those commands — no ambient/source creds cross this boundary. */
  readonly env: EnvMap
}

/**
 * The single interface every engine implements. An adapter either runs the REAL engine (MySQL, Redis,
 * MinIO=S3, …) or drives LocalStack — it must never reimplement a proprietary API. The lifecycle is:
 *
 *   provision → waitReady → buildBaseline → (openLease / closeLease)\* → dispose
 */
export interface EngineAdapter {
  readonly engine: Engine
  provision(spec: ProvisionSpec): Promise<Instance>
  /** Block until the engine truly accepts authenticated connections (not merely a port/ping). */
  waitReady(instance: Instance): Promise<void>
  /** Run the seed commands against a temp DB, then capture the reusable baseline artifact. */
  buildBaseline(instance: Instance, spec: SeedSpec): Promise<Baseline>
  /**
   * Create a FRESH per-worker database loaded from the baseline and return its lease. Two guarantees the
   * {@link Pool} depends on (it tracks one lease per key and does NOT close the prior lease on
   * re-acquire, so a violation leaks databases): the database name MUST be a **deterministic function of
   * `key`** — the same key always maps to the same name, so a re-acquire drops-and-recreates THAT
   * database — and distinct keys MUST map to **distinct** names (worker isolation). Drops-if-exists,
   * then reloads.
   */
  openLease(instance: Instance, baseline: Baseline, key: string): Promise<Lease>
  /** Drop the per-worker database behind a lease. */
  closeLease(lease: Lease): Promise<void>
  /** The disposable connection env for a lease (`DATABASE_URL`, `MYSQL_*`). */
  env(lease: Lease): EnvMap
  /**
   * Tear the instance down (container + volume). MUST be idempotent and safe to call on a
   * partially-provisioned or already-disposed instance (swallow "no such container").
   */
  dispose(instance: Instance): Promise<void>
  logs(instance: Instance): Promise<string>
}

export type BabystackErrorCode =
  | 'CONFIG_INVALID'
  | 'DOCKER_UNAVAILABLE'
  | 'PROVISION_FAILED'
  | 'WAIT_READY_TIMEOUT'
  | 'BASELINE_BUILD_FAILED'
  | 'BASELINE_CORRUPT'
  | 'LEASE_FAILED'
  | 'DISPOSE_FAILED'
  | 'ENV_READ_TOO_EARLY'
  | 'NOT_IMPLEMENTED'

/** Typed error (per the handbook: typed errors over thrown strings). */
export class BabystackError extends Error {
  readonly code: BabystackErrorCode

  constructor(code: BabystackErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'BabystackError'
    this.code = code
  }
}
