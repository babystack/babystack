/**
 * Release-setup gate.
 *
 * Two classes of release defect are invisible until a release is already in flight, and both produce the
 * worst shape of failure there is — a GREEN run that published the wrong thing, or nothing, irreversibly.
 * This script is the detector for both, so that "is the release setup still sound?" is a check rather than
 * a judgement call.
 *
 *   1. THE PACKAGE SET DRIFTED (offline). `release.yml` declares `PUBLISHED_PACKAGES` — the names this
 *      pipeline is expected to publish — and every per-package guard in it refuses to run without that
 *      list. It is a constant in a YAML file, so nothing keeps it true: add a package and the guards go on
 *      checking the old set, and the new name — which has no npm Trusted Publisher, because it has never
 *      been published — reaches `changeset publish` unguarded. Checking NAMES rather than a count also
 *      catches a rename, and one package removed while another is added, which leave a count unchanged.
 *      This check is what makes adding a package fail HERE, in CI, where the fix is to bootstrap the name,
 *      instead of failing mid-publish where some of the family is already on the registry, immutably.
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
 * The decision logic is exported as pure functions so `scripts/check-release.test.mjs` can drive every
 * branch — including the ones that need a registry outage or a deleted environment to reach for real.
 *
 * Usage:
 *   node scripts/check-release.mjs                 # offline checks only
 *   node scripts/check-release.mjs --environment   # also verify the GitHub `release` environment
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ENVIRONMENT = 'release'

/**
 * Read `PUBLISHED_PACKAGES` out of the workflow.
 *
 * A single top-level scalar, so a regex reads it exactly as YAML would — no parser, and no dependency that
 * could itself drift. This is an UNDECLARED FORMATTING CONTRACT on release.yml (two-space indent, single
 * quotes, one line), which is why the test suite pins it against the real file: if prettier or an edit ever
 * reshapes that line, the regex stops matching and the failure must be loud rather than a silent pass.
 */
export function parsePublishedPackages(workflowText) {
  const m = /^ {2}PUBLISHED_PACKAGES: '([^']*)'$/m.exec(workflowText)
  return m ? m[1].split(/\s+/).filter(Boolean) : null
}

/** Compare the declared names against the workspace, in BOTH directions. Returns a list of problems. */
export function comparePackages(listed, manifests) {
  const problems = []
  const publishable = manifests.filter((m) => !m.private).map((m) => m.name)
  const privateNames = manifests.filter((m) => m.private).map((m) => m.name)

  // A duplicate is invisible to a set comparison, but the workflow's pre-flight counts TOKENS against
  // MANIFESTS — so a duplicated name passes here and then fails the release job with "one was renamed,
  // moved or lost", which is false and points at the wrong file. Reject it where the fix is cheap.
  const dupes = listed.filter((n, i) => listed.indexOf(n) !== i)
  if (dupes.length > 0) {
    problems.push(
      `PUBLISHED_PACKAGES lists ${[...new Set(dupes)].join(', ')} more than once. The release job counts ` +
        'names against manifests, so a duplicate makes it refuse with a misleading "renamed, moved or ' +
        'lost" error. Remove the repeat.',
    )
  }

  for (const name of listed.filter((n) => !publishable.includes(n))) {
    problems.push(
      `release.yml lists ${name} in PUBLISHED_PACKAGES, but no publishable manifest under packages/ ` +
        `declares that name.` +
        (privateNames.includes(name)
          ? ' It carries `private: true` — `changeset publish` drops private packages with no log line ' +
            'and exits 0, so the release would go green having shipped less than it claims.'
          : ' It was renamed, moved or removed. A short family is a PARTIAL publish, not a smaller release.'),
    )
  }
  for (const name of publishable.filter((n) => !listed.includes(n))) {
    problems.push(
      `${name} is publishable but is not in release.yml's PUBLISHED_PACKAGES.\n` +
        '       If this package is NEW: its npm name almost certainly does not exist yet, and a Trusted ' +
        'Publisher cannot be bound to a name that has never been published. Publish the name once by hand, ' +
        'bind its Trusted Publisher on npmjs.com, and only then add it to the list — otherwise the release ' +
        'publishes the rest of the family concurrently and fails on this one, leaving a partial, immutable ' +
        'release.\n       If it should never publish, mark it `private: true`.',
    )
  }
  return problems
}

/**
 * Classify a GitHub environments API result. FAILS CLOSED: only a 200 carrying a required-reviewers rule
 * is "fine". "Could not check" is never read as "the gate is there".
 */
export function evaluateEnvironment({ status, body, slug, repoExists }) {
  if (status === 404 && repoExists === false) {
    return [
      `GitHub has no repository \`${slug}\`, so the \`${ENVIRONMENT}\` environment could not be checked — ` +
        "refusing to assume the gate exists. Fix the slug (GITHUB_REPOSITORY, or the root manifest's " +
        'repository.url) rather than the environment.',
    ]
  }
  if (status === 404) {
    return [
      `${slug} has no \`${ENVIRONMENT}\` environment, but release.yml's publish job declares ` +
        `\`environment: ${ENVIRONMENT}\`.\n       That is NOT an error at run time: GitHub auto-creates a ` +
        'referenced environment with NO protection rules, so the publish job would run straight through ' +
        'without pausing and publish to npm unapproved.\n       Create it: Settings → Environments → New ' +
        `environment → \`${ENVIRONMENT}\`, add the maintainer as a REQUIRED REVIEWER, and restrict ` +
        'deployments to protected branches.',
    ]
  }
  if (status !== 200) {
    return [
      `GitHub API returned ${status} for the \`${ENVIRONMENT}\` environment of ${slug} — refusing to ` +
        'assume the gate exists. A non-404 error is not evidence either way.',
    ]
  }

  const problems = []
  const rules = Array.isArray(body?.protection_rules) ? body.protection_rules : []
  const reviewers = rules
    .filter((r) => r.type === 'required_reviewers')
    .flatMap((r) => r.reviewers ?? [])
  if (reviewers.length === 0) {
    problems.push(
      `${slug}'s \`${ENVIRONMENT}\` environment exists but has NO required reviewers, so it pauses for ` +
        'nobody. The environment name alone is not the gate — the required reviewer is. Add one under ' +
        'Settings → Environments → release.',
    )
  }
  // RELEASING.md claims deployments are restricted to protected branches. An unverified claim in a
  // hardening doc is the same defect class as the missing environment itself, so check it too.
  if (!rules.some((r) => r.type === 'branch_policy')) {
    problems.push(
      `${slug}'s \`${ENVIRONMENT}\` environment has no deployment branch policy, so a release could be ` +
        'approved from any branch — including one opened by a fork. RELEASING.md states deployments are ' +
        'restricted to protected branches; make that true under Settings → Environments → release.',
    )
  }
  return problems
}

/** owner/repo, from the Actions env when there is one, else from the manifest that names the remote. */
export function repoSlugFrom(env, rootManifestJson) {
  if (env.GITHUB_REPOSITORY) return env.GITHUB_REPOSITORY
  const url = rootManifestJson.repository?.url ?? ''
  const m = /github\.com[/:]([^/]+\/[^/.]+)/.exec(url)
  if (!m)
    throw new Error(
      `cannot determine owner/repo from the root manifest's repository.url (${url || 'unset'})`,
    )
  return m[1]
}

/**
 * Every workspace manifest under packages/.
 *
 * Skips a directory with no package.json and reports a malformed one by PATH rather than throwing a raw
 * parse error. This runs on every PR, so a tracked `packages/<something>/` without a manifest — a fixtures
 * dir, or the stub you scaffold while bootstrapping a new package — must produce this script's own FAIL
 * reporting, not an unreadable node stack. Every other manifest walker in this pipeline already tolerates
 * it; this one is the odd one out if it does not.
 */
export function readManifests(root, problems = []) {
  const dir = join(root, 'packages')
  if (!existsSync(dir)) {
    problems.push(`no packages/ directory under ${root} — nothing to check`)
    return []
  }
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = join(dir, entry.name, 'package.json')
    if (!existsSync(path)) {
      problems.push(
        `packages/${entry.name}/ has no package.json — remove the directory or add a manifest`,
      )
      continue
    }
    try {
      const pkg = JSON.parse(readFileSync(path, 'utf8'))
      out.push({ name: pkg.name, version: pkg.version, private: pkg.private === true })
    } catch (err) {
      problems.push(`packages/${entry.name}/package.json is not valid JSON: ${err.message}`)
    }
  }
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name)))
}

async function main(argv, root) {
  const KNOWN = new Set(['--environment'])
  const unknown = argv.filter((a) => !KNOWN.has(a))
  if (unknown.length > 0) {
    console.error(`check-release: unknown argument(s): ${unknown.join(', ')}`)
    console.error('usage: node scripts/check-release.mjs [--environment]')
    return 2
  }

  const problems = []
  const ok = (msg) => console.log(`  ok   ${msg}`)

  const workflow = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8')
  const listed = parsePublishedPackages(workflow)
  if (listed === null) {
    problems.push(
      'release.yml does not declare `PUBLISHED_PACKAGES` at the workflow level (as a single-quoted, ' +
        'two-space-indented scalar). Every per-package guard in that file refuses to run without it, so ' +
        'its absence disables all of them at once.',
    )
  } else {
    const manifests = readManifests(root, problems)
    const found = comparePackages(listed, manifests)
    problems.push(...found)
    if (found.length === 0 && problems.length === 0) {
      ok(`PUBLISHED_PACKAGES matches the ${listed.length} publishable manifests in packages/`)
    }
  }

  if (argv.includes('--environment')) {
    const slug = repoSlugFrom(
      process.env,
      JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')),
    )
    const headers = { accept: 'application/vnd.github+json', 'user-agent': 'check-release' }
    // Optional: only raises the rate limit. These repos are public, so the endpoint — including each
    // environment's protection rules — is readable unauthenticated, which is what lets this run in CI
    // with no privileged token and lets a maintainer run it locally.
    if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`

    /**
     * Retry a throttle or a transient 5xx before giving a verdict.
     *
     * Failing closed is right, but this also runs on EVERY pull request — so without a backoff, one
     * GitHub API blip turns into a red gate on unrelated work, and a gate that goes red for reasons
     * nobody caused is one people learn to re-run without reading. A 404 and a 200 are both answers, so
     * neither is retried; 403, 429 and 5xx are not answers.
     */
    async function probe(url) {
      let last
      for (let attempt = 1; attempt <= 4; attempt++) {
        try {
          const res = await fetch(url, { headers })
          if (res.status === 200 || res.status === 404) return res
          last = res
        } catch (err) {
          last = err
        }
        if (attempt < 4) await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)))
      }
      if (last instanceof Error) throw last
      return last
    }

    let status, body, repoExists
    try {
      const res = await probe(`https://api.github.com/repos/${slug}/environments/${ENVIRONMENT}`)
      status = res.status
      if (res.ok) body = await res.json()
      if (status === 404) {
        // A 404 has two causes needing different fixes — missing environment, or a wrong slug. Both fail
        // closed, but sending someone to configure a setting on a page that isn't there wastes the signal.
        try {
          repoExists = (await probe(`https://api.github.com/repos/${slug}`)).ok
        } catch {
          /* leave unknown; the message degrades to the ambiguous form */
        }
      }
    } catch (err) {
      problems.push(
        `could not reach the GitHub API to verify the \`${ENVIRONMENT}\` environment — refusing to assume ` +
          `it exists. ${err.message}`,
      )
      status = null
    }
    if (status !== null) {
      const envProblems = evaluateEnvironment({ status, body, slug, repoExists })
      problems.push(...envProblems)
      if (envProblems.length === 0) {
        const reviewers = body.protection_rules
          .filter((r) => r.type === 'required_reviewers')
          .flatMap((r) => r.reviewers ?? [])
          .map((r) => r.reviewer?.login ?? r.reviewer?.slug ?? '?')
        ok(
          `${slug} \`${ENVIRONMENT}\` environment: required reviewer(s) ${reviewers.join(', ')}, branch policy on`,
        )
      }
    }
  }

  if (problems.length > 0) {
    console.error(`\ncheck-release: ${problems.length} problem(s) found\n`)
    for (const f of problems) console.error(`  FAIL ${f}\n`)
    return 1
  }
  console.log('\ncheck-release: release setup looks sound')
  return 0
}

// Run only when invoked directly, so the test suite can import the pure functions above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  process.exit(await main(process.argv.slice(2), root))
}
