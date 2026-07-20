import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  BabystackError,
  BASELINE_FORMAT_VERSION,
  computeInvalidationHash,
  createStack,
  defineConfig,
} from '@babystack/core'
import { glob } from 'tinyglobby'
import type {
  Baseline,
  BabystackConfig,
  EngineAdapter,
  EnvMap,
  Instance,
  MysqlService,
  ProvisionSpec,
  SeedSpec,
  Stack,
  TestPolicy,
} from '@babystack/core'
import { DockerBackend, NodeCommandRunner, SystemClock } from '@babystack/docker'
import { MysqlAdapter } from '@babystack/mysql'

/** How to tear down the stack at the end of a run (from `service.test.cleanup`; default `'destroy'`). */
export type CleanupMode = NonNullable<TestPolicy['cleanup']>

/**
 * The minimal env a baseline `build` (migrate/seed) command may see — the credential boundary. Only these
 * safe basics from the ambient env are passed; the MySQL adapter adds the minted build-DB creds. No app/DB
 * secret from the ambient env crosses into a seed command. (Broader passthrough is a Phase-1 allowlist.)
 */
const BUILD_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR'] as const

export function buildEnvAllowlist(
  source: Readonly<Record<string, string | undefined>> = process.env,
): EnvMap {
  const env: Record<string, string> = {}
  for (const key of BUILD_ENV_KEYS) {
    const value = source[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

/** Pick the single MySQL service. Phase 0: exactly one service, and it must be `mysql`. */
export function resolveMysqlService(config: BabystackConfig): {
  name: string
  service: MysqlService
} {
  const names = Object.keys(config.services ?? {})
  const [name, ...rest] = names
  if (name === undefined || rest.length > 0) {
    throw new BabystackError(
      'CONFIG_INVALID',
      `Phase 0 supports exactly one service; got ${names.length}.`,
    )
  }
  const service = config.services[name]
  if (service === undefined || service.engine !== 'mysql') {
    throw new BabystackError(
      'CONFIG_INVALID',
      `Phase 0 supports only the 'mysql' engine; service "${name}" is '${service?.engine}'.`,
    )
  }
  return { name, service }
}

/** The adapter image option — present only when the config pins one (honours exactOptionalPropertyTypes). */
function imageOption(service: MysqlService): { image?: string } {
  return service.image !== undefined ? { image: service.image } : {}
}

/** Config → the adapter-facing provision spec. */
export function toProvisionSpec(name: string, service: MysqlService): ProvisionSpec {
  return service.image !== undefined
    ? { service: name, engine: 'mysql', image: service.image }
    : { service: name, engine: 'mysql' }
}

/** Config → the seed spec (commands + the scrubbed build env). */
export function toSeedSpec(service: MysqlService): SeedSpec {
  return { commands: service.baseline?.build ?? [], env: buildEnvAllowlist() }
}

export interface AdapterOptions {
  readonly runId?: string
  readonly image?: string
  readonly cacheDir?: string
  /** Labels stamped on the container AND used to rediscover it later (e.g. `{ 'babystack.project': id }`). */
  readonly labels?: Readonly<Record<string, string>>
}

/** Construct a real MySQL adapter over the Docker backend + runtime ports. */
export function createMysqlAdapter(options: AdapterOptions = {}): MysqlAdapter {
  const runner = new NodeCommandRunner()
  const clock = new SystemClock()
  const docker = new DockerBackend({ runner, clock })
  return new MysqlAdapter({
    docker,
    clock,
    runner,
    ...(options.runId !== undefined ? { runId: options.runId } : {}),
    ...(options.labels !== undefined ? { labels: options.labels } : {}),
    options: {
      ...(options.image !== undefined ? { image: options.image } : {}),
      ...(options.cacheDir !== undefined ? { cacheDir: options.cacheDir } : {}),
    },
  })
}

/** Fail fast with a typed, actionable error if the Docker engine isn't reachable. */
async function ensureDockerAvailable(): Promise<void> {
  const docker = new DockerBackend({ runner: new NodeCommandRunner(), clock: new SystemClock() })
  if (!(await docker.isAvailable())) {
    throw new BabystackError(
      'DOCKER_UNAVAILABLE',
      'Docker engine is not reachable — is it running? Check with `docker info`.',
    )
  }
}

/** Resolve the config path consistently: explicit arg → `$BABYSTACK_CONFIG` → `./babystack.config.ts`. */
function resolveConfigPath(configPath?: string): string {
  return resolve(process.cwd(), configPath ?? process.env.BABYSTACK_CONFIG ?? 'babystack.config.ts')
}

/** Load `babystack.config.ts` (default export). Path via `$BABYSTACK_CONFIG` or `./babystack.config.ts`. */
export async function loadConfig(configPath?: string): Promise<BabystackConfig> {
  const abs = resolveConfigPath(configPath)
  const mod = (await import(pathToFileURL(abs).href)) as { default?: BabystackConfig }
  if (mod.default === undefined) {
    throw new BabystackError('CONFIG_INVALID', `${abs} must default-export defineConfig({ ... }).`)
  }
  // Re-run defineConfig's guards at the load boundary. A hand-authored `export default { ... }` (or a config
  // assembled without defineConfig) would otherwise skip the service-name/engine validation — letting an
  // unsafe name reach a filesystem path or a backtick-quoted SQL identifier. Idempotent for a config already
  // wrapped in defineConfig, so it's safe to always apply.
  return defineConfig(mod.default)
}

/**
 * COLD PATH (globalSetup, once): resolve the config, then provision → waitReady → buildBaseline. Returns the
 * {@link Stack} plus how to tear it down — the caller provides `{instance, baseline}` to workers and
 * disposes (or keeps) it at teardown per {@link CleanupMode}.
 */
export async function provisionStack(
  config?: BabystackConfig,
): Promise<{ stack: Stack; cleanup: CleanupMode }> {
  const cfg = config ?? (await loadConfig())
  const { name, service } = resolveMysqlService(cfg)
  await ensureDockerAvailable()
  const runId = `bs_${randomBytes(6).toString('hex')}`
  // Scope the baseline cache dir by runId (not just the container): the Vitest path rebuilds every run, so
  // two concurrent `vitest` invocations in one project (watch mode in two terminals; a focused run during a
  // full run) would otherwise race on the SAME `.babystack/cache/baselines/<svc>/dump.sql` and trip a
  // spurious BASELINE_CORRUPT. A per-run dir keeps them isolated.
  const adapter = createMysqlAdapter({
    runId,
    cacheDir: resolve('.babystack/cache', 'runs', runId),
    ...imageOption(service),
  })
  const stack = await createStack({ adapter }, toProvisionSpec(name, service), toSeedSpec(service))
  return { stack, cleanup: service.test?.cleanup ?? 'destroy' }
}

/**
 * HOT PATH (setupFiles, per file, in each worker): open a FRESH per-worker database from the baseline and
 * return the disposable connection env. Destructive by design — each call drops + reloads the key's DB.
 */
export async function leaseEnv(
  instance: Instance,
  baseline: Baseline,
  key: string,
): Promise<EnvMap> {
  const adapter = createMysqlAdapter()
  const lease = await adapter.openLease(instance, baseline, key)
  return adapter.env(lease)
}

/**
 * NON-DESTRUCTIVE session variant: return the env for `key`'s database, creating + seeding it from the
 * baseline ONLY if absent. `baby home` uses this so re-running it recovers the URL without wiping the
 * agent's in-progress work (only `baby reset`, via {@link leaseEnv}, wipes).
 */
export async function ensureEnv(
  instance: Instance,
  baseline: Baseline,
  key: string,
): Promise<EnvMap> {
  const adapter = createMysqlAdapter()
  const lease = await adapter.ensureLease(instance, baseline, key)
  return adapter.env(lease)
}

// ── CLI session layer (baby wake / home / reset / sleep) ─────────────────────────────────────────────
// The engine's container is detached (`docker run -d`), so it SURVIVES the process that started it. These
// helpers let a later command rediscover it (by a stable per-project label) instead of re-provisioning.

const PROJECT_LABEL = 'babystack.project'

/** A stable id for THIS project (a hash of the ABSOLUTE config path), stamped as a label so `baby home` /
 * `reset` / `sleep` find the exact container `baby wake` started — even across separate processes. */
export function projectId(configPath?: string): string {
  return createHash('sha256').update(resolveConfigPath(configPath)).digest('hex').slice(0, 12)
}

/**
 * Per-project cache root — namespaced by {@link projectId} so two different configs in one directory (even
 * sharing a service key like `db`) never share a baseline dump/sidecar. Without this, project A could load
 * project B's seed while the integrity check still passes — the exact "cache serves wrong seed" trust cliff.
 * (The Vitest path rebuilds per run and scopes BOTH its container and its cache dir by `runId` — see
 * {@link provisionStack} — so it never shares this per-project dir.)
 */
function sessionCacheDir(id: string): string {
  return resolve('.babystack/cache', 'projects', id)
}

function sessionAdapter(
  config: BabystackConfig,
  id: string,
): { adapter: MysqlAdapter; name: string; service: MysqlService; cacheDir: string } {
  const { name, service } = resolveMysqlService(config)
  const cacheDir = sessionCacheDir(id)
  const adapter = createMysqlAdapter({
    labels: { [PROJECT_LABEL]: id },
    cacheDir,
    ...imageOption(service),
  })
  return { adapter, name, service, cacheDir }
}

// The baseline metadata sidecar — {ref, checksum, …}, NO secrets — so a later `baby home` can reload +
// integrity-check the baseline without re-running the seed. Lives beside the dump in the project cache dir.
function baselineSidecarPath(cacheDir: string, service: string): string {
  return resolve(cacheDir, 'baselines', service, 'baseline.json')
}
async function writeBaselineSidecar(
  cacheDir: string,
  service: string,
  baseline: Baseline,
): Promise<void> {
  // Write through the SAME path helper that readBaselineSidecar reads from — one derivation, so the write
  // and read can never diverge (a divergence would be a silent permanent cache miss, or a read of the wrong
  // file). It resolves to `<cacheDir>/baselines/<service>/baseline.json`, beside the adapter's dump.
  const path = baselineSidecarPath(cacheDir, service)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(baseline, null, 2), 'utf8')
}
async function readBaselineSidecar(
  cacheDir: string,
  service: string,
): Promise<Baseline | undefined> {
  try {
    return JSON.parse(await readFile(baselineSidecarPath(cacheDir, service), 'utf8')) as Baseline
  } catch {
    return undefined // absent/unreadable → treated as "no baseline yet"
  }
}

/**
 * The current invalidation hash for this project's baseline: config text + build commands + engine image +
 * baseline-format version + the CONTENTS of every `invalidateWhenChanged` glob. A cached baseline whose
 * stored `invalidation` differs from this must be rebuilt — never serve stale seed (the trust cliff).
 * Reading files/globs is I/O and lives here (the caller), keeping core's {@link computeInvalidationHash} pure.
 */
export async function resolveInvalidation(
  service: MysqlService,
  configPath?: string,
): Promise<string> {
  const abs = resolveConfigPath(configPath)
  const configText = await readFile(abs, 'utf8').catch(() => JSON.stringify(service))
  const patterns = service.baseline?.invalidateWhenChanged ?? []
  const files: { path: string; contents: string }[] = []
  if (patterns.length > 0) {
    const cwd = dirname(abs)
    // Relative paths (not absolute) so the hash is stable across machines; computeInvalidationHash sorts.
    // `dot: true`: a wildcard like `**/*.sql` MUST still see migrations/seeds kept under a dot-directory
    // (`.db/`, `.migrations/`). Missing them would UNDER-invalidate (a changed seed goes unnoticed) — the
    // stale-serve direction the trust cliff forbids; over-matching a stray dotfile only over-invalidates.
    const matches = await glob([...patterns], { cwd, dot: true, onlyFiles: true })
    for (const rel of matches) {
      const contents = await readFile(resolve(cwd, rel), 'utf8').catch(() => undefined)
      if (contents !== undefined) files.push({ path: rel, contents })
    }
  }
  return computeInvalidationHash({
    configText,
    files,
    engineImage: service.image ?? '', // unpinned → the adapter default, captured by the format version
    toolVersion: BASELINE_FORMAT_VERSION,
    buildCommands: service.baseline?.build ?? [],
  })
}

/** Explicit cache opt-out: `BABYSTACK_NO_CACHE` (any truthy value) forces a rebuild even on a hash match.
 * `undefined`/`''`/`'0'`/`'false'` (case-insensitive) are NOT truthy; anything else is. Exported for tests. */
export function cacheDisabled(): boolean {
  const v = process.env.BABYSTACK_NO_CACHE
  return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false'
}

/**
 * Reuse a cached baseline ONLY when it exists, its stored hash matches the current inputs, and no explicit
 * opt-out (`--rebuild` / `$BABYSTACK_NO_CACHE`) is in force. Any mismatch → rebuild; never serve stale seed
 * (the trust cliff). Pure — exported for unit tests.
 */
export function shouldReuseBaseline(
  cached: Baseline | undefined,
  wantHash: string,
  force: boolean,
): boolean {
  return !force && cached !== undefined && cached.invalidation === wantHash
}

export interface WokenStack {
  readonly instance: Instance
  readonly baseline: Baseline
  readonly alreadyRunning: boolean
}

/** Options for {@link wake}. `rebuild` (from `baby wake --rebuild`) forces a fresh baseline build even when
 * the cached one is still valid — the explicit escape hatch alongside `$BABYSTACK_NO_CACHE`. */
export interface WakeOptions {
  readonly rebuild?: boolean
}

/**
 * The engine surface the CLI session layer ({@link wake}/{@link findRunning}/{@link sleep}) drives: the
 * {@link EngineAdapter} lifecycle plus `discover` (rediscover a container a prior command left running).
 * A {@link MysqlAdapter} satisfies it. Named so {@link wakeWith} can be exercised with a fake — no Docker.
 */
export type SessionEngine = Pick<
  EngineAdapter,
  'provision' | 'waitReady' | 'buildBaseline' | 'dispose'
> & {
  discover(service: string): Promise<Instance | undefined>
}

/** The already-resolved session deps {@link wakeWith} operates on — the adapter + its project name/service/
 * cache dir + the freshly-computed invalidation hash. {@link wake} builds these from config; tests fake them. */
export interface WakeDeps {
  readonly adapter: SessionEngine
  readonly name: string
  readonly service: MysqlService
  readonly cacheDir: string
  readonly wantHash: string
}

/**
 * The wake ORCHESTRATION, decoupled from adapter construction, the Docker preflight, config loading, and
 * invalidation hashing (all of which {@link wake} does first). Given a running-or-not engine it: reuses an
 * already-running container when its baseline still matches; disposes + re-provisions when inputs changed,
 * when a rebuild was forced, OR when the discovered container isn't accepting connections; and disposes on
 * partial init so a failed wake never leaks a container. Exported so this whole branch matrix is unit-testable
 * with a fake engine + a temp cache dir; production goes through {@link wake}.
 */
export async function wakeWith(deps: WakeDeps, options: WakeOptions = {}): Promise<WokenStack> {
  const { adapter, name, service, cacheDir, wantHash } = deps
  // Cross-run baseline reuse is only SAFE when we can detect input changes. If the service runs `build`
  // commands but declares NO `invalidateWhenChanged` globs, the hash can't see an edited migration/seed —
  // reusing would risk serving stale seed (the trust cliff). So force a rebuild instead; declaring the
  // globs re-enables fast reuse. (A service with no build commands has nothing to go stale.)
  const buildCmds = service.baseline?.build ?? []
  const watched = service.baseline?.invalidateWhenChanged ?? []
  const reuseUnsafe = buildCmds.length > 0 && watched.length === 0
  const force = options.rebuild === true || cacheDisabled() || reuseUnsafe

  // Build a fresh baseline against `instance`, stamp it with the current hash, and persist the sidecar.
  const buildAndRecord = async (instance: Instance): Promise<Baseline> => {
    const built = await adapter.buildBaseline(instance, toSeedSpec(service))
    const baseline: Baseline = { ...built, invalidation: wantHash }
    await writeBaselineSidecar(cacheDir, name, baseline)
    return baseline
  }

  const existing = await adapter.discover(name)
  if (existing) {
    // The container persists across processes, but confirm mysqld is actually accepting connections before
    // reusing it. A discovered-but-unready container (mid-boot after a host reboot, or wedged) must NOT
    // wedge EVERY future `wake` with a WAIT_READY_TIMEOUT it can't recover from — dispose it and fall
    // through to a fresh provision, exactly as if nothing had been running.
    let ready = false
    try {
      await adapter.waitReady(existing)
      ready = true
    } catch {
      await adapter.dispose(existing).catch(() => {})
    }
    if (ready) {
      const cached = await readBaselineSidecar(cacheDir, name)
      // Reuse ONLY when the cached baseline's hash matches the current inputs (and no explicit opt-out).
      if (cached !== undefined && shouldReuseBaseline(cached, wantHash, force)) {
        return { instance: existing, baseline: cached, alreadyRunning: true }
      }
      // The inputs changed (or a rebuild was forced). Rebuilding just the dump is NOT enough: the running
      // container still holds the per-key session databases `baby home` already created (seeded from the OLD
      // baseline), and a changed `image` means the engine itself is now wrong — so `home` would keep serving
      // stale seed off a stale engine (the trust cliff). Dispose the whole container and fall through to a
      // full fresh provision: current image, freshly-built baseline, and no stale session DBs to leak.
      await adapter.dispose(existing)
    }
  }

  const instance = await adapter.provision(toProvisionSpec(name, service))
  try {
    await adapter.waitReady(instance)
    const baseline = await buildAndRecord(instance)
    return { instance, baseline, alreadyRunning: false }
  } catch (error) {
    // Partial init after the container came up — dispose it so a failed `wake` never leaks a container
    // (mirrors createStack's dispose-on-partial-init). Best-effort: never mask the original failure.
    try {
      await adapter.dispose(instance)
    } catch {
      /* swallow — surfacing the original failure matters more */
    }
    throw error
  }
}

/** `baby wake`: provision + seed the baseline and LEAVE the container running, or return the already-running
 * one (idempotent). The container persists after this process exits (detached), for later `baby home`.
 *
 * `wake` is the command that ESTABLISHES/refreshes the baseline. When the invalidation hash (config + build
 * commands + image + watched migration/seed file contents) still matches the cached one it reuses in place;
 * otherwise it DISPOSES the running container and re-provisions a fully fresh stack — new engine image,
 * freshly-built baseline, and no leftover per-key session databases. That whole-stack replacement is what
 * makes the guarantee real end-to-end: after changing a migration/seed and re-running `baby wake`, the next
 * `baby home` serves the NEW seed, never a stale cached one (the trust cliff). Because a rebuild replaces the
 * container, its host port (and thus the `home` URL) can change — re-run `baby home` after an input change.
 *
 * This is the imperative shell: it resolves config → adapter, does the Docker preflight, and computes the
 * invalidation hash, then hands off to {@link wakeWith} for the (unit-tested) orchestration. */
export async function wake(
  config?: BabystackConfig,
  configPath?: string,
  options: WakeOptions = {},
): Promise<WokenStack> {
  const cfg = config ?? (await loadConfig(configPath))
  const { adapter, name, service, cacheDir } = sessionAdapter(cfg, projectId(configPath))
  await ensureDockerAvailable()
  const wantHash = await resolveInvalidation(service, configPath)
  return wakeWith({ adapter, name, service, cacheDir, wantHash }, options)
}

/** Discover the running container for this project + its baseline (for `baby home`/`reset`). Undefined if
 * asleep. `stale` = the seed inputs changed since this baseline was built with `baby wake`. */
export async function findRunning(
  config?: BabystackConfig,
  configPath?: string,
): Promise<{ instance: Instance; baseline: Baseline; stale: boolean } | undefined> {
  const cfg = config ?? (await loadConfig(configPath))
  const { adapter, name, service, cacheDir } = sessionAdapter(cfg, projectId(configPath))
  await ensureDockerAvailable() // so a Docker-down surfaces as DOCKER_UNAVAILABLE, not "nothing is awake"
  const instance = await adapter.discover(name)
  if (instance === undefined) return undefined
  const baseline = await readBaselineSidecar(cacheDir, name)
  if (baseline === undefined) return undefined
  // `home`/`reset` do NOT rebuild (only `wake` does), so a changed migration/seed can't be fixed here — but
  // it MUST be signalled, or the agent loop keeps serving stale seed silently (the trust cliff). Compare the
  // current inputs' hash to the one this baseline was stamped with; the CLI surfaces `stale` as a warning.
  const stale = baseline.invalidation !== (await resolveInvalidation(service, configPath))
  return { instance, baseline, stale }
}

/** `baby sleep`: dispose this project's running container (if any). Returns how many were disposed. */
export async function sleep(config?: BabystackConfig, configPath?: string): Promise<number> {
  const cfg = config ?? (await loadConfig(configPath))
  const { adapter, name } = sessionAdapter(cfg, projectId(configPath))
  await ensureDockerAvailable()
  const instance = await adapter.discover(name)
  if (instance === undefined) return 0
  await adapter.dispose(instance)
  return 1
}
