# Getting started

> **How you use babystack** — the MySQL + Vitest wedge, end to end. Also on the
> [site](https://babystack.pages.dev). For where it's headed next, see the [roadmap](../ROADMAP.md).
>
> ⚠️ **Pre-alpha — but published.** `v0.1.0` is live on npm, so the `pnpm add` and `baby` commands below
> work today. The engine, the Vitest wedge, the `examples/` app, and the `baby` CLI
> (`doctor`/`wake`/`home`/`reset`/`sleep`) are all **built and proven end-to-end** (real MySQL, parallel
> isolation, cross-invocation CLI). Interfaces may still shift before `1.0`; the few knobs not yet honored
> are called out below.

## Table of contents

- [The mental model](#the-mental-model)
- [Prerequisites](#prerequisites)
- [Install](#install)
- [Describe your backend — `babystack.config.ts`](#describe-your-backend--babystackconfigts)
- [Wire Vitest (three lines, zero test changes)](#wire-vitest-three-lines-zero-test-changes)
- [The env contract — and the one rule](#the-env-contract--and-the-one-rule)
- [What one `pnpm test` actually does](#what-one-pnpm-test-actually-does)
- [Isolation & reset semantics](#isolation--reset-semantics)
- [The `baby` CLI](#the-baby-cli)
- [Continuous integration](#continuous-integration)
- [Troubleshooting](#troubleshooting)
- [Known limitations (Phase 0)](#known-limitations-phase-0)
- [Trying it today (pre-alpha)](#trying-it-today-pre-alpha)
- [Where this is going](#where-this-is-going)

## The mental model

babystack is a **factory line for your test database, not a database**. You describe your real backend
**once** (Phase 0: one MySQL service + the `migrate` and `seed` commands you already have). babystack then
owns a lifecycle: provision **one** real `mysql:8.4` container, build a seeded **baseline** once, and hand
every Vitest worker **its own fresh database** loaded from that baseline over a normal connection URL.

Your tests never import babystack and never manage lifecycle — they read `process.env.DATABASE_URL` exactly
like production, so **the app can't tell it's in a test**. Two things to internalize:

1. **One `mysqld`, many databases.** Isolation is a database _per Vitest worker_ (keyed by
   `VITEST_POOL_ID`) inside a single container — **not** a container per worker (a `mysqld` boot each would
   be far too slow).
2. **The URL arrives at run time.** babystack sets `DATABASE_URL` just before your app is imported, so your
   DB client must read it **lazily** (on first use), not at module-import time. This is the one app-code
   rule — see [the env contract](#the-env-contract--and-the-one-rule).

It is **not** an emulator. Your app talks to a real `mysql:8.4` server (orchestrate & delegate, never
emulate).

## Prerequisites

- **Docker running** — Docker Desktop, OrbStack, or Colima. `docker info` must succeed. There is no
  Docker-less path; babystack orchestrates a _real_ engine.
- **Node 22 or 24** (the supported majors; Node 20 is EOL).
- **A `migrate` command and a `seed` command you already run by hand.** babystack _runs yours_ to build the
  baseline — it never writes, owns, or guesses your migrations or seeds.
- **No host MySQL client needed.** `mysqldump`/`mysql` run **inside the container** (via `docker exec`), so
  the only host dependency is Docker. (This also avoids client/server version skew and the MariaDB-vs-MySQL
  `mysqldump` hazard.)

(`baby doctor` verifies these for you — it checks Node, a reachable Docker engine, and your config; the
Vitest `globalSetup` also fails fast with a typed `DOCKER_UNAVAILABLE` if the engine isn't reachable.)

## Install

> Published on npm as of `v0.1.0` — these commands work today.

```bash
# One package for the Vitest wedge — it re-exports defineConfig and pulls the engine
# (@babystack/core + @babystack/mysql + @babystack/docker) transitively:
pnpm add -D @babystack/vitest
```

That's the whole test setup. One optional extra:

| Package     | When you'd add it                                                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `babystack` | the `baby` CLI (`doctor`/`wake`/`home`/`reset`/`sleep`) — the operator + AI-agent surface. A separate install; **not needed for the Vitest path.** |

No global install and no daemon: the CLI and the Vitest hooks drive an in-process core that shells out to
the Docker CLI. (Using npm or yarn? Swap `pnpm` for your package manager everywhere, including inside the
`baseline.build` commands below — those run under _your_ package manager.)

## Describe your backend — `babystack.config.ts`

Phase 0 has **no `baby init` auto-detect** — you hand-write this file at the repo root. It's small:

```ts
// babystack.config.ts
import { defineConfig } from '@babystack/vitest' // re-exported here so the wedge is one install

export default defineConfig({
  services: {
    // Exactly one service today, and it must be MySQL (the only implemented engine — see the roadmap).
    // The key ("db") is a label used in logs and in the per-worker database name.
    db: {
      engine: 'mysql',
      image: 'mysql:8.4', // the REAL engine your app talks to (defaults to mysql:8.4)

      baseline: {
        // 'logical-dump' (mysqldump → reload) is the only strategy today, and the default.
        // Run ONCE to build the seeded baseline. babystack injects a disposable connection
        // URL into these commands; it never edits your migrations/seeds. Order matters.
        build: ['pnpm prisma migrate deploy', 'pnpm tsx prisma/seed.ts'],
      },

      // test: { cleanup } — 'keep' is honored (the container is left up at teardown for inspection).
      // 'keep-on-failure' is ⏳ not yet honored. test: { reset } is ⏳ accepted but not yet honored
      // (a fresh DB is always loaded per file; 'truncate' is not supported).
    },
  },
})
```

> Using the `baby` CLI instead of (or alongside) Vitest? Install `babystack` and import `defineConfig`
> from `'babystack'` — same helper, re-exported from the package you installed.

> Using a different ORM — Prisma, Sequelize, TypeORM, Knex, Kysely — or **no ORM at all** (raw `mysql2`)?
> The only thing that changes is the `baseline.build` command; see
> **[babystack with your ORM (or none)](./orms.md)**.

`defineConfig` is a typed identity helper: your editor gets full autocomplete, and it fails fast at the
boundary on an empty `services` map or an unknown engine.

**Field behavior in Phase 0** (⏳ = accepted by the types but not yet enforced/implemented):

| Field                                  | Phase-0 behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services`                             | Exactly **one** MySQL service — **MySQL is the only implemented engine today.** Other engine types (`redis`/`minio`/`dynamodb-local`/`elasticmq`/`localstack`) type-check (the union exists, with autocomplete) but have **no adapter yet**: a non-MySQL service fails fast with `CONFIG_INVALID`.                                                                                                                                                                                                                                                            |
| `<svc>.engine`                         | Must be `'mysql'`. Selects the real-MySQL adapter.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `<svc>.image`                          | Docker image tag for the real engine. Defaults to `mysql:8.4`. **Pin it to match prod** (version/collation differ across tags).                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `<svc>.database`                       | ⏳ Accepted but **not yet enforced** — the per-worker DB is always `babystack_<svc>_w<POOL_ID>` (the connection's default schema). If your app hard-codes a schema name, that's a known Phase-0 gap.                                                                                                                                                                                                                                                                                                                                                          |
| `<svc>.baseline.build`                 | Ordered shell commands run **once** to migrate + seed the baseline, against a temp build DB. See the [scrubbed-env caveat](#known-limitations-phase-0).                                                                                                                                                                                                                                                                                                                                                                                                       |
| `<svc>.baseline.strategy`              | `'logical-dump'` only (default, and the only value the type accepts). `'cow'`/`'clone-plugin'` are dropped from the type until a real second strategy exists.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `<svc>.baseline.invalidateWhenChanged` | **Enforced on the `baby wake` (session) path.** `baby wake` hashes your config text, `baseline.build` commands, engine image, and the **contents** of every glob listed here; if that hash differs from the cached baseline's, the next `wake` rebuilds it — so editing a migration/seed and re-running `baby wake` never serves stale seed. Force a rebuild anytime with `baby wake --rebuild` or `BABYSTACK_NO_CACHE=1`. (The Vitest path rebuilds the baseline every run regardless, so it is never stale; cross-run reuse there is a Phase-2 speed item.) |
| `<svc>.test.reset`                     | ⏳ Accepted but **not yet enforced** (always `'snapshot'`: a fresh per-file DB from the baseline). `'truncate'` is **cut from Phase 0**.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `<svc>.test.cleanup`                   | `'keep'` is **honored** — the container is left running at teardown for inspection (default is destroy). `'keep-on-failure'` is ⏳ not yet honored (needs a Vitest run-result hook).                                                                                                                                                                                                                                                                                                                                                                          |
| `mode`                                 | ⏳ Ignored in Phase 0 (only test behavior exists). `'dev'`/`'agent'` land with the MCP wedge (Phase 2.5+).                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## Wire Vitest (three lines, zero test changes)

The **only** test-infra change. No test file is touched.

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Runs ONCE in the main process, before any worker: read config → check Docker is reachable
    // (typed DOCKER_UNAVAILABLE if not) → provision one mysqld → build the seeded baseline once →
    // hand coordinates to workers. Its returned teardown disposes the container at the end.
    globalSetup: ['@babystack/vitest/global-setup'],

    // Runs before each test file: derive this worker's DB name from VITEST_POOL_ID, load the
    // cached baseline into it (acquire a Lease), and set process.env.DATABASE_URL for it.
    setupFiles: ['@babystack/vitest/setup'],

    // REQUIRED: forks gives each worker its own PROCESS (and its own process.env), keyed by a
    // stable VITEST_POOL_ID. See the footgun below — 'threads' silently breaks isolation.
    pool: 'forks',
  },
})
```

> ⚠️ **`pool: 'forks'` is mandatory.** Per-worker env injection relies on separate processes with separate
> `process.env`. Under `pool: 'threads'`, workers share one `process.env`, the last write wins, and tests
> randomly connect to the wrong worker's database. `forks` is Vitest's default, but set it explicitly.
> Requires **Vitest 2+** (developed against 4).

Your test — unchanged:

```ts
test('creates a user', async () => {
  const res = await api.post('/users', { name: 'Ada' })
  expect(res.status).toBe(201)
})
```

## The env contract — and the one rule

babystack injects a disposable connection env per worker:

| Variable                      | Example                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------- |
| `DATABASE_URL`                | `mysql://root:bs_9f3a2c1e@127.0.0.1:53312/babystack_db_w1`                            |
| `MYSQL_HOST` `MYSQL_PORT`     | `127.0.0.1` · `53312` (an **ephemeral** host port, never a fixed 3306)                |
| `MYSQL_USER` `MYSQL_PASSWORD` | `root` + a **minted, disposable** password — **never your real dev/prod credentials** |
| `MYSQL_DATABASE`              | `babystack_db_w1` (this worker's private database)                                    |

- **Set per worker, in `setupFiles`** — not in `globalSetup` (which runs once in the main process and would
  give every worker the same value). Only the trailing `/database` segment differs per worker:
  `…/babystack_db_w1`, `…/babystack_db_w2`, ….
- **The one rule — read the URL lazily.** `setupFiles` sets `DATABASE_URL` _before_ your app is imported,
  but a module that captures it at import time freezes a stale/absent value. Read it on first use.

```ts
// ✗ BAD — captured at import, before babystack set it → connects to nothing / your dev DB
export const prisma = new PrismaClient()
export const pool = mysql.createPool(process.env.DATABASE_URL!)

// ✓ GOOD — read on first use (lazy, memoized)
let _prisma: PrismaClient | undefined
export const db = () => (_prisma ??= new PrismaClient()) // Prisma reads DATABASE_URL when constructed

let _pool: Pool | undefined
export const pool = () => (_pool ??= mysql.createPool(process.env.DATABASE_URL!)) // mysql2 / Knex
```

If you get it wrong today, you'll see connection errors (or a hit against the wrong DB). **`baby doctor`
scans `src/` for this and names the likely offending module** (a fail-fast warning). A _runtime_
`ENV_READ_TOO_EARLY` diagnostic emitted at connect time (to explain the flake in the moment) is still
deferred — the error code is reserved but not yet thrown.

## What one `pnpm test` actually does

```
vitest globalSetup (once, main process)
  → read babystack.config.ts + check Docker is reachable (typed DOCKER_UNAVAILABLE if not)
  → provision ONE real mysql:8.4 in Docker on an ephemeral loopback port   [honest ~1–5s boot]
  → build the seeded baseline ONCE: run your migrate + seed, then mysqldump
      → cache the dump under .babystack/cache/ (atomic write + sha256)      [rebuilt each run in Phase 0]
  → hand the container coordinates to the workers
vitest forks N workers → each, in setupFiles:
  → CREATE DATABASE babystack_<svc>_w<POOL_ID>, load the cached dump into it
  → set process.env.DATABASE_URL to this worker's private URL
your tests run — parallel, isolated, real MySQL, unchanged
vitest teardown
  → dispose the container + worker DBs (unless test.cleanup: 'keep' — then it's left up for inspection)
  (⏳ still deferred: 'keep-on-failure'; auto-reap of labeled orphans from a crashed run on the next start)
```

The expensive work (boot + seed + dump) happens **once, cold**. Each worker only does the cheap part: get
its database and a URL. On the next run the baseline is reused, so provisioning is the only real cost.

> Sample CLI/run outputs in this doc are **illustrative, not benchmarks.** Real numbers are published
> separately, measured, with methodology (per the honest-speed rule) — babystack never leads with a number.

## Isolation & reset semantics

- **Per worker:** each Vitest worker gets its own database inside the one `mysqld`. Worker 3 cannot see
  worker 1's rows. This is the isolation guarantee.
- **Per file (default `reset: 'snapshot'`):** each **test file** starts from a fresh load of the baseline —
  so committed writes, DDL, and multi-connection behavior are all real and isolated between files (the
  correctness win over `BEGIN/ROLLBACK`).
- **Within a single file:** tests share the file's database, so a committed write in one `it()` **is
  visible** to the next `it()` in the same file. If you need per-test cleanliness, do your own
  `beforeEach` reset — per-test reset isn't a Phase-0 feature (`truncate` is cut).
- **Leave `isolate` at its default (`true`).** With `isolate: false`, Vitest reuses one module registry
  across all files in a worker, so a module that captured `DATABASE_URL` at import keeps the **first**
  file's value even though `setupFiles` re-leases a fresh DB for each subsequent file — the per-file
  reset still happens, but your app quietly keeps talking to the first file's database. Lazy env reads
  (the one rule above) make this safe either way; until then, don't disable isolation.

`cleanup` on a run — how the Vitest `globalSetup` teardown disposes the container:

| Value               | Behavior                                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `destroy` (default) | Container + worker DBs removed at the end of every run.                                                                                                            |
| `keep`              | ✅ **Honored (0.7b).** The container is left up at teardown (its id printed with a `docker rm -f` / `baby sleep` hint) so you can inspect it, until you remove it. |
| `keep-on-failure`   | ⏳ **Not yet honored** — the failure variant needs a Vitest run-result hook `globalSetup` teardown doesn't expose; falls through to `destroy` for now.             |

Killed a run (Ctrl-C / sleep / OOM)? Teardown didn't fire, so a container can be left behind. The
label-scoped GC that reaps babystack-labeled leftovers exists (`DockerBackend.gc`) but is **not yet
auto-invoked** (⏳ — it can't safely run while a second local suite is live, so auto-reap-on-start stays
deferred). For a CLI session, `baby sleep` disposes this project's container explicitly. Otherwise reap
manually: `docker rm -f -v $(docker ps -aq --filter label=babystack)`. Your own non-babystack MySQL is
never touched.

## The `baby` CLI

> **Shipped in sub-phase 0.7.** `doctor` · `wake` · `home` · `reset` · `sleep` all work today. The Vitest
> wiring above needs no CLI — this is the **operator + agent** surface. All commands take `--json` (stable
> shape for CI/agents). The full agent loop is documented in
> [`packages/cli/README.md`](../../packages/cli/README.md).

The container `baby wake` starts is **detached, so it persists** after the command exits; a later `home` /
`reset` / `sleep` (a separate process) rediscovers it by a per-project label and recovers the minted password
from `docker inspect` — no password is ever written to a file.

### `baby doctor`

The preflight that de-risks setup: Node major (`>=22`), a reachable Docker engine, a valid
`babystack.config.ts`, and a source-scan of `src/` for a too-early `DATABASE_URL` read (the
`ENV_READ_TOO_EARLY` heuristic — a **warning**, not a failure: it catches the #1 footgun of capturing the URL
at import before babystack injects it). Non-zero exit if a hard check fails.

```
baby doctor

  ✔ node      v22.10.0 (needs >=22; tested on 22, 24)
  ✔ docker    engine reachable
  ✔ config    1 service: db → mysql:8.4
  ✔ env-read  no import-time DATABASE_URL reads found in src/

all good.
```

### `baby wake` (alias `up`)

Provisions a real MySQL, runs your `baseline.build` (migrate + seed) once, caches the integrity-checked
baseline, and **leaves the container running**. Idempotent — a second `wake` reuses the running one.

`wake` is also where the baseline is **kept honest**: it hashes your config, `baseline.build` commands,
engine image, and the contents of every `baseline.invalidateWhenChanged` glob. When that hash still matches
the cached baseline it reuses in place; when it differs, `wake` **disposes the running container and
re-provisions a fresh one** — current image, freshly-built baseline, no stale per-worker databases. So after
you edit a migration or seed and re-run `baby wake`, the next `baby home` serves the **new** seed, never a
stale cached one (the trust cliff). Because a rebuild replaces the container, its port (and the `home` URL)
can change — re-run `baby home` after an input change. Force a rebuild anytime with `baby wake --rebuild`, or
set `BABYSTACK_NO_CACHE=1` to disable reuse entirely.

### `baby home` (alias `env`)

Prints eval-able shell exports for a fresh, disposable database loaded from the baseline — point a `mysql`
client, a manual `pnpm dev`, or a coding agent at seeded real data:

```bash
eval "$(baby home)"   # then e.g.  mysql "$DATABASE_URL"
```

### `baby reset`

Drops + recreates this project's single database and reloads the pristine baseline — with no container
re-provision (it skips the `mysqld` boot; the reload scales with your baseline's size).
The **fast "undo" for an agent** between attempts: the database name is stable, so the `DATABASE_URL` from
`baby home` is **unchanged across a reset**. Call `home` once, then `reset` as often as you like.

```bash
baby wake                 # once: a real, seeded MySQL, left running
eval "$(baby home)"       # export DATABASE_URL for this shell
#   … agent runs a migration / query, makes a mess …
baby reset                # back to the pristine baseline, same URL — try again
baby sleep                # done: dispose the container
```

Non-zero exit with `nothing is awake — run \`baby wake\` first` if no container is up. The end-to-end agent
loop (with a worked example) lives in [`packages/cli/README.md`](../../packages/cli/README.md).

### `baby sleep` (alias `down`)

Disposes this project's running container (explicit teardown). Idempotent — a second `sleep` is a no-op
(`--json` reports `disposed: 0`).

## Continuous integration

The suite runs the same locally and in CI — the difference is only where Docker lives. **Full guide:
[Running babystack in CI](./ci.md)** (GitHub Actions + CircleCI, the `localhost`-Docker gotcha, caching,
and troubleshooting). The essentials:

- **GitHub-hosted Linux runners ship Docker**, so no `services:` block is needed — babystack provisions its
  own container. Run the suite as usual after install/build.
- **First run pulls `mysql:8.4` (~500 MB)** — a real one-time cost hidden by "present locally" samples.
  Cache the Docker layer or the `.babystack/` dir if your CI supports it; optionally run `baby up` as a
  pre-step so the baseline is built before the test job.
- **GitHub macOS runners have no Docker** — run the Docker-backed suite on Linux. The macOS/Colima/OrbStack
  path is a local-dev story.

```yaml
# .github/workflows/test.yml (sketch)
jobs:
  test:
    runs-on: ubuntu-latest # Linux runners include Docker
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm test # babystack provisions MySQL itself
```

## Troubleshooting

| Symptom                                                                     | Cause                                                                                                                                               | Fix                                                                                                                            |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `ECONNREFUSED 127.0.0.1:3306` (or hits your dev DB)                         | App captured `DATABASE_URL` at **import** time, before `setupFiles` injected the per-worker URL.                                                    | Read it lazily (memoized getter / on first query). `baby doctor` scans `src/` and names the likely module (0.7).               |
| `DOCKER_UNAVAILABLE` / `baby doctor` shows Docker unreachable               | No Docker runtime running, or the socket isn't visible. There is no Docker-less path.                                                               | Start Docker Desktop/OrbStack (or `colima start`); re-run `baby doctor` until green. Check `DOCKER_HOST`/socket permissions.   |
| `BASELINE_BUILD_FAILED` (e.g. `command not found: prisma`)                  | A `baseline.build` command doesn't exist or fails — babystack runs _yours_ verbatim.                                                                | Run each command by hand against a scratch DB, then paste the exact working commands (migrate **before** seed) into `build`.   |
| Seed fails needing `NODE_ENV`/an API key/a second URL                       | `baseline.build` runs in a **scrubbed** env (only minted DB vars) — see limitations.                                                                | Phase 0 has no passthrough. Make the seed not depend on extra env, or wait for the Phase-1 build-env allowlist.                |
| Every test hits your **dev** DB despite babystack                           | App code calls `dotenv.config({ override: true })` / dotenv-flow, and a committed `.env` overrides the injected `DATABASE_URL`.                     | Don't `override` in test; or don't commit a `.env` with `DATABASE_URL`; or load dotenv only when babystack didn't set the var. |
| "port already allocated" / container won't start                            | A leftover babystack container from a killed run still holds resources (ports are ephemeral, so a clash with your own MySQL isn't the usual cause). | Reap manually: `docker rm -f -v $(docker ps -aq --filter label=babystack)` (auto-reap-on-start is still deferred).             |
| Leftover container after Ctrl-C / crash                                     | Teardown didn't run on a hard kill; auto-reap isn't wired yet. For a CLI session, `baby sleep` disposes it.                                         | Reap manually with the labeled `docker rm` above. `docker ps -a --filter label=babystack` shows only what babystack owns.      |
| App reads `DB_URL` / `MYSQL_URI` (not `DATABASE_URL`) → connects to nothing | Phase 0 injects `DATABASE_URL` + `MYSQL_*` only; no config knob to remap the var name yet.                                                          | Re-export it in a tiny setup file (`process.env.DB_URL = process.env.DATABASE_URL`) until a Phase-1 config option lands.       |

## Known limitations (Phase 0)

Deliberately narrow — the wedge is "the MySQL + Vitest path, flawless." Not yet in scope:

- **MySQL only, exactly one service.** Redis/S3/AWS type-check but have no adapter. If your app _also_ needs
  Redis/mail/etc., **keep your existing compose for those** — babystack Phase 0 replaces only the MySQL part.
- **Scrubbed build _env_.** `baseline.build` commands receive only safe basics (`PATH`/`HOME`/`LANG`) + the
  minted DB creds — never your ambient shell env, so a seed can't inherit your real `DATABASE_URL`/cloud
  keys from the environment. If a seed _does_ print a secret to stderr, babystack **redacts** secret-shaped
  output (URL credentials, `key=value` secrets, AWS keys, the minted password) before it reaches an error or
  log. **It is still an env-var boundary, not a filesystem sandbox:** a seed runs as you and can read files
  like `~/.aws/credentials` (host-side seeds are your own trusted code in Phase 0; a tighter FS sandbox is a
  later item). A migrate/seed needing other vars will fail until a Phase-1 allowlist.
- **`DATABASE_URL` + `MYSQL_*` are hardcoded** — no custom env-var-name mapping yet.
- **Invalidation covers the `baby wake` path only.** `baby wake` rebuilds the baseline when your config,
  `baseline.build` commands, image, or watched (`invalidateWhenChanged`) files change — with `--rebuild` /
  `BABYSTACK_NO_CACHE=1` to force it. The Vitest path is not yet cache-aware across runs: it rebuilds the
  baseline every run (always fresh, never stale — cross-run reuse there is a Phase-2 speed item).
- **Per-file (not per-test) reset.** `truncate` is cut.
- **You must gitignore `.babystack/` yourself** (no `baby init` to do it). The cached `dump.sql` contains
  your full seed data in plaintext — don't commit it.
- **Fidelity caveats.** It's a real `mysql:8.4`, but a fresh single host connected as **root** (not prod
  grants — can mask permission bugs), with no replication, and possibly a different version/`sql_mode`/
  collation than prod. Pin `image` (and later a `my.cnf`) to match production.

## Trying it today (pre-alpha)

`v0.1.0` is on npm, so the `pnpm add` / `baby` commands above work directly. To run the complete example
app (or hack on babystack itself), work from the repo:

```bash
git clone https://github.com/babystack/babystack && cd babystack
pnpm install
# with Docker running — the complete runnable example (real Express + Drizzle + MySQL):
pnpm --filter users-api test
```

The [`examples/users-api`](../../examples/users-api) app is the copy-paste-able, runnable proof: a real
Express + Drizzle + MySQL API whose `supertest` suite runs against fresh, seeded, isolated real MySQL via
babystack, with **zero babystack imports** in the tests. Read its README for the annotated walkthrough.
Or just `pnpm add -D @babystack/vitest` — `v0.1.0` is on npm.

## Where this is going

The **same** core lifecycle (provision → seed baseline → per-lease DB → inject → dispose over the real
engine) later gets a second front end — **`@babystack/mcp`** (Phase 2.5) — so a local coding agent (Claude
Code, Cursor) can get its own fresh, seeded, disposable real MySQL over MCP and reset between attempts,
**without ever touching your real dev/prod services**. Multi-engine breadth (Redis, S3/MinIO, the AWS slice
via LocalStack) is pull-driven after that. See the [roadmap](../ROADMAP.md).
