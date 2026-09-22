/**
 * Release-setup gate.
 *
 * Two classes of release defect are invisible until a release is already in flight, and both produce the
 * worst shape of failure there is — a GREEN run that published the wrong thing, or nothing, irreversibly.
 * This script is the detector for both, so that "is the release setup still sound?" is a check rather than
 * a judgement call.
 *
 *   1. THE MANIFEST COUNT DRIFTED (offline). `release.yml` declares `EXPECTED_PACKAGES`, and every
 *      per-package guard in it refuses to run unless the `packages/*` glob matches exactly that many
 *      publishable manifests. That number is a constant in a YAML file, so nothing keeps it true: add a
 *      package and the guards go on checking the old count, and the new name — which has no npm Trusted
 *      Publisher, because it has never been published — reaches `changeset publish` unguarded. This check
 *      is what makes adding a package fail HERE, in CI, where the fix is to bootstrap the name, instead of
 *      failing mid-publish where some of the family is already on the registry, immutably.
 *
 *   2. THE APPROVAL GATE IS NOT ACTUALLY THERE (--environment, needs network). The publish job declares
 *      `environment: release`, which reads like a gate but is only a NAME. GitHub's documented behaviour is
 *      that "running a workflow that references an environment that does not exist will create an
 *      environment with the referenced name", and "the newly created environment will not have any
 *      protection rules". So if the environment was never created — or is deleted, or loses its reviewer —
 *      the publish job does not fail and does not pause. It publishes. The YAML is unchanged, the docs
 *      still describe an approval step, and the only evidence is a release that nobody approved.
 *      This repo shipped in exactly that state: `release.yml` and RELEASING.md both described the gate
 *      while the repo had zero environments configured.
 *
 * Usage:
 *   node scripts/check-release.mjs                 # offline checks only
 *   node scripts/check-release.mjs --environment   # also verify the GitHub `release` environment
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORKFLOW = join(ROOT, '.github/workflows/release.yml')
const ENVIRONMENT = 'release'

const argv = process.argv.slice(2)
const KNOWN = new Set(['--environment'])
const unknown = argv.filter((a) => !KNOWN.has(a))
if (unknown.length > 0) {
  console.error(`check-release: unknown argument(s): ${unknown.join(', ')}`)
  console.error('usage: node scripts/check-release.mjs [--environment]')
  process.exit(2)
}

const failures = []
const fail = (msg) => failures.push(msg)
const ok = (msg) => console.log(`  ok   ${msg}`)

/** Every workspace manifest under packages/, with the two fields that decide whether it publishes. */
function manifests() {
  const dir = join(ROOT, 'packages')
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(dir, e.name, 'package.json'))
    .map((path) => {
      const pkg = JSON.parse(readFileSync(path, 'utf8'))
      return {
        path: path.slice(ROOT.length + 1),
        name: pkg.name,
        version: pkg.version,
        private: pkg.private === true,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

// ── 1. EXPECTED_PACKAGES agrees with the workspace ────────────────────────────────────────────────
const workflow = readFileSync(WORKFLOW, 'utf8')

// A single top-level scalar, so a regex reads it exactly as YAML would — no parser needed, and no
// dependency that could itself drift. Anchored to the line start to avoid matching the many comment
// mentions of the name below it.
const declared = /^ {2}EXPECTED_PACKAGES: (\d+)$/m.exec(workflow)
if (!declared) {
  fail(
    'release.yml does not declare `EXPECTED_PACKAGES` at the workflow level. Every per-package guard in ' +
      'that file refuses to run without it, so its absence disables all of them at once.',
  )
} else {
  const all = manifests()
  const publishable = all.filter((m) => !m.private)
  const expected = Number(declared[1])
  if (expected !== publishable.length) {
    const priv = all.filter((m) => m.private)
    fail(
      `release.yml declares EXPECTED_PACKAGES: ${expected}, but packages/ holds ${publishable.length} ` +
        `publishable manifest(s): ${publishable.map((m) => m.name).join(', ')}.` +
        (priv.length > 0
          ? ` (Not counted, \`private: true\`: ${priv.map((m) => m.name).join(', ')}.)`
          : '') +
        '\n       If a package was ADDED: its npm name almost certainly does not exist yet, and a Trusted ' +
        'Publisher cannot be bound to a name that has never been published. Create the name first, bind its ' +
        'Trusted Publisher on npmjs.com, and only then raise this number — otherwise the release publishes ' +
        'the packages that do exist and fails on the new one, leaving a partial, immutable release.' +
        '\n       If a package went `private: true`: `changeset publish` SKIPS it silently and exits 0, so ' +
        'the release would go green having published less than it claimed. Restore it, or lower this number ' +
        'deliberately.',
    )
  } else {
    ok(
      `EXPECTED_PACKAGES (${expected}) matches the ${publishable.length} publishable manifests in packages/`,
    )
  }
}

// ── 2. The `release` environment really exists, and really has a reviewer ─────────────────────────
/** owner/repo, from the Actions env when there is one, else from the manifest that names the remote. */
function repoSlug() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY
  const url = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).repository?.url ?? ''
  const m = /github\.com[/:]([^/]+\/[^/.]+)/.exec(url)
  if (!m)
    throw new Error(
      `cannot determine owner/repo from the root manifest's repository.url (${url || 'unset'})`,
    )
  return m[1]
}

if (argv.includes('--environment')) {
  const slug = repoSlug()
  const url = `https://api.github.com/repos/${slug}/environments/${ENVIRONMENT}`
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'check-release' }
  // Optional: only raises the rate limit. This repo is public, so the endpoint — including each
  // environment's protection rules — is readable unauthenticated, which is what lets this run in CI
  // with no privileged token and lets a maintainer run it locally.
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`

  let res
  try {
    res = await fetch(url, { headers })
  } catch (err) {
    // FAIL CLOSED. A network error is not evidence that the gate is fine.
    fail(
      `could not reach the GitHub API to verify the \`${ENVIRONMENT}\` environment — refusing to assume it exists. ${err.message}`,
    )
    res = null
  }

  // A 404 here has TWO causes and they need different fixes: the environment is missing, or the repo slug
  // is wrong (a typo, or a fork). Both fail closed, so safety is the same either way — but reporting "no
  // release environment" for a repo that does not exist sends the operator to configure a setting on a page
  // that isn't there. One extra request, only ever on the failure path, buys an honest diagnosis.
  if (res && res.status === 404) {
    let repoExists = null
    try {
      repoExists = (await fetch(`https://api.github.com/repos/${slug}`, { headers })).ok
    } catch {
      /* leave it unknown; the message below degrades to the ambiguous form */
    }
    if (repoExists === false) {
      fail(
        `GitHub has no repository \`${slug}\`, so the \`${ENVIRONMENT}\` environment could not be checked ` +
          "— refusing to assume the gate exists. Fix the slug (GITHUB_REPOSITORY, or the root manifest's " +
          'repository.url) rather than the environment.',
      )
    } else {
      fail(
        `${slug} has no \`${ENVIRONMENT}\` environment, but release.yml's publish job declares ` +
          `\`environment: ${ENVIRONMENT}\`.\n       That is NOT an error at run time: GitHub auto-creates a ` +
          'referenced environment with NO protection rules, so the publish job would run straight through ' +
          'without pausing and publish to npm unapproved.\n       Create it: Settings → Environments → New ' +
          `environment → \`${ENVIRONMENT}\`, add the maintainer as a REQUIRED REVIEWER, and restrict ` +
          'deployments to protected branches.',
      )
    }
  } else if (res && !res.ok) {
    fail(
      `GitHub API returned ${res.status} for ${url} — refusing to assume the \`${ENVIRONMENT}\` gate exists. ` +
        `A non-404 error is not evidence either way.`,
    )
  } else if (res) {
    const env = await res.json()
    const rules = Array.isArray(env.protection_rules) ? env.protection_rules : []
    const reviewers = rules
      .filter((r) => r.type === 'required_reviewers')
      .flatMap((r) => r.reviewers ?? [])
    if (reviewers.length === 0) {
      fail(
        `${slug}'s \`${ENVIRONMENT}\` environment exists but has NO required reviewers, so it pauses for ` +
          'nobody. The environment name alone is not the gate — the required reviewer is. Add one under ' +
          'Settings → Environments → release.',
      )
    } else {
      const who = reviewers.map((r) => r.reviewer?.login ?? r.reviewer?.slug ?? '?').join(', ')
      ok(`${slug} \`${ENVIRONMENT}\` environment has required reviewer(s): ${who}`)
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`\ncheck-release: ${failures.length} problem(s) found\n`)
  for (const f of failures) console.error(`  FAIL ${f}\n`)
  process.exit(1)
}
console.log('\ncheck-release: release setup looks sound')
