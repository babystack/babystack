# @babystack/runtime

The shared **session/lifecycle layer** for [babystack](https://github.com/babystack/babystack) — the piece
that both `@babystack/vitest` and `@babystack/cli` build on, so they share one resolver with no
vitest↔cli dependency.

It turns your `babystack.config.ts` into a provisioned, seeded stack: `loadConfig`, provision helpers,
baseline invalidation + caching, per-worker `leaseEnv`/`ensureEnv`, and the `wake`/`sleep`/`findRunning`
session commands the `baby` CLI is built from.

This is an internal building block — you install `@babystack/vitest` (the test wedge) or `babystack` (the
CLI), not this directly. For the full picture, see the
[babystack repository](https://github.com/babystack/babystack). Licensed **Apache-2.0**.
