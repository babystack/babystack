# Roadmap

babystack gives every test run and every AI-agent session its own fresh, seeded, disposable copy of the
**real** backing services your app uses — real MySQL first, in Docker, injected as a normal connection URL
and thrown away after. It's config-first: your test code never changes.

This page is a high-level view of what works today and where it's headed. It's a living document, not a
promise — see the note at the bottom.

## Table of contents

- [Shipped today](#shipped-today)
- [Engines: MySQL only, for now](#engines-mysql-only-for-now)
- [Planned / exploring](#planned--exploring)
- [A note on priorities](#a-note-on-priorities)

## Shipped today

**`v0.1.0` is published on npm** (`babystack` + `@babystack/{core,docker,mysql,runtime,vitest,cli}`).
Everything below is implemented and covered by tests (unit + real-Docker integration in CI).

### The Vitest wedge — fresh, seeded, isolated real MySQL

- **One config file, zero test-code changes.** Describe your backend in `babystack.config.ts`; add three
  lines to `vitest.config.ts` (`globalSetup`, `setupFiles`, `pool: 'forks'`). Your tests just read
  `process.env.DATABASE_URL`, exactly like production — the app can't tell it's in a test.
- **Per-worker isolation under real parallelism.** One `mysqld` container, a fresh database per Vitest
  worker (keyed by `VITEST_POOL_ID`), each reloaded from the baseline per test file. Proven with a 4-file
  suite on forked workers, each seeing only its own seed — green across repeated runs.
- **Seeded baseline, built once.** babystack runs _your_ migrate + seed commands once, `mysqldump`s the
  result into an integrity-checked baseline, and reloads it per worker — the expensive work happens cold,
  once.

### The `baby` CLI — an operator & AI-agent surface

A single `baby` binary (every command supports `--json`):

| Command               | What it does                                                               |
| --------------------- | -------------------------------------------------------------------------- |
| `baby doctor`         | preflight — checks Node, a reachable Docker engine, and your config        |
| `baby wake` (`up`)    | provision + seed a real MySQL and leave it running                         |
| `baby home` (`env`)   | print an eval-able `DATABASE_URL` for the running stack                    |
| `baby reset`          | reload a pristine DB from the baseline — the agent's undo, no re-provision |
| `baby sleep` (`down`) | dispose this project's stack                                               |

The container `wake` starts is detached, so later commands rediscover it across separate invocations. This
is the agent loop: an AI coding agent gets a real, disposable backend for a session and can `baby reset`
between attempts — without ever touching your real dev/prod services.

### Conservative cache invalidation (the trust cliff)

`baby wake` hashes your config, build commands, engine image, and the contents of every watched
migration/seed file. It reuses a cached baseline only on an exact match; on any change (or an explicit
`--rebuild` / `BABYSTACK_NO_CACHE=1`) it rebuilds and re-provisions, so a changed migration can never serve
stale seed. Correctness before speed: a cache that serves stale state is worse than no cache.

### Safety off the happy path

- **Checksum-verified baselines** — the cached dump's sha256 is verified before every load
  (`BASELINE_CORRUPT` on a corrupt/truncated cache), and written atomically.
- **Secret redaction** — URL credentials, `key=value` secrets, AWS keys, and the minted DB password are
  scrubbed from every adapter error before it can reach a log.
- **Credential boundary** — tests and agents only ever receive disposable connection URLs. No real
  dev/prod credentials reach a test, an agent, or the logs.

### A runnable proof

[`examples/users-api`](../examples/users-api) is a complete Express + Drizzle + MySQL app whose `supertest`
suite runs against fresh, seeded, isolated real MySQL with **zero babystack imports** — including a real
`UNIQUE(email)` 409 that a mock would let pass. With Docker running: `pnpm --filter users-api test`.

## Engines: MySQL only, for now

**Today babystack implements exactly one engine — real MySQL.** The config format is intentionally designed
"wide" (it accepts `redis`, `minio`/S3, `dynamodb-local`, `elasticmq`/SQS, and `localstack` service types,
with editor autocomplete), but **those adapters are not built yet** — a non-MySQL service fails fast at
runtime. The whole-stack examples in the docs are labeled "where this is going," not today's behavior. The
guiding principle for every future engine is **orchestrate & delegate, never emulate**: run the real engine
(or drive LocalStack for the AWS tail) — never reimplement a proprietary API. The **priority next engine is
Postgres** — a second SQL engine (not everyone runs MySQL in production), which joins the config union when
its adapter lands.

## Planned / exploring

None of these are committed and none have dates — they're the directions we find interesting. If one
matters to you, [open an issue](https://github.com/babystack/babystack/issues) and say so.

- **Warm-pool speed** — pre-warmed connection pools + async reset, so per-file setup gets cheaper. Speed
  lands _after_ cache correctness, and any number we publish is measured, with methodology — we never claim
  "instant."
- **Cross-run baseline reuse on the Vitest path** — today the Vitest path rebuilds the baseline every run
  (always fresh, never stale); reusing it across runs is a speed opt-in.
- **More engines — Postgres first.** A second SQL engine is the top priority (not everyone runs MySQL);
  Postgres also has `CREATE DATABASE … TEMPLATE`, a server-side clone that enables faster per-worker
  provisioning than MySQL's dump→reload — so it's the strongest speed story, not a grudging add. After
  Postgres: Redis, MinIO (real S3), the AWS tail via LocalStack (SNS/SQS/…), then DynamoDB Local /
  ElasticMQ. Breadth is pull-driven — it grows when there's real demand.
- **The agent data plane over MCP** — the same seeded, resettable stack exposed to AI coding agents
  (Claude Code, Cursor) through MCP, alongside the `baby` CLI that already serves it.
- **`baby init`** — auto-detect your migrate/seed commands and scaffold `babystack.config.ts` (today you
  hand-write it).

## A note on priorities

babystack is a spare-time project, so priorities can and will shift, and nothing here is a commitment or a
schedule. The best way to influence what gets built next is to
[open an issue](https://github.com/babystack/babystack/issues) — to discuss an idea, report a bug, or tell
us something behaved wrong. Contributions are welcome — see [`CONTRIBUTING.md`](../CONTRIBUTING.md).
