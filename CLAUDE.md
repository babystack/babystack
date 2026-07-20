# CLAUDE.md — babystack

babystack is an open-source dev tool: every test run / local dev session / AI-agent session gets its own
fresh, seeded, disposable copy of the app's **real** backing services in Docker — **real MySQL today**.
Redis, MinIO=S3, DynamoDB Local, ElasticMQ=SQS, and LocalStack for the AWS tail are on the roadmap (the
config types accept them, but no adapter is built yet). **Pre-alpha.**

Personal project (not affiliated with any employer), committed under the maintainer's personal git identity;
license is **Apache-2.0** (a deliberate OSS choice).

**Docs.** User-facing docs live in `docs/guide/` (getting-started + **api-reference**) and the public
roadmap in `docs/ROADMAP.md`. Detailed design/decision records, `research/`, and `usecases/` are kept
**private** — planning material, not published in the public package.
Project state is the roadmap. The principles/conventions below are this project's engineering baseline.

## Principles

Build by these (full version + updates in the handbook):

- **SOLID** — single responsibility; extend via composition; substitutable implementations; small
  interfaces; depend on abstractions (inject deps).
- **DRY** — one source of truth; derive state, don't duplicate it; reuse before adding.
- **KISS / YAGNI** — the simplest thing that works; build for today's requirement. Over-engineering is a
  failure. (We **architect wide** via interfaces but **launch narrow** — MySQL+Vitest first.)
- **Fail fast, typed errors** — validate at boundaries; typed errors or `Result` values, never strings.
- **Security by default** — validate untrusted input; least privilege; no secrets in code or logs.
- **Determinism where it matters** — inject `Clock`/`CommandRunner` (and an `Rng` when needed); keep a
  **pure core**, lint-enforced.
- **Readable over clever; boy-scout rule** — leave it cleaner; delete dead code/assets.

## Conventions

- **Tests** under `tests/` mirroring `src/` (not co-located); no untested code; deterministic; name tests
  after the spec/invariant id; integration tests under `tests/integration/`.
- **Branching** off `main` (`feature/`/`fix/`/`chore/`); **squash-merge**; **delete the branch (remote +
  local) after merge**; code PRs wait for approval; docs-only may go straight to `main`. Never
  `--no-verify`; never `Co-Authored-By`.
- **Docs** — user-facing in `docs/guide/` (getting-started + api-reference), public roadmap
  `docs/ROADMAP.md`; detailed design/decision records, `research/`, and `usecases/` are kept **private**;
  every doc has a TOC. **Sync discipline:** the roadmap keeps a detailed **private** copy (with
  deferred-defect/severity notes) mirrored to the public `docs/ROADMAP.md` — keep the two in sync; keep
  `docs/guide/getting-started.md` current after every meaningful change. **The API reference
  (`docs/guide/api-reference.md`) is the single source of truth for the public surface — update it in the
  SAME change as any new/renamed/removed export, config field, CLI flag, env var, or error code.**
- **Strict typing**; discriminated unions over class hierarchies; `readonly` state; ESM-first with
  default-export interop for CJS deps; pluggable seams behind explicit interfaces, each with a
  **conformance suite** every implementation must pass.

**Project-specific (what differs from / adds to the handbook):**

- **Orchestrate & Delegate, never Emulate.** Adapters either (a) run the _real_ engine and manage its
  lifecycle, or (b) drive LocalStack. **Never** reimplement a proprietary API (MySQL/S3/AWS) ourselves —
  that is the one unforgivable architectural sin here.
- **Compose, don't compete.** babystack is the opinionated DX / orchestration / agent layer ON TOP of
  primitives — it consumes Docker, delegates to LocalStack, and reserves the snapshot-driver seam so that IF
  Docker/Testcontainers ships a MySQL snapshot, we **adopt** it as a faster reset driver, never fight it. The
  durable value is config-first / zero-test-code / whole-stack / agent DX, not any single primitive. The
  vision is the **LocalStack-analog** (whole real backend, across test/dev/CI/agents); MySQL+Vitest is the
  wedge; breadth is pull-driven.
- **Pure core seam.** `@babystack/core` holds config + lifecycle + the `EngineAdapter` seam, the
  `Lease`/`Pool` types, and the injected `Clock`/`CommandRunner` ports, and imports **no** Docker SDK, no
  sibling adapter, and no raw I/O (enforced by `.dependency-cruiser.cjs` — including a `core-no-node-io`
  rule — and an ESLint rule banning `Date.now`/`Math.random` in core). Adapters depend on core, never the
  reverse.
- **Every adapter passes the shared conformance suite** for its seam. A new engine isn't "done" until it
  passes `EngineAdapter` conformance.
- **Honest speed — a hard rule.** Never claim, market, or benchmark "instant" or "single-digit-millisecond
  clone" for MySQL (it's false: no in-server template; ~1–5s `mysqld` boot; no reflink on macOS Docker).
  Speed comes from **pre-warmed pools + per-worker DBs + async reset**. Publish measured numbers + method.
- **Credential boundary.** Tests and agents only ever receive disposable connection URLs — never real
  dev/prod source credentials. Any future prod-import path masks by default and refuses unsafe imports.
- **CLI binary is `baby`** (package `@babystack/cli`): `baby doctor|wake|home|reset|sleep`
  (aliases `up`→wake, `env`→home, `down`→sleep), all `--json`. (`new`/`create`/`logs` are deferred, not yet
  built.) Config file: `babystack.config.ts`.
- **Two wedges, one engine:** `@babystack/vitest` (ships first) and `@babystack/mcp` (local agent data
  plane, follows) sit on the same core lifecycle. **Launch is test-wedge-only;** MCP is the Phase-2.5 follow.
- **Isolation model:** per-worker DATABASES inside one `mysqld` container, keyed by `VITEST_POOL_ID` (never
  a container per worker). The acquired unit is a `Lease { instance, database, url }`; core owns a small
  Pool seam. **Each worker DB is reloaded fresh from the baseline per test FILE** (`setupFiles`); tests
  within a file share committed state. Drop `SnapshotDriver`/`clone()` until a 2nd strategy (COW) exists.
- **The proof is the `examples/` app, not an external repo.** A real production MySQL + Node backend is an
  optional later benchmark — never a dependency or the definition of done.

## Commands

CI runs exactly these and all must pass (pnpm):

- `pnpm run lint` · `pnpm run format:check` · `pnpm run typecheck` · `pnpm run test` · `pnpm run build`
- `pnpm run test:integration` — Docker-backed adapter/lifecycle tests (needs a running Docker engine).

A fresh clone must pass `install → lint → format:check → typecheck → test → build` with no manual setup.

## Per-phase / per-task working process

1. **Branch off `main`** (docs-only may go straight to `main`).
2. **Build with tests, not after** — no untested behavior; conformance suites for the seams.
3. **Adversarial review gate — after every phase AND sub-phase.** Spawn parallel subagents across the
   handbook lenses (correctness/logic end-to-end · bug-hunt · security · scale/perf ·
   code-quality/standards · testing-quality · docs/spec-fidelity · anything-else). Fix real findings in
   the same change or log them with a severity + deferral in the roadmap.
4. **Commit and push always**; open/update the PR.
5. **Update the roadmap** (detailed private copy mirrored to the public `docs/ROADMAP.md`) — it must
   never lag reality.

## Project-specific invariants

- **Never emulate.** If an adapter starts reimplementing a proprietary API, stop — run the real engine or
  delegate to LocalStack.
- **The app can't tell it's in a test** — it connects over a normal connection string to a real engine.
- **No real dev/prod credentials** ever reach a test, an agent, or the logs.
- **Baseline is built outside the hot path** and reused; rebuilt only when the invalidation hash changes.
- **Engine, not a test tool.** babystack is _the engine that hands you a fresh, seeded, disposable real
  backend_; MySQL+Vitest is the first delivery vehicle. **Broaden by re-exposing the one engine to a new
  _consumer_ (local-dev, CI, agents), never by acquiring a new _problem domain_** (data generation, masking,
  hosting).
- **Cache correctness before speed (the trust cliff).** A cache that serves stale seeded state is worse than
  no cache — ship conservative invalidation + explicit opt-out before any speed path.
