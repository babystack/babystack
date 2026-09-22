# Releasing babystack

New versions of the `babystack` CLI/flagship and the `@babystack/*` packages are published by an
**automated, tokenless, human-gated** pipeline — you never run `npm publish` or `changeset publish` by
hand. This is the map to that pipeline (which lives in
[`.github/workflows/release.yml`](.github/workflows/release.yml)).

## Table of contents

- [TL;DR — cutting a release](#tldr--cutting-a-release)
- [What the automation does](#what-the-automation-does)
- [Pre-flight guards](#pre-flight-guards)
- [One-time setup](#one-time-setup)
- [Bootstrapping a new package name](#bootstrapping-a-new-package-name)
- [Verifying a release](#verifying-a-release)
- [Manual / break-glass release](#manual--break-glass-release)
- [Troubleshooting](#troubleshooting)

## TL;DR — cutting a release

1. **In your feature PR, add a changeset:** `pnpm changeset` — pick the affected packages, the bump type
   (patch / minor / major), and write a one-line summary. Commit it.
2. **Merge the feature PR.** A bot opens or updates a **"Version Packages"** PR that bumps versions and
   writes changelogs from the accumulated changesets.
3. **Merge the "Version Packages" PR** when you're ready to release. The Release workflow runs and **pauses
   for approval** on the `release` environment.
4. **Approve the deployment** (the run → _Review deployments_ → approve `release`). It publishes every
   bumped package to npm — **tokenless via OIDC, with provenance** — then pushes git tags and opens a
   GitHub Release per package.

No local publish commands. Adding the changeset (step 1) is the only thing you do differently while coding.

## What the automation does

[`release.yml`](.github/workflows/release.yml) runs on every push to `main`, in two jobs:

- **`prepare`** (no gate) — runs `changeset version` (via `changesets/action`) to keep the "Version
  Packages" PR current, **verifies the approval gate actually exists** (see below), then checks whether any
  publishable package's local version is **missing from the npm registry** (i.e. the Version PR was just
  merged). That check decides whether a real publish is due, and it **fails closed**: a registry timeout or
  5xx aborts the run rather than being read as "not published".
- **`publish`** (gated by the **`release` environment** → your manual approval) — runs **only when a publish
  is due**. It upgrades npm to ≥ 11.5.1, builds, and runs `pnpm run release` (`turbo run build &&
changeset publish`), which uploads each not-yet-published package. Authentication is the GitHub **OIDC**
  token (there is **no `NPM_TOKEN`**), and `NPM_CONFIG_PROVENANCE=true` attaches a signed provenance
  attestation. Before it publishes, it **re-runs the complete CI gate** against the exact commit being
  released — a green `main` is necessary but not sufficient, because `main` went green on a merge commit and
  this is the tree that becomes a tarball — and then runs the [pre-flight guards](#pre-flight-guards).

Because the gate is on `publish`, and `publish` runs only when a version is ahead of the registry, the
approval prompt appears **only for real releases** — never for an ordinary feature merge.

> **`environment: release` is a name, not a gate.** GitHub's documented behaviour is that running a workflow
> which references an environment that does not exist _creates_ it, and the created environment "will not
> have any protection rules". So a missing or reviewer-less environment does not fail the job — it silently
> removes the pause, and neither the workflow file nor this document changes by a character. This repo
> shipped in exactly that state: the workflow and this page both described an approval gate while the repo
> had **zero** environments configured. `prepare` now verifies it on every run, CI verifies it on every PR
> (`scripts/check-release.mjs --environment`), and both **fail closed** if the API cannot be reached.

## Pre-flight guards

Everything that can still be _fixed_ is checked before the one step that cannot be undone. npm tarballs are
immutable outside a 72-hour window; every guard below is a read-only probe that costs seconds.

| Guard                     | Refuses when                                                                           | Why it exists                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Manifest count**        | `packages/*/package.json` does not match `EXPECTED_PACKAGES` (7) publishable manifests | A glob that comes up short makes every per-package loop below it iterate **zero times and pass**. Too _many_ is worse: a newly added package has no npm name and therefore no Trusted Publisher, and this pipeline is tokenless — it cannot create one.                                                                                                                                       |
| **Unbootstrapped name**   | a publishable package does not exist on the registry at all                            | A Trusted Publisher is a **per-package** setting that cannot be bound to a name that has never been published. `changeset publish` stops at the first failure, so the packages before it in the order are already on the registry, immutably, while the flagship never publishes. See [Bootstrapping a new package name](#bootstrapping-a-new-package-name).                                  |
| **Nothing to publish**    | _every_ publishable version is already on the registry                                 | `changeset publish` **silently skips** a version that is already there and exits 0. A re-run would go green having published nothing at all — indistinguishable from success in the log. (Skipping _some_ packages is normal and correct here: Changesets bumps only what changed, so an unchanged package keeps its version and must not be republished. Only "all of them" is the failure.) |
| **Still-private package** | a package that should publish carries `private: true`                                  | `changeset publish` skips those silently too. Caught by the manifest count, which names the offender. `@babystack/*` has no intentionally-private package today; if one is ever added, lower `EXPECTED_PACKAGES` deliberately rather than loosening the guard.                                                                                                                                |
| **Approval gate present** | the `release` environment is missing or has no required reviewer                       | See the box above.                                                                                                                                                                                                                                                                                                                                                                            |

Both registry probes **fail closed**. `npm view` exits non-zero for a missing name _and_ for a 5xx, a rate
limit or a timeout — so the guards classify on the error text and treat **only a clean 404** as "not
published". Anything else refuses rather than guesses.

`scripts/check-release.mjs` keeps `EXPECTED_PACKAGES` honest: it asserts the number still equals the real
workspace count and runs in CI on every PR, so **adding a package fails there** — where the fix is to
bootstrap its name — instead of failing mid-release with half the family already published. Run it yourself
with `pnpm run check:release` (offline) or `node scripts/check-release.mjs --environment` (also checks the
GitHub environment).

## One-time setup

Documented here so the pipeline can be rebuilt or audited. **v0.1.0 was published manually, before this
pipeline existed — so no version on npm today carries a provenance attestation.** The first release through
this pipeline will be the first attested one; until then, treat "provenance-signed" as a property of the
pipeline, not of what is currently on the registry.

**npm** (per published package — `babystack`, `@babystack/core`, `@babystack/cli`, `@babystack/docker`,
`@babystack/mysql`, `@babystack/runtime`, `@babystack/vitest`):

- Account-level 2FA enabled.
- Publishing access set to **"Require two-factor authentication and disallow tokens"** — bans automation
  tokens, so only interactive-2FA or the OIDC workflow can publish.
- A **Trusted Publisher** bound to repo `babystack/babystack`, workflow `release.yml`, environment
  `release`, action `npm publish`.

  > **This one is a by-eye checklist item, per package name, and no gate can cover it.** There is no
  > unauthenticated way to read whether a package has a Trusted Publisher bound, so nothing in CI or in
  > `release.yml` can confirm it. The failure is fail-safe rather than silent — OIDC auth is rejected and
  > the publish errors — but with `changeset publish` stopping at the first failure, a missing binding on
  > one package still leaves the ones published before it on the registry, immutably. **Verify all seven by
  > hand on npmjs.com before the first pipeline release.**

**GitHub:**

- A **`release` environment** with the maintainer as a **required reviewer** (this is the approval gate),
  deployments restricted to protected branches. Verified automatically on every CI run and at the start of
  every release — see [Pre-flight guards](#pre-flight-guards).
- `main` **branch-protected**: PRs required, force-pushes and deletions blocked.
- Account 2FA — ideally a passkey / hardware key (the account is the root of trust once tokens are gone).

## Bootstrapping a new package name

**Adding a package to `packages/` will fail CI**, deliberately, until you do this. That is the guard
working: this pipeline is tokenless, it authenticates against a **per-package** npm Trusted Publisher, and a
Trusted Publisher **cannot be bound to a name that has never been published**. So a brand-new name has no
way to publish through automation — and because `changeset publish` stops at the first failure, tagging
anyway would publish the packages that _do_ exist and then fail, leaving a partial release that npm will not
let you take back.

The order is fixed:

1. **Check the name is actually claimable.** A 404 on the name you want is _not_ proof. npm rejects a new
   name whose **punctuation-stripped** form matches an existing package, so check the stripped twin too:
   `npm view <name>` **and** `npm view <strippedtwin>`.
2. **Publish the name once by hand**, with interactive 2FA, at a prerelease version:
   ```bash
   cd packages/<new>
   npm publish --access public --tag rc      # requires npm >= 11.5.1 and your interactive 2FA
   ```
3. **Bind its Trusted Publisher** on npmjs.com → the package → Settings → Trusted Publisher: GitHub Actions,
   repo `babystack/babystack`, workflow `release.yml`, environment `release`. Set publishing access to
   **"Require two-factor authentication and disallow tokens"** while you are there.
4. **Raise `EXPECTED_PACKAGES`** in `.github/workflows/release.yml` to the new publishable count. CI goes
   green again, and the package releases with the family from then on.

Two traps that cost the sibling projects real time, both of which apply to step 2:

- **`latest` lands on a FIRST publish regardless of `--tag rc`.** npm sets `latest` when a package has no
  tags yet, and there is no undo — `npm dist-tag rm … latest` is refused. Expect it, and correct the tag
  once the first real release claims `latest`.
- **A bootstrap tarball is not installable, by design.** Its intra-workspace `workspace:^` dependencies
  resolve against versions the registry does not have yet. That is correct for the one job it does — _exist,
  so a Trusted Publisher has something to bind to_ — and wrong for every other use. Do not link it, document
  it, or suggest anyone install it.

If the family starts gaining packages often, the sibling project `cloudbitmaps` automates exactly this as
`scripts/bootstrap-publish.cjs` (`pnpm release:bootstrap`), with a dry run by default and every precondition
checked before anything is sent. It is not ported here because all seven names already exist and an
unexercised publish script is its own hazard.

## Verifying a release

A green run is not proof. Verify from the registry itself:

```bash
# Version + provenance attestation, straight from the registry (not a replica).
curl -s https://registry.npmjs.org/babystack | \
  node -p "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); d['dist-tags'].latest"
curl -s https://registry.npmjs.org/babystack/<version> | \
  node -p "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); JSON.stringify(d.dist.attestations ?? 'NO PROVENANCE')"
```

**Do not verify a fresh publish with `npm view`.** It reads a replica that lags for minutes after a publish,
so it will happily report the old version — or nothing — for a release that genuinely succeeded, and you
will chase a failure that did not happen. `npm access get status <pkg>` and the registry API above read
through. (`npm view` is fine for the _pre-flight_ guards, which run long before anything is published.)

A release is done when, for every package: the new version is on the registry, `dist.attestations` is
present (this is what provenance looks like from outside), and the GitHub Release exists for the tag.

## Manual / break-glass release

Only if the pipeline is down and a release cannot wait. Requires npm ≥ 11.5.1 and your **interactive npm
2FA** (automation tokens are disallowed by design):

```bash
pnpm install
pnpm run release      # = turbo run build && changeset publish
git push --follow-tags
```

Prefer the automated flow; this path exists so a broken pipeline never blocks a critical fix.

## Troubleshooting

- **No "Version Packages" PR appeared** — no changeset was added in the feature PR. Run `pnpm changeset`.
- **The `publish` job was skipped** — expected: no package version is ahead of the registry, so there was
  nothing to publish.
- **The run is stuck "waiting"** — it's paused on the `release` environment for your approval (_Review
  deployments_).
- **OIDC auth failed for a package** — its npm **Trusted Publisher** isn't set, or the repo / workflow /
  environment don't match. Fix it on npmjs.com → that package → Trusted Publisher. This is fail-safe in the
  sense that nothing _incorrect_ is published — but `changeset publish` stops at the first failure, so
  anything published before it in the order is already on the registry and cannot be unpublished. Re-run
  after fixing; the already-published packages are skipped.
- **"expected 7 publishable manifests, matched N"** — a package was added, removed, or flipped to
  `private: true`. If added, follow [Bootstrapping a new package name](#bootstrapping-a-new-package-name)
  _before_ raising `EXPECTED_PACKAGES`.
- **"X does not exist on the registry"** — same thing: the name was never published, so no Trusted Publisher
  can exist for it. Bootstrap it.
- **"every publishable version is already on the registry"** — there is nothing to release. The Version
  Packages PR hasn't been merged, or this is a re-run of a release that already completed.
- **"could not reach the registry to check X"** — a 5xx, a rate limit or a timeout. The guards **fail
  closed** on purpose: a probe that could not answer is never read as "safe to publish". Re-run the job.
- **"has no `release` environment" / "has NO required reviewers"** — the approval gate is gone. Recreate it
  under Settings → Environments before releasing; the workflow will not publish without it.
- **A release published but has no provenance** — check that the run used the `publish` job (not a manual
  `pnpm run release`), that `id-token: write` is still on that job, and that the runner was GitHub-hosted.
  A self-hosted runner has no OIDC identity to attest to and silently costs the attestation.
