# Architecture — the two axes, the EngineAdapter seam, and extensibility

> The load-bearing design of babystack: **what** it orchestrates (engines) and **who** drives it
> (consumers) are two independent axes joined by one small interface — `EngineAdapter`. Get this seam right
> and every future addition (Postgres, Redis, the AWS tail; the MCP agent surface; your own custom service)
> is a clean plug-in, not a rewrite. This is the reference to read before adding an engine or a consumer.
>
> Status: the **seam** (this document) is built and stable in `@babystack/core`. The multi-engine
> **resolution machinery** and **custom-adapter config** described in §6–§7 are deliberately deferred until
> the second engine lands (Postgres is the priority next — see the [roadmap](../ROADMAP.md)). Today the
> runtime is hardcoded to MySQL.

## Table of contents

- [1. The two axes](#1-the-two-axes)
- [2. The consumer axis (who drives the engine)](#2-the-consumer-axis-who-drives-the-engine)
- [3. The engine axis and the `EngineAdapter` seam](#3-the-engine-axis-and-the-engineadapter-seam)
- [4. Core (the seam) vs docker (the muscle)](#4-core-the-seam-vs-docker-the-muscle)
- [5. Worked example — adding an engine](#5-worked-example--adding-an-engine)
- [6. Adapter resolution (name → adapter, lazily)](#6-adapter-resolution-name--adapter-lazily)
- [7. Custom adapters — babystack as a platform](#7-custom-adapters--babystack-as-a-platform)
- [8. Packaging implications](#8-packaging-implications)
- [9. Built today vs deferred](#9-built-today-vs-deferred)
- [10. Invariants every engine and consumer must honor](#10-invariants-every-engine-and-consumer-must-honor)

## 1. The two axes

babystack has exactly two things that vary, and they are **orthogonal** — changing one never forces a
change in the other:

- **Engines (the _what_):** the real backing service being orchestrated — MySQL today; **Postgres next**,
  then Redis, MinIO (=S3), DynamoDB Local, ElasticMQ (=SQS), and LocalStack (the AWS tail) on the roadmap;
  and, in principle, any Dockerized stateful service you bring yourself.
- **Consumers (the _who_):** the front-end that drives the engine through its lifecycle — the
  `@babystack/vitest` test hooks today; the `baby` CLI (operator + agent surface); the `@babystack/mcp`
  agent data-plane next.

```
                          CONSUMERS  (delivery vehicles — drive the engine)
                          ┌───────────────┬───────────────┬────────────────┐
                          │ @babystack/    │  babystack    │ @babystack/    │
                          │   vitest       │  (baby CLI)   │   mcp (future) │
                          └───────┬────────┴───────┬───────┴───────┬────────┘
                                  │                │               │
                                  ▼                ▼               ▼
                          ┌──────────────────────────────────────────────┐
                          │  @babystack/runtime  +  @babystack/core       │
                          │  resolve config → select adapter → lifecycle  │
                          └───────┬──────────────────────────────┬────────┘
                                  │      EngineAdapter interface   │
   ENGINES ────────────┬─────────┴──────────┬───────────────────┴─────────┐
   (what backend)      │                    │                             │
             @babystack/mysql      @babystack/postgres (next)   your-custom-adapter
             (real mysql:8.4)      (real postgres:16)           (any dockerized service)
                                  │
                          all drive @babystack/docker (the generic container muscle)
```

The strategic rule that follows from this shape: **broaden by re-exposing the one engine to a new
_consumer_ (a new box on the top axis), never by acquiring a new _problem domain_** (data generation,
masking, hosting). Adding engines widens the bottom axis; adding consumers widens the top axis; neither adds
a new problem domain.

## 2. The consumer axis (who drives the engine)

A **consumer** is a thin delivery vehicle. It contains **no engine logic** — it calls `@babystack/runtime`
to provision the stack, acquire per-worker leases, and dispose. Its only job is to adapt babystack's
lifecycle to a host environment's conventions.

- **`@babystack/vitest`** — wires the engine into Vitest's lifecycle. `globalSetup` (once, main process)
  provisions + seeds the stack and hands coordinates to the workers; `setupFiles` (per file, in each
  worker) opens a fresh lease and sets `process.env.DATABASE_URL` before the app imports. It declares
  `vitest` as a **peer dependency** (you bring your own Vitest). Swap MySQL for Postgres underneath and this
  package does not change a line.
- **`babystack` / `@babystack/cli`** — the `baby` command (`doctor`/`wake`/`home`/`reset`/`sleep`). Same
  engine, driven from the shell across separate invocations (the container is detached; later commands
  rediscover it by label). This is the operator + AI-agent surface.
- **`@babystack/mcp` (future)** — the same seeded, resettable stack exposed to AI coding agents over MCP.
  It is **another node on the consumer axis**, not a new engine and not a new problem domain: it re-exposes
  the existing engine to a new consumer. It will declare the MCP SDK as its own dependency, which is exactly
  why it is a separate opt-in package (§8).

The contract a consumer relies on lives in `@babystack/runtime`: `loadConfig`, `provisionStack`,
`leaseEnv`/`ensureEnv`, and the `wake`/`sleep`/`findRunning` session helpers. A consumer never touches an
adapter directly; runtime hands it a provisioned stack and leases.

## 3. The engine axis and the `EngineAdapter` seam

Every engine — MySQL, Postgres, or a custom service — is **just an implementation of one interface**,
defined in the pure core (`@babystack/core`):

```ts
interface EngineAdapter {
  readonly engine: Engine
  provision(spec: ProvisionSpec): Promise<Instance> // start a real container
  waitReady(instance: Instance): Promise<void> // block until it truly accepts connections
  buildBaseline(instance: Instance, spec: SeedSpec): Promise<Baseline> // run YOUR seed → capture a snapshot
  openLease(instance: Instance, baseline: Baseline, key: string): Promise<Lease> // FRESH per-worker copy
  closeLease(lease: Lease): Promise<void> // drop that worker's copy
  env(lease: Lease): EnvMap // the disposable connection env (DATABASE_URL, …)
  dispose(instance: Instance): Promise<void> // idempotent teardown (container + volume)
  logs(instance: Instance): Promise<string>
}
```

The two invariants `openLease` must satisfy (the `Pool` depends on them): the database/namespace name is a
**deterministic function of `key`** (so re-acquiring the same key drops-and-recreates that one copy), and
**distinct keys map to distinct names** (worker isolation). Everything above the seam — every consumer —
speaks only this interface and never knows which engine is underneath.

**Uniform interface, engine-specific mechanics.** The interface is identical across engines; how each method
is _implemented_ differs per engine, and that difference is precisely what the adapter absorbs:

| Concern                  | MySQL                                             | Postgres (illustrative)                                                    | Redis (illustrative)                       |
| ------------------------ | ------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------ |
| `buildBaseline`          | run seed → `mysqldump` → cached `.sql` + checksum | run seed → `pg_dump` (or a template DB)                                    | run seed → `BGSAVE` an RDB snapshot        |
| `openLease` isolation    | a database per worker (`babystack_<svc>_w<key>`)  | a database per worker, or `CREATE DATABASE … TEMPLATE` (server-side clone) | a logical DB / key-prefix / fresh instance |
| `env`                    | `DATABASE_URL=mysql://…`                          | `DATABASE_URL=postgres://…`                                                | `REDIS_URL=redis://…`                      |
| reset (`reset`/re-lease) | drop + reload the dump                            | drop + recreate from the template                                          | `FLUSHDB` + replay/restore                 |

> Postgres's `CREATE DATABASE … TEMPLATE` is a server-side clone MySQL has no equivalent for — which is why
> it enables faster per-worker provisioning, and why it's the priority next engine.

## 4. Core (the seam) vs docker (the muscle)

Two packages carry the shared weight so adapters stay small:

- **`@babystack/core`** — the **pure** seam: the `EngineAdapter` interface, `Lease`/`Pool`, the config
  surface, the lifecycle orchestrator, the invalidation hash, redaction, and the injected
  `Clock`/`CommandRunner` ports. It imports **no** Docker SDK, no adapter, and no raw I/O (enforced by
  dependency-cruiser + a lint ban on `Date.now`/`Math.random`). It is the contract, not an implementation.
- **`@babystack/docker`** — the **generic muscle**: `provision` (ephemeral loopback port + owner/run
  labels), authenticated `waitReady`, idempotent `dispose` (container + volume), label-scoped GC, `exec`,
  `logs`. It is engine-agnostic — every adapter drives it rather than shelling out to `docker` itself.

So an adapter is thin: it maps its engine's specifics (image, readiness probe, seed → snapshot, lease
mechanic, connection URL) onto the generic Docker muscle. `@babystack/mysql` is the reference implementation
and the shape every future adapter mirrors.

## 5. Worked example — adding an engine

Redis is shown here because it stresses the seam hardest (no `CREATE DATABASE`, no SQL dump) — a better
teaching example than Postgres, which closely mirrors MySQL. The actual next engine is Postgres; the shape
is identical either way.

```
1. New package  @babystack/redis
     class RedisAdapter implements EngineAdapter {
        engine        = 'redis'
        provision     → docker.provision({ image: 'redis:7', ... })      (via @babystack/docker)
        waitReady     → exec `redis-cli PING` until PONG (authenticated, not a port ping)
        buildBaseline → run the user's seed commands, then BGSAVE → cache the RDB + checksum
        openLease     → a fresh keyspace per worker: SELECT <n> (16 logical DBs), or a key-prefix
                        namespace, or a fresh lightweight instance for high worker counts
        closeLease    → FLUSHDB <n> / drop the prefix
        env           → { REDIS_URL: 'redis://…/<n>' }
        dispose       → docker.dispose(id)
     }
2. It MUST pass the shared EngineAdapter conformance suite — the "done" bar for ANY engine
   (seed survives build → snapshot → lease; distinct keys are isolated; re-acquire is fresh; dispose is
   idempotent). The conformance suite is written when the second engine lands and every adapter runs it thereafter.
3. runtime maps  engine: 'redis'  → new RedisAdapter(...)   (see §6)
4. Consumers (@babystack/vitest, the baby CLI) — UNCHANGED.
```

The engine-specific judgement calls Redis forces (and every engine will force its own version of): what is a
"baseline" when there is no `mysqldump` (an RDB/AOF snapshot); what is "per-worker isolation" when there is
no `CREATE DATABASE` (logical DBs are capped at 16, so beyond that it is key-prefixing or separate
instances); what does "reset" mean (`FLUSHDB` + restore). None of these leak upward — the adapter absorbs
them so the interface, and every consumer, stays identical.

## 6. Adapter resolution (name → adapter, lazily)

Today runtime is hardcoded: it throws on anything but `mysql`, and constructs `new MysqlAdapter()` directly.
To support more engines **without bundling every client library** (`mysql2` + a Postgres client + a Redis
client + an AWS SDK + …) into everyone's install, runtime must select the adapter **lazily, by engine
name**:

```
   config: engine: 'postgres'
        │
        ▼
   runtime:  const { PostgresAdapter } = await import('@babystack/postgres')   ← dynamic; only if used
        │      (if the package is absent → a typed error: "install @babystack/postgres")
        ▼
   new PostgresAdapter(options)  →  the same lifecycle as always
```

Convention: engine `'<name>'` resolves to package `@babystack/<name>` via dynamic import. You install only
the engine packages you actually use; runtime imports them on demand. This is what keeps `core` and the
flagship lean forever (§8), and it is the mechanism the first real second engine will validate.

## 7. Custom adapters — babystack as a platform

Because the seam is a plain interface, you can plug in **your own** service without babystack knowing
anything about it. This is the difference between "a MySQL test tool" and "the orchestration layer for any
real backing service."

A bespoke stateful microservice (its own image, its own store) implements the same contract:

```ts
// your code
class InventoryAdapter implements EngineAdapter {
  engine = 'inventory'
  provision = () => docker.provision({ image: 'mycorp/inventory:1.2', ... })
  waitReady = () => poll('GET /health')
  buildBaseline = (spec) => { runSeed(spec); snapshotVolume() }
  openLease = (key) => cloneVolumeForWorker(key) // or reset via an admin endpoint
  env = (lease) => ({ INVENTORY_URL: lease.url })
  dispose = () => docker.dispose(id)
}
```

and registers it via config — the `engine` field widens from a fixed string union to
`string | EngineAdapterFactory`:

```ts
export default defineConfig({
  services: {
    inventory: { engine: InventoryAdapter }, // custom — used as-is
    db: { engine: 'mysql' }, // built-in — resolved by name (§6)
  },
})
```

A built-in name resolves through §6; a factory is used directly. Now **anything you can put in a container
and seed/reset is fresh-per-test through babystack** — the LocalStack-analog vision, delivered to whatever
service your team actually runs.

## 8. Packaging implications

The two axes explain the whole package layout:

- **Engines are opt-in scoped packages** (`@babystack/mysql`, future `@babystack/postgres`, …). Each pulls
  its own client library, so bundling them all would make every install pay for every client. You install
  the engine(s) you use; runtime resolves them lazily (§6).
- **Consumers are opt-in scoped packages** (`@babystack/vitest`, future `@babystack/mcp`). Each pulls its
  own heavy peer (Vitest, the MCP SDK, the CLI bin). Same reasoning — install the consumer you use.
- **`@babystack/core` and the `babystack` flagship stay lean** — the seam + a thin re-export + the `baby`
  bin. They never grow as engines/consumers multiply, because every addition is a new sibling package, not
  a new dependency of core.
- **A custom adapter needs no package at all** — it is your own module implementing the core interface,
  passed in config (§7).

This is why the packaging model is "lean flagship + opt-in scoped siblings," and why it scales: engine #5
and consumer #3 are just two more small packages resolved on demand.

## 9. Built today vs deferred

- **Built and stable:** the `EngineAdapter` seam in `@babystack/core`, `@babystack/docker` (the muscle),
  `@babystack/mysql` (the reference adapter), and the `runtime`/`vitest`/`cli` stack over them. The config
  type union already _names_ the future engines (for editor autocomplete + the "architect wide" signal),
  but only MySQL has an adapter — a non-MySQL service fails fast with `CONFIG_INVALID`.
- **Deferred until the second engine (Postgres is the priority next — see the [roadmap](../ROADMAP.md)):**
  the lazy resolution machinery (§6), the `EngineAdapter` **conformance suite**, and the custom-adapter
  config (`engine: string | EngineAdapterFactory`, §7). This is deliberate YAGNI: we build the resolution +
  conformance + custom seam **with** the first real second engine, so they are validated by something real
  instead of guessed at. The interface (§3) is the only thing that had to be right up front, and it is.

## 10. Invariants every engine and consumer must honor

- **Orchestrate & delegate, never emulate.** An adapter runs the _real_ engine (or drives LocalStack for an
  AWS service with no real local engine). Never reimplement a proprietary API — the one unforgivable sin.
- **Pass the conformance suite.** A new engine is not "done" until it passes the shared `EngineAdapter`
  conformance tests. This is what makes "uniform interface" a guarantee, not a hope.
- **Credential boundary.** Every engine hands out only disposable connection URLs; no real dev/prod
  credential (or the minted password) reaches a test, an agent, or a log.
- **Baseline off the hot path.** Build the seeded baseline once, cold; reuse it; rebuild only when the
  invalidation hash changes (the trust cliff — a cache that serves stale seed is worse than no cache).
- **Honest speed, per engine.** Never claim "instant." Publish measured numbers, per engine, with method —
  each engine's reset mechanic has its own real cost.
- **Pure core.** The seam and lifecycle stay I/O-free and deterministic; all I/O lives in an adapter or the
  docker muscle, behind the injected `Clock`/`CommandRunner` ports.
