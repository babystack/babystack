# Contributing to babystack

Thanks for helping! babystack is an open-core, Apache-2.0 project. This repo follows a consistent
engineering handbook shared across the maintainer's projects; the essential rules are inlined below.

## Table of contents

- [The bar](#the-bar)
- [Setup](#setup)
- [Branching & commits](#branching--commits)
- [The adversarial review gate](#the-adversarial-review-gate)
- [Releasing](#releasing)
- [Design principles you must not break](#design-principles-you-must-not-break)

## The bar

> A fresh clone passes `install → lint → format:check → typecheck → test → build` with no manual setup.

CI runs the same sequence on every push and PR; nothing merges red.

## Setup

```bash
corepack enable
pnpm install
pnpm run check          # lint → format:check → typecheck → test → build
```

Integration tests need a running Docker engine:

```bash
pnpm run test:integration
```

## Branching & commits

- Branch off `main`: `feature/<slug>`, `fix/<slug>`, `chore/<slug>`. Docs-only may go straight to `main`.
- **Conventional commits** (`feat:`/`fix:`/`chore:`/`docs:`/`refactor:`/`test:`), imperative mood.
- **Squash-merge**; delete the branch (remote + local) after merge.
- Never `--no-verify`; never add `Co-Authored-By` trailers.
- Add a Changeset for any user-facing change: `pnpm changeset`.

## The adversarial review gate

Before merging any phase or sub-phase, run an adversarial review (parallel reviewers across:
correctness end-to-end · bug-hunt · security · scale/perf · code-quality/standards · testing-quality ·
docs/spec-fidelity · anything-else). Fix real findings in the same change or log them (severity +
deferral) in [docs/ROADMAP.md](./docs/ROADMAP.md).

## Releasing

Releases are **automated, tokenless, and human-gated** — you never run `npm publish` by hand. In your
feature PR, add a changeset (`pnpm changeset`); merging the resulting "Version Packages" PR triggers a
gated publish via **npm Trusted Publishing (OIDC)** with provenance.

The full map — the step-by-step, the one-time npm/GitHub setup, the break-glass path, and
troubleshooting — is in **[RELEASING.md](./RELEASING.md)**.

## Design principles you must not break

1. **Orchestrate & Delegate, never Emulate** — run the real engine, or drive LocalStack. Never
   reimplement a proprietary API.
2. **Pure core** — `@babystack/core` imports no Docker SDK, no adapter, no raw I/O. Adapters depend on
   core, never the reverse (dependency-cruiser enforces this).
3. **Honest speed** — never claim "instant"/"single-digit-ms clone." Pools + per-worker DBs + async reset,
   with published measured numbers.
4. **No real credentials** ever reach tests, agents, or logs.
5. **Every seam implementation passes its conformance suite.**
