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

Releases are **automated via Changesets + GitHub Actions** — no manual `npm publish`, no OTP, no
long-lived `NPM_TOKEN`. Publishing authenticates with **npm Trusted Publishing (OIDC)** and attaches a
signed provenance attestation. The flow:

1. **Every user-facing PR** adds a changeset (`pnpm changeset`) describing the bump.
2. On merge to `main`, [`.github/workflows/release.yml`](./.github/workflows/release.yml) keeps a
   **"Version Packages" PR** open that applies the pending changesets (version bumps + CHANGELOG).
3. **Merging that Version Packages PR** is what ships a release: the workflow detects a public package
   whose local version is ahead of the registry, pauses on the `release` Environment for a manual
   approval, then runs `pnpm run release` (`turbo run build && changeset publish`) — publishing only the
   bumped packages, tokenlessly, and pushing git tags + a GitHub Release each.

**One-time setup (maintainer, done outside the repo):**

- **npm** → each public package (`babystack`, `@babystack/{core,cli,docker,mysql,runtime,vitest}`) →
  Settings → **Trusted Publisher**: GitHub Actions, repo `babystack/babystack`, workflow `release.yml`.
- **GitHub** → Settings → **Environments** → create `release` with the maintainer as a **required
  reviewer** (that reviewer is the approval gate).

## Design principles you must not break

1. **Orchestrate & Delegate, never Emulate** — run the real engine, or drive LocalStack. Never
   reimplement a proprietary API.
2. **Pure core** — `@babystack/core` imports no Docker SDK, no adapter, no raw I/O. Adapters depend on
   core, never the reverse (dependency-cruiser enforces this).
3. **Honest speed** — never claim "instant"/"single-digit-ms clone." Pools + per-worker DBs + async reset,
   with published measured numbers.
4. **No real credentials** ever reach tests, agents, or logs.
5. **Every seam implementation passes its conformance suite.**
