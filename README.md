<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.png" />
  <img alt="babystack — a baby dolphin peeking out of a stacked box" src="assets/logo-light.png" width="180" height="180" />
</picture>

# babystack

**Real MySQL, fresh every run — a local baby of your production stack.**

_Every test run and every AI-agent session gets its own private, seeded, disposable copy of the **real**
services your app uses — spun up in Docker, injected as env vars, thrown away after. No shared dev DB, no
mocks, no lifecycle code in your tests._

[![CI](https://github.com/babystack/babystack/actions/workflows/ci.yml/badge.svg)](https://github.com/babystack/babystack/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
![Status: pre-alpha](https://img.shields.io/badge/status-pre--alpha-orange)

</div>

> [!WARNING]
> **Pre-alpha / scaffold.** The interfaces and the MySQL + Vitest path are under active construction.
> Not yet published to npm. Watch the repo — the first working release is the MySQL-on-Vitest wedge.

## Table of contents

- [The pitch](#the-pitch)
- [Before / after](#before--after)
- [Quickstart](#quickstart)
- [How it works](#how-it-works)
- [Why not just Testcontainers or Docker Compose?](#why-not-just-testcontainers-or-docker-compose)
- [On speed (the honest version)](#on-speed-the-honest-version)
- [Two wedges, one engine](#two-wedges-one-engine)
- [Principle: orchestrate & delegate, never emulate](#principle-orchestrate--delegate-never-emulate)
- [Status & roadmap](#status--roadmap)
- [Packages](#packages)
- [Contributing](#contributing)
- [License](#license)

## The pitch

You describe your backend **once** — the real MySQL, Redis, an S3-compatible store, the AWS bits — in a
single config file. babystack provisions those **real engines** in Docker, seeds them into a reusable
baseline, hands each test (or AI agent) its own fresh, isolated copy over a normal connection string, and
disposes of it afterward. Your test code doesn't change: it just reads `process.env.DATABASE_URL`, exactly
like production.

It's **not** an emulator. Your app talks to a real `mysql:8` server and can't tell it's in a test.

## Before / after

```diff
- # docker-compose.test.yml + 180 lines of setup/teardown + a shared dev DB that flakes
- beforeAll(async () => { /* boot db, run migrations, seed, wire env… */ })
- afterEach(async () => { /* truncate tables, hope nothing leaked… */ })
+ // babystack.config.ts — describe the stack once. Tests stay clean.
+ // npm test → fresh, seeded, isolated real services, in parallel, gone after.
```

## Quickstart

```bash
pnpm add -D @babystack/vitest   # one package — pulls the engine transitively
# No auto-detect yet: hand-write babystack.config.ts + 3 lines in vitest.config.ts
#   (globalSetup, setupFiles, and pool: 'forks')
pnpm test              # just works — no test-code changes
```

```ts
// babystack.config.ts — describe your backend once
import { defineConfig } from '@babystack/vitest' // re-exported here (one-package install)

export default defineConfig({
  services: {
    db: {
      engine: 'mysql',
      image: 'mysql:8.4',
      baseline: { build: ['pnpm db:migrate', 'pnpm db:seed:test'] },
    },
    // Redis, S3 (MinIO), and the AWS slice (LocalStack) land as the tool grows — see the roadmap.
    // (Where this is going: cache: { engine: 'redis' }, files: { engine: 'minio', buckets: ['uploads'] },
    //  aws: { engine: 'localstack', services: ['sns', 'sqs'] })
  },
})
```

```ts
// your test — UNCHANGED. it just reads env, like prod.
test('creates a user', async () => {
  const res = await api.post('/users', { name: 'Ada' })
  expect(res.status).toBe(201)
})
```

A `baby` CLI (operator & **agent** surface, all `--json`) shipped in 0.7: **`baby doctor`** (preflight),
**`baby wake`** (provision + seed a real MySQL, left running), **`baby home`** (`eval "$(baby home)"` → a
`DATABASE_URL`), **`baby reset`** (reload a pristine DB with no re-provision — the agent's undo), **`baby sleep`**
(dispose) — so a coding agent gets a real, disposable backend across a session and can wipe it between
attempts. The full agent loop is in [`packages/cli/README.md`](./packages/cli/README.md); **step-by-step
usage:** [docs/guide/getting-started.md](./docs/guide/getting-started.md).

**Want to see it run?** [`examples/users-api`](./examples/users-api) is a complete, real app — Express +
Drizzle + MySQL — whose tests run against fresh, seeded, isolated real MySQL with zero babystack imports.
With Docker running: `pnpm install && pnpm --filter users-api test`.

## The pipeline — how you use it

Set up once per repo; after that it's just `pnpm test`, everywhere:

```
① set up once        →  ② pnpm test          →  ③ baby home       →  ④ CI                →  ⑤ agents
   install +               fresh seeded DB /       a throwaway          same pnpm test,        baby wake +
   hand-write config       worker, parallel,       seeded dev DB        cache reused           reset loop
                           gone after              (baby wake first)                           (CLI)
```

_② (the Vitest wedge), ③ (`baby wake`/`home`/`sleep`) and ⑤ (the agent `baby reset` loop) all work today —
see the roadmap for what's next (warm-pool speed, more engines)._

Visual walkthroughs live in [`site/`](./site/): **[how you use it](./site/usage.html)** ·
**[the internals](./site/design.html)**. The written version is [docs/guide/getting-started.md](./docs/guide/getting-started.md).

## How it works

```
vitest globalSetup
  → read babystack.config.ts
  → provision the real engine in Docker (MySQL first; Redis/S3/AWS-via-LocalStack later)
  → build the seeded baseline once (migrate + seed → mysqldump)
  → hand each Vitest worker its own fresh database (one mysqld, a DB per VITEST_POOL_ID); inject DATABASE_URL
your tests run against the real, seeded DB (in parallel, isolated)
vitest teardown
  → dispose (and reap any orphans on next start)
```

## Why not just Testcontainers or Docker Compose?

- **Testcontainers** gives you raw disposable containers **from inside your test code**, and has no MySQL
  snapshot/reset at all. babystack is **config-first (zero lifecycle code in tests)**, unifies your
  **whole stack** (incl. the AWS slice via LocalStack), and owns the seed → baseline → reset lifecycle.
- **Docker Compose** runs static services. No named baselines, no per-run reset, no runner injection, no
  invalidation, no seeding lifecycle.

## On speed (the honest version)

babystack does **not** claim "instant" or "single-digit-millisecond clones" for MySQL — MySQL has no
in-server template clone, and a real `mysqld` takes seconds to boot. Speed comes from **per-worker
databases (one `mysqld`, a database per Vitest worker) + baseline reuse + async reset**, so tests run **in
parallel against isolated real DBs**. We lead with the before/after DX diff, not a benchmark number; any
number we publish is measured, with methodology. The real win over a shared dev DB is parallel isolation
and determinism; over `BEGIN/ROLLBACK` it's correctness for committed transactions, DDL, and
multi-connection code.

## Two wedges, one engine

The core lifecycle (provision → wait-ready → build seeded baseline → per-worker lease → inject → dispose,
over real engines) powers two surfaces:

- **`@babystack/vitest`** — fresh seeded real services for your integration tests. _(Ships first.)_
- **`@babystack/mcp`** — a local, resettable, seeded stack for AI coding agents (Claude Code, Cursor) over
  MCP, so an agent can experiment against a **real** backend and reset between attempts — **without ever
  touching your real dev/prod services**. _(Follows.)_

## Principle: orchestrate & delegate, never emulate

- **Orchestrate** the real engine (real MySQL, Redis, MinIO=real S3 server) and manage its lifecycle.
- **Delegate** to LocalStack for AWS services with no real local engine (Lambda, SNS, SQS, …).
- **Never emulate** — we never reimplement MySQL/S3/AWS ourselves. A fake gives false confidence.

## Status & roadmap

Pre-alpha. **The Vitest wedge, the `baby` CLI + agent data-plane, and conservative cache invalidation all
work end-to-end.** A config resolver + `globalSetup`/`setup` hooks provision a seeded real-MySQL stack and
hand each worker a fresh leased DB over `DATABASE_URL`, **proven under real parallelism** (a 4-file suite on
forked workers each get their own isolated database from **one baseline built once**, green across repeated
runs, ~7s cold). Safety added checksum-verified baselines + secret redaction. The `baby` CLI provisions a
persistent seeded MySQL, rediscovers it across separate commands by label, and `baby reset` reloads a
pristine DB with no container re-provision — the agent's undo loop. Cache invalidation hashes your
config/migrations/seed, so a changed input rebuilds rather than serving stale seed (the trust cliff).
**Next: warm-pool speed.** Build order: MySQL + Vitest (flawless) → the `baby` CLI + agent mode
(**CLI-first**, MCP optional) → warm-pool speed → multi-engine breadth (Redis, MinIO, DynamoDB Local,
ElasticMQ, LocalStack). See [how you'll use it](./docs/guide/getting-started.md) and the
[roadmap](./docs/ROADMAP.md).

## Packages

| Package              | What it is                                                                                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@babystack/core`    | Config, lifecycle, the `EngineAdapter` seam + `Lease`/`Pool`, injected `Clock`/`CommandRunner` ports, invalidation, env injection. Pure core (no I/O).                                                     |
| `@babystack/docker`  | Generic Docker muscle (provision · authenticated `waitReady` · idempotent dispose · label-scoped GC) + the `NodeCommandRunner`/`SystemClock` runtime ports. Engine-agnostic; the engine adapters drive it. |
| `@babystack/mysql`   | Real-MySQL engine adapter (provision, build baseline, per-worker leased databases).                                                                                                                        |
| `@babystack/runtime` | Shared config→adapter resolver + provision/lease helpers (`loadConfig`, `createMysqlAdapter`, …); consumed by `@babystack/vitest` and `@babystack/cli`.                                                    |
| `@babystack/vitest`  | Vitest `globalSetup`/`setupFiles` integration.                                                                                                                                                             |
| `@babystack/cli`     | The `baby` CLI (operator/agent surface, `--json`).                                                                                                                                                         |

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). A fresh clone must pass
`install → lint → format:check → typecheck → test → build` with no manual setup.

## License

[Apache-2.0](./LICENSE) © Sharvil Kadam
