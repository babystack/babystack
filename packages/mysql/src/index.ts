import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { BabystackError, redactSecrets } from '@babystack/core'
import type {
  Baseline,
  Clock,
  CommandRunner,
  EngineAdapter,
  EnvMap,
  Instance,
  Lease,
  ProvisionSpec,
  SeedSpec,
} from '@babystack/core'
import { type DockerBackend, OWNER_LABEL } from '@babystack/docker'

/** mysqldump flags: schema-agnostic (no `--databases`), portable, and quiet on GTID/column-stats. */
const DUMP_FLAGS = [
  '--routines',
  '--events',
  '--triggers',
  '--set-gtid-purged=OFF',
  '--column-statistics=0',
  // BLOB/binary columns as hex literals → the dump stays valid ASCII text (no raw bytes to mangle when it
  // round-trips through a string). Correctness guard for the cached baseline (the trust cliff).
  '--hex-blob',
] as const

export interface MysqlAdapterOptions {
  /** Docker image for the real engine (defaults to `mysql:8.4`). Pin it to match prod. */
  readonly image?: string
  /** Port MySQL listens on inside the container (defaults to 3306). */
  readonly containerPort?: number
  /** Where baseline dumps are cached (defaults to `.babystack/cache`). */
  readonly cacheDir?: string
}

export interface MysqlAdapterDeps {
  /** The generic Docker muscle this adapter drives. */
  readonly docker: DockerBackend
  readonly clock: Clock
  /** Runs the host-side seed commands (migrate/seed). Injected; kept off Docker for that path. */
  readonly runner: CommandRunner
  /** Mint a disposable root password. Injected so tests are deterministic. */
  readonly mintSecret?: () => string
  /** Run id stamped on containers for GC scoping. */
  readonly runId?: string
  /** Extra labels stamped on provisioned containers AND used by {@link MysqlAdapter.discover} to find them
   * again across CLI invocations (e.g. `{ 'babystack.project': <hash> }`). */
  readonly labels?: Readonly<Record<string, string>>
  readonly options?: MysqlAdapterOptions
}

/**
 * Real-MySQL engine adapter. Orchestrates an actual `mysql:8.4` container via the injected
 * {@link DockerBackend} — never emulates. Lifecycle: provision → authenticated `waitReady` →
 * `buildBaseline` (run your seed commands against a temp build DB, then `mysqldump` it) → per-worker
 * `openLease`/`closeLease` (a fresh DB loaded from the dump) → `dispose`.
 */
export class MysqlAdapter implements EngineAdapter {
  readonly engine = 'mysql' as const
  private readonly docker: DockerBackend
  private readonly clock: Clock
  private readonly runner: CommandRunner
  private readonly mintSecret: () => string
  private readonly image: string
  private readonly containerPort: number
  private readonly cacheDir: string
  private readonly runId: string | undefined
  private readonly labels: Readonly<Record<string, string>>

  constructor(deps: MysqlAdapterDeps) {
    this.docker = deps.docker
    this.clock = deps.clock
    this.runner = deps.runner
    this.mintSecret = deps.mintSecret ?? defaultMintSecret
    this.labels = deps.labels ?? {}
    this.image = deps.options?.image ?? 'mysql:8.4'
    this.containerPort = deps.options?.containerPort ?? 3306
    // Absolute: a Baseline.ref built from this is dereferenced in WORKER processes (via provide/inject),
    // whose cwd may differ from the main process that wrote it — a relative ref would ENOENT there.
    this.cacheDir = resolve(deps.options?.cacheDir ?? '.babystack/cache')
    this.runId = deps.runId
  }

  async provision(spec: ProvisionSpec): Promise<Instance> {
    const password = this.mintSecret() // disposable, per-instance — never a real credential
    const container = await this.docker.provision({
      image: spec.image ?? this.image,
      containerPort: this.containerPort,
      env: { MYSQL_ROOT_PASSWORD: password },
      labels: this.labels, // e.g. the project label, so a later `baby` command can rediscover this container
      ...(this.runId !== undefined ? { runId: this.runId } : {}),
    })
    // Stash the minted password in meta so waitReady/env can authenticate; it never hits a log.
    return {
      id: container.id,
      service: spec.service,
      engine: this.engine,
      host: container.host,
      port: container.port,
      meta: { password },
    }
  }

  /**
   * Discover a RUNNING container that this adapter's {@link MysqlAdapterDeps.labels} identify (started by a
   * PRIOR command, e.g. `baby wake`) and reconstruct its {@link Instance}. The minted password is recovered
   * from the container's own env via `docker inspect` — so it lives only in Docker, never in a babystack
   * file. Returns `undefined` if nothing matching is up.
   */
  async discover(service: string): Promise<Instance | undefined> {
    const [id] = await this.docker.find({ [OWNER_LABEL]: '1', ...this.labels })
    if (id === undefined) return undefined
    const { host, port } = await this.docker.hostPort(id, this.containerPort)
    const password = (await this.docker.inspectEnv(id))['MYSQL_ROOT_PASSWORD']
    if (password === undefined) {
      throw new BabystackError('PROVISION_FAILED', `container ${id} is missing MYSQL_ROOT_PASSWORD`)
    }
    return { id, service, engine: this.engine, host, port, meta: { password } }
  }

  async waitReady(instance: Instance): Promise<void> {
    // Authenticated `SELECT 1` inside the container — a port ping would pass too early. Crucially, probe
    // over TCP (`-h 127.0.0.1`), not the default unix socket: the mysql image runs a temporary
    // `--skip-networking` server during data-dir init that DOES accept socket connections, so a socket
    // probe can pass, then the real server restarts and briefly refuses — the `ERROR 2002` init race. TCP
    // is refused until the real, networked server is truly up, so this gate can't fire early.
    const password = rootPassword(instance)
    await this.docker.waitReady(instance.id, [
      'mysql',
      '-h',
      '127.0.0.1',
      '-uroot',
      `-p${password}`,
      '-e',
      'SELECT 1',
    ])
  }

  async buildBaseline(instance: Instance, spec: SeedSpec): Promise<Baseline> {
    const password = rootPassword(instance)
    const buildDb = `babystack_${instance.service}_build`

    // 1. A fresh, empty build database.
    await this.sql(
      instance,
      `DROP DATABASE IF EXISTS \`${buildDb}\`; CREATE DATABASE \`${buildDb}\``,
      'BASELINE_BUILD_FAILED',
    )

    // 2. Run the user's seed commands on the host against the build DB, in a SCRUBBED env: only the
    //    caller-approved basics (spec.env) + the minted build-DB creds — no ambient/source creds leak.
    //    The minted creds are spread LAST so they always win over any decoy in spec.env.
    const buildEnv: EnvMap = {
      ...spec.env,
      ...mysqlEnv(instance.host, instance.port, buildDb, password),
    }
    for (const command of spec.commands) {
      const result = await this.runner.run(['sh', '-c', command], { env: buildEnv })
      if (result.code !== 0) {
        // Redact secret-shaped output (+ the minted password) — a seed may print a real credential to
        // stderr, and this message flows into build errors that reach CI logs.
        throw new BabystackError(
          'BASELINE_BUILD_FAILED',
          redactSecrets(`seed command failed (${command}): ${result.stderr.trim()}`, [password]),
        )
      }
    }

    // 3. mysqldump the seeded build DB (inside the container), normalize DEFINERs, cache it + checksum.
    const dump = await this.dump(instance, buildDb)
    const ref = join(this.cacheDir, 'baselines', instance.service, 'dump.sql')
    await mkdir(dirname(ref), { recursive: true })
    const checksum = `sha256:${sha256(dump)}`
    // Atomic publish: write a unique temp, then rename onto `ref`. A crashed or concurrent write can never
    // leave a torn/partial dump at `ref` — a partial baseline would corrupt every worker (the trust cliff).
    const tmp = `${ref}.${randomBytes(6).toString('hex')}.tmp`
    await writeFile(tmp, dump, 'utf8')
    await rename(tmp, ref)

    // 4. Drop the build DB — per-worker leases load from the cached dump, not from it.
    await this.sql(instance, `DROP DATABASE IF EXISTS \`${buildDb}\``, 'BASELINE_BUILD_FAILED')

    return {
      service: instance.service,
      ref,
      checksum,
      createdAt: this.clock.now(),
      bytes: Buffer.byteLength(dump),
    }
  }

  /** The deterministic per-key database name (`babystack_<service>_w<key>`). Injective across keys. */
  private databaseName(instance: Instance, key: string): string {
    return `babystack_${instance.service}_w${key}`
  }

  /** Does a database already exist on this instance? (The session layer's non-destructive `ensureLease`
   * uses this so `baby home` can return a URL without wiping an agent's in-progress work.) */
  private async databaseExists(instance: Instance, database: string): Promise<boolean> {
    const password = rootPassword(instance)
    const result = await this.docker.exec(instance.id, [
      'mysql',
      '-uroot',
      `-p${password}`,
      '-N',
      '-e',
      `SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = '${database}'`,
    ])
    return result.code === 0 && result.stdout.trim().startsWith('1')
  }

  /**
   * NON-DESTRUCTIVE lease: return the env for `key`'s database, creating + seeding it from the baseline
   * ONLY if it doesn't already exist. Unlike {@link openLease} (always fresh), re-calling this never wipes
   * state — so `baby home` can be run repeatedly to recover the URL without destroying agent work.
   */
  async ensureLease(instance: Instance, baseline: Baseline, key: string): Promise<Lease> {
    const database = this.databaseName(instance, key)
    if (await this.databaseExists(instance, database)) {
      const url = mysqlUrl(instance.host, instance.port, database, rootPassword(instance))
      return { instance, database, url }
    }
    return this.openLease(instance, baseline, key)
  }

  async openLease(instance: Instance, baseline: Baseline, key: string): Promise<Lease> {
    const password = rootPassword(instance)
    const database = this.databaseName(instance, key) // deterministic per key; injective across keys
    // Drop-if-exists then recreate → a re-acquire of the same key gets a fresh DB (Pool relies on this).
    await this.sql(
      instance,
      `DROP DATABASE IF EXISTS \`${database}\`; CREATE DATABASE \`${database}\``,
      'LEASE_FAILED',
    )
    // Load the cached baseline dump — but VERIFY its integrity first. A corrupt or truncated cache must
    // fail loud (BASELINE_CORRUPT), never load silently-wrong seed state into a worker (the trust cliff).
    const dump = await readFile(baseline.ref, 'utf8')
    const actual = `sha256:${sha256(dump)}`
    if (actual !== baseline.checksum) {
      throw new BabystackError(
        'BASELINE_CORRUPT',
        `baseline at ${baseline.ref} failed its integrity check (expected ${baseline.checksum}, got ${actual}) — the cache is corrupt or truncated; rebuild it.`,
      )
    }
    const load = await this.docker.exec(
      instance.id,
      ['mysql', '-uroot', `-p${password}`, database],
      dump,
    )
    if (load.code !== 0) {
      throw new BabystackError(
        'LEASE_FAILED',
        redactSecrets(`baseline load failed for ${database}: ${load.stderr.trim()}`, [password]),
      )
    }
    return {
      instance,
      database,
      url: mysqlUrl(instance.host, instance.port, database, password),
    }
  }

  async closeLease(lease: Lease): Promise<void> {
    await this.sql(lease.instance, `DROP DATABASE IF EXISTS \`${lease.database}\``, 'LEASE_FAILED')
  }

  env(lease: Lease): EnvMap {
    const { instance, database } = lease
    return mysqlEnv(instance.host, instance.port, database, rootPassword(instance))
  }

  async dispose(instance: Instance): Promise<void> {
    await this.docker.dispose(instance.id)
  }

  async logs(instance: Instance): Promise<string> {
    return this.docker.logs(instance.id)
  }

  /** Run a SQL statement inside the container as root; throw the given code on failure. */
  private async sql(
    instance: Instance,
    statement: string,
    code: 'BASELINE_BUILD_FAILED' | 'LEASE_FAILED',
  ): Promise<void> {
    const password = rootPassword(instance)
    const result = await this.docker.exec(instance.id, [
      'mysql',
      '-uroot',
      `-p${password}`,
      '-e',
      statement,
    ])
    if (result.code !== 0) {
      throw new BabystackError(
        code,
        redactSecrets(`mysql failed: ${result.stderr.trim()}`, [password]),
      )
    }
  }

  /** `mysqldump` the given database inside the container and return the normalized SQL text. */
  private async dump(instance: Instance, database: string): Promise<string> {
    const password = rootPassword(instance)
    const result = await this.docker.exec(instance.id, [
      'mysqldump',
      '-uroot',
      `-p${password}`,
      ...DUMP_FLAGS,
      database,
    ])
    if (result.code !== 0) {
      throw new BabystackError(
        'BASELINE_BUILD_FAILED',
        redactSecrets(`mysqldump failed: ${result.stderr.trim()}`, [password]),
      )
    }
    return normalizeDefiners(result.stdout)
  }
}

/** Hex sha256 of text — the baseline integrity checksum (computed at build, verified before every load). */
function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Read the minted root password an instance was provisioned with. */
function rootPassword(instance: Instance): string {
  const password = instance.meta?.['password']
  if (typeof password !== 'string') {
    throw new BabystackError('PROVISION_FAILED', 'instance is missing its minted root password')
  }
  return password
}

/** The `mysql://root:…` connection URL for a database on an instance. */
function mysqlUrl(host: string, port: number, database: string, password: string): string {
  return `mysql://root:${password}@${host}:${port}/${database}`
}

/** The disposable connection env (DATABASE_URL + MYSQL_*) for a database — the single source of truth. */
function mysqlEnv(host: string, port: number, database: string, password: string): EnvMap {
  return {
    DATABASE_URL: mysqlUrl(host, port, database, password),
    MYSQL_HOST: host,
    MYSQL_PORT: String(port),
    MYSQL_USER: 'root',
    MYSQL_PASSWORD: password,
    MYSQL_DATABASE: database,
  }
}

/**
 * Strip `DEFINER=`user`@`host`` clauses so a dump reloads cleanly under a different user. Anchored to
 * mysqldump's executable version-comment context (`/*!NNNNN ...`, the ONLY place mysqldump emits DEFINER),
 * so an identical substring living inside INSERT row data is left untouched — corrupting seed data would
 * violate the "app can't tell it's in a test" invariant.
 */
export function normalizeDefiners(sql: string): string {
  return sql.replace(/(?<=\/\*!\d+) DEFINER=`[^`]*`@`[^`]*`/g, '')
}

/** Default: 24 hex chars of CSPRNG, prefixed so it's recognizable in a disposable URL. */
function defaultMintSecret(): string {
  return `bs_${randomBytes(12).toString('hex')}`
}
