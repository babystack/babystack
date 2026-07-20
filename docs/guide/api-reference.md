# API Reference — the complete public surface

> The **single source of truth** for everything babystack exposes: every package export, the config schema,
> the `baby` CLI, environment variables, and error codes. This doc is **evergreen and MUST be kept in sync
> with every change that touches a public surface** — a new export, a renamed field, a new CLI flag, a new
> error code, a new env var. If it ships to a user, it is listed here.
>
> **Sync rule:** any PR that adds/renames/removes a public export, config field, CLI command/flag, env var,
> or error code updates this file in the SAME change. Treat a drift between this doc and the code as a bug.
>
> **Stability legend:** ✅ **Public** (supported, documented for users) · 🔧 **Advanced** (exported, but for
> power users / internal consumers — may change) · ⏳ **Typed, not implemented** (accepted by types, fails
> fast at runtime today).

## Table of contents

- [1. Packages at a glance](#1-packages-at-a-glance)
- [2. `babystack` (flagship)](#2-babystack-flagship)
- [3. `@babystack/core`](#3-babystackcore)
- [4. `@babystack/vitest`](#4-babystackvitest)
- [5. `@babystack/cli`](#5-babystackcli)
- [6. `@babystack/runtime`](#6-babystackruntime)
- [7. `@babystack/mysql`](#7-babystackmysql)
- [8. `@babystack/docker`](#8-babystackdocker)
- [9. Config schema (`defineConfig`)](#9-config-schema-defineconfig)
- [10. The `baby` CLI](#10-the-baby-cli)
- [11. Environment variables](#11-environment-variables)
- [12. Error codes](#12-error-codes)
- [13. Engines](#13-engines)

## 1. Packages at a glance

| Package              | Version | Role                                  | Install (typical)                       |
| -------------------- | ------- | ------------------------------------- | --------------------------------------- |
| `babystack`          | 0.1.0   | Flagship — API re-export + `baby` bin | `pnpm add -D babystack` (CLI/agent)     |
| `@babystack/core`    | 0.1.0   | Pure core — config, seam, lifecycle   | (transitive)                            |
| `@babystack/vitest`  | 0.1.0   | Consumer — Vitest hooks               | `pnpm add -D @babystack/vitest` (tests) |
| `@babystack/cli`     | 0.1.0   | Consumer — the `baby` command impl    | (via `babystack`)                       |
| `@babystack/runtime` | 0.1.0   | Shared session/lifecycle resolver     | (transitive)                            |
| `@babystack/mysql`   | 0.1.0   | Engine adapter — real MySQL           | (transitive)                            |
| `@babystack/docker`  | 0.1.0   | Generic Docker muscle                 | (transitive)                            |

**Two install paths** (see [Architecture §8](./architecture.md#8-packaging-implications) for why): `@babystack/vitest` (the test wedge — one package,
pulls the engine transitively) and `babystack` (the `baby` CLI). Everything else is transitive.

## 2. `babystack` (flagship)

- **Bin:** `baby` → the CLI (delegates to `@babystack/cli`). See [§10](#10-the-baby-cli).
- **Exports:** `export * from '@babystack/core'` — re-exports the entire core surface below (most importantly
  `defineConfig`). So `import { defineConfig } from 'babystack'` works for CLI/agent users.

## 3. `@babystack/core`

The pure core (no I/O). Origin of the config API and every shared type.

| Export                                    | Kind  | Stability | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------- | ----- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `defineConfig(config)`                    | fn    | ✅        | Typed identity helper for `babystack.config.ts`; fails fast on empty `services`/unknown engine.                                                                                                                                                                                                                                                                                                                                                        |
| `BabystackError`                          | class | ✅        | Typed error carrying a `code` ([§12](#12-error-codes)).                                                                                                                                                                                                                                                                                                                                                                                                |
| `computeInvalidationHash(inputs)`         | fn    | 🔧        | Pure baseline-invalidation hash (length-prefixed, injective).                                                                                                                                                                                                                                                                                                                                                                                          |
| `BASELINE_FORMAT_VERSION`                 | const | 🔧        | Bump to invalidate all cached baselines when the dump format changes.                                                                                                                                                                                                                                                                                                                                                                                  |
| `createStack(deps, spec, seed)`           | fn    | 🔧        | Lifecycle orchestrator (provision → seed → dispose).                                                                                                                                                                                                                                                                                                                                                                                                   |
| `createPool(adapter, instance, baseline)` | fn    | 🔧        | The single-process lease `Pool`.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `redactSecrets(text, literals?)`          | fn    | 🔧        | Scrub URL creds / `key=value` / AWS keys / a minted password from a string.                                                                                                                                                                                                                                                                                                                                                                            |
| **Types**                                 |       |           | `Engine`, `Mode`, `EnvMap`, `ProvisionSpec`, `Instance`, `Baseline`, `Lease`, `SeedSpec`, `EngineAdapter`, `BabystackErrorCode`, `Clock`, `CommandRunner`, `CommandResult`, `CommandOptions`, `Pool`, `Stack`, `StackDeps`, `InvalidationInputs`, and the config types (`BabystackConfig`, `ServiceConfig`, `MysqlService`, `RedisService`, `MinioService`, `DynamoService`, `ElasticmqService`, `LocalstackService`, `BaselineConfig`, `TestPolicy`). |

`EngineAdapter` is the extensibility seam — a new engine (Postgres, Redis, …) implements it. See
[Architecture §3](./architecture.md#3-the-engine-axis-and-the-engineadapter-seam) and [§13 Engines](#13-engines).

## 4. `@babystack/vitest`

The Vitest consumer. **This is the one package a test user installs.**

| Export                                                                                                                                                          | Kind                 | Stability | Notes                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | --------- | ----------------------------------------------------------------------------------- |
| `@babystack/vitest/global-setup`                                                                                                                                | subpath              | ✅        | `globalSetup` entry — provisions + seeds once (main process).                       |
| `@babystack/vitest/setup`                                                                                                                                       | subpath              | ✅        | `setupFiles` entry — per file, per worker: lease a fresh DB → set `DATABASE_URL`.   |
| `defineConfig`                                                                                                                                                  | fn (re-export)       | ✅        | Re-exported from core so the wedge is one install.                                  |
| Config types                                                                                                                                                    | types (re-export)    | ✅        | `BabystackConfig`, `ServiceConfig`, `MysqlService`, `BaselineConfig`, `TestPolicy`. |
| `loadConfig`, `provisionStack`, `leaseEnv`, `resolveMysqlService`, `toProvisionSpec`, `toSeedSpec`, `buildEnvAllowlist`, `createMysqlAdapter`, `AdapterOptions` | fns/type (re-export) | 🔧        | Programmatic helpers from runtime (same ones the CLI uses).                         |

Peer dependency: `vitest >=2` (you bring your own Vitest).

## 5. `@babystack/cli`

The `baby` command implementation (the `babystack` flagship ships the bin that calls it).

| Export                           | Kind  | Stability | Notes                                                        |
| -------------------------------- | ----- | --------- | ------------------------------------------------------------ |
| `run(argv)`                      | fn    | 🔧        | argv → `{ code, output }` (the bin handles process I/O).     |
| `COMMANDS`                       | const | 🔧        | `['doctor','wake','home','reset','sleep']`.                  |
| `doctorChecks(dockerAvailable?)` | fn    | 🔧        | The preflight check set (injectable Docker probe for tests). |
| `readsEnvTooEarly(source)`       | fn    | 🔧        | The `ENV_READ_TOO_EARLY` heuristic.                          |
| `Command`, `RunResult`, `Check`  | types | 🔧        |                                                              |

User-facing surface is the CLI itself — [§10](#10-the-baby-cli).

## 6. `@babystack/runtime`

Shared session/lifecycle layer (consumed by `vitest` + `cli`; not installed directly).

| Export                                                                                    | Kind  | Notes                                                                                                |
| ----------------------------------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------- |
| `loadConfig(configPath?)`                                                                 | fn    | Load `babystack.config.ts` (default export).                                                         |
| `provisionStack(config?)`                                                                 | fn    | Cold path: provision → seed baseline → `{ stack, cleanup }`.                                         |
| `wake(config?, configPath?, options?)`                                                    | fn    | `baby wake`: provision + seed, leave running; invalidation-aware. `WakeOptions { rebuild? }`.        |
| `wakeWith(deps, options?)`                                                                | fn    | The `wake` orchestration over an injected `SessionEngine` (advanced/test seam; `wake` is the shell). |
| `sleep(config?, configPath?)`                                                             | fn    | `baby sleep`: dispose this project's container.                                                      |
| `findRunning(config?, configPath?)`                                                       | fn    | Discover the running container + baseline (for `home`/`reset`).                                      |
| `leaseEnv(instance, baseline, key)`                                                       | fn    | Destructive: fresh per-key DB from the baseline → env.                                               |
| `ensureEnv(instance, baseline, key)`                                                      | fn    | Non-destructive: create+seed only if absent (what `baby home` uses).                                 |
| `resolveMysqlService(config)`                                                             | fn    | Pick the single MySQL service; throws `CONFIG_INVALID` otherwise.                                    |
| `resolveInvalidation(service, configPath?)`                                               | fn    | Compute the current invalidation hash (reads watched files).                                         |
| `shouldReuseBaseline(cached, wantHash, force)`                                            | fn    | Reuse-vs-rebuild decision (pure).                                                                    |
| `cacheDisabled()`                                                                         | fn    | `BABYSTACK_NO_CACHE` parsing.                                                                        |
| `createMysqlAdapter(options?)`                                                            | fn    | Construct the MySQL adapter over the Docker backend.                                                 |
| `toProvisionSpec`, `toSeedSpec`, `buildEnvAllowlist`, `projectId`                         | fns   | Config→spec helpers; scrubbed build env; per-project id (config-path hash).                          |
| `AdapterOptions`, `WakeOptions`, `WokenStack`, `CleanupMode`, `SessionEngine`, `WakeDeps` | types |                                                                                                      |

## 7. `@babystack/mysql`

The real-MySQL `EngineAdapter` (not installed directly).

| Export                   | Kind  | Notes                                                                      |
| ------------------------ | ----- | -------------------------------------------------------------------------- |
| `MysqlAdapter`           | class | Implements `EngineAdapter`; orchestrates a real `mysql:8.4` container.     |
| `normalizeDefiners(sql)` | fn    | Strip `DEFINER=` clauses from a dump so it reloads under a different user. |

## 8. `@babystack/docker`

The generic container muscle (not installed directly).

| Export                        | Kind  | Notes                                                                                               |
| ----------------------------- | ----- | --------------------------------------------------------------------------------------------------- |
| `DockerBackend`               | class | provision · authenticated `waitReady` · idempotent `dispose` · label-scoped `gc` · `exec` · `logs`. |
| `NodeCommandRunner`           | class | The real `CommandRunner` port (shells out).                                                         |
| `SystemClock`                 | class | The real `Clock` port.                                                                              |
| `dockerEnvAllowlist(source?)` | fn    | The empty-by-default docker-env allowlist (credential boundary).                                    |
| `OWNER_LABEL`, `RUN_LABEL`    | const | Container labels for discovery + GC scoping.                                                        |

## 9. Config schema (`defineConfig`)

```ts
interface BabystackConfig {
  mode?: 'test' // ⏳ only 'test' today
  services: Record<string, ServiceConfig> // exactly ONE service today, engine must be 'mysql'
}

interface MysqlService {
  // (the one implemented ServiceConfig)
  engine: 'mysql'
  image?: string // default 'mysql:8.4' — pin to match prod
  database?: string // ⏳ accepted, not yet enforced
  baseline?: BaselineConfig
  test?: TestPolicy
}

interface BaselineConfig {
  strategy?: 'logical-dump' // only value; default
  build?: string[] // ordered shell cmds run ONCE (migrate + seed)
  invalidateWhenChanged?: string[] // globs; their contents feed the invalidation hash
}

interface TestPolicy {
  reset?: 'snapshot' // ⏳ accepted, always snapshot today
  cleanup?: 'destroy' | 'keep-on-failure' | 'keep' // 'keep' honored; 'keep-on-failure' ⏳ not yet
}
```

Other engine service shapes exist in the type union with engine-specific fields (`MinioService.buckets`,
`DynamoService.tables`, `ElasticmqService.queues`, `LocalstackService.services`; `RedisService` adds none)
but are all ⏳ — see [§13](#13-engines).

## 10. The `baby` CLI

`baby <command> [--json]`. Every command supports `--json` (for CI/agents).

| Command       | Alias  | What it does                                                                          |
| ------------- | ------ | ------------------------------------------------------------------------------------- |
| `baby doctor` |        | Preflight: Node, a reachable Docker engine, and your config.                          |
| `baby wake`   | `up`   | Provision + seed a real MySQL, leave it running. `--rebuild` forces a fresh baseline. |
| `baby home`   | `env`  | Print an eval-able `DATABASE_URL` for the running stack (non-destructive).            |
| `baby reset`  |        | Reload a pristine DB from the baseline (the agent's undo; same URL).                  |
| `baby sleep`  | `down` | Dispose this project's running stack.                                                 |

**Flags:** `--json` (all), `--rebuild` (`wake`). **Exit codes:** `0` ok · `1` error / not-awake / unknown
command.

## 11. Environment variables

**Provided by babystack** (injected for your app/tests; the disposable connection env):

| Var                                                                          | Notes                                                                   |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `DATABASE_URL`                                                               | `mysql://root:<minted>@127.0.0.1:<port>/<db>` — the one your app reads. |
| `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE` | The same connection, decomposed.                                        |

**Read by babystack** (inputs you may set):

| Var                  | Notes                                                                      |
| -------------------- | -------------------------------------------------------------------------- |
| `BABYSTACK_CONFIG`   | Path to the config file (default `./babystack.config.ts`).                 |
| `BABYSTACK_NO_CACHE` | Truthy → force a baseline rebuild (disable reuse). `''`/`0`/`false` = off. |
| `VITEST_POOL_ID`     | Read (set by Vitest) to key each worker's database.                        |

## 12. Error codes

`BabystackError.code` is one of:

| Code                    | Meaning                                                                          |
| ----------------------- | -------------------------------------------------------------------------------- |
| `CONFIG_INVALID`        | Bad/absent config, >1 service, or a non-MySQL engine today.                      |
| `DOCKER_UNAVAILABLE`    | Docker engine not reachable.                                                     |
| `PROVISION_FAILED`      | Container failed to provision / missing minted password.                         |
| `WAIT_READY_TIMEOUT`    | Engine never became ready in time.                                               |
| `BASELINE_BUILD_FAILED` | A `baseline.build` (migrate/seed) command failed.                                |
| `BASELINE_CORRUPT`      | Cached baseline failed its checksum (corrupt/truncated) before load.             |
| `LEASE_FAILED`          | Failed to create/load a per-worker database.                                     |
| `DISPOSE_FAILED`        | Teardown failed.                                                                 |
| `ENV_READ_TOO_EARLY`    | (doctor, warn) an import-time `DATABASE_URL` read was detected in `src/`.        |
| `NOT_IMPLEMENTED`       | Reserved; not currently thrown (unsupported engines fail with `CONFIG_INVALID`). |

## 13. Engines

| Engine                  | Status         | Notes                                                         |
| ----------------------- | -------------- | ------------------------------------------------------------- |
| `mysql`                 | ✅ Implemented | Real `mysql:8.4` (configurable image). The only engine today. |
| `redis`                 | ⏳ Typed only  | Roadmap. Fails fast with `CONFIG_INVALID`.                    |
| `minio` (S3)            | ⏳ Typed only  | Roadmap.                                                      |
| `dynamodb-local`        | ⏳ Typed only  | Roadmap.                                                      |
| `elasticmq` (SQS)       | ⏳ Typed only  | Roadmap.                                                      |
| `localstack` (AWS tail) | ⏳ Typed only  | Roadmap.                                                      |

**Postgres is the priority next engine** (see the [roadmap](../ROADMAP.md)); it isn't listed above because
it's not yet in the `Engine` type union — it joins when its adapter lands.

Adding an engine: implement `EngineAdapter`, pass the shared conformance suite (authored with engine #2 —
until then the MySQL adapter's invariants are tested directly), and register it — see the worked example in
[Architecture §5](./architecture.md#5-worked-example--adding-an-engine).
