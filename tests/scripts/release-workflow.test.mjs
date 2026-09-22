/**
 * Guards the SHAPE and STEP ORDER of the release workflow.
 *
 * ENGINEERING-STANDARDS § Release pipelines: "Encode the ordering as a test over the pipeline definition;
 * a comment saying 'this must run first' does not survive the next edit." This file is that test. The
 * workflow carries a long comment headed ORDER IS LOAD-BEARING; the comment explains WHY, and these
 * assertions are what actually hold the line.
 *
 * The orderings are correctness properties, not style:
 *   • in `prepare`, the registry check must precede `changesets/action` — that action's version mode
 *     REWRITES every packages/*\/package.json in the working tree, so a check after it reads bumped
 *     versions and reports a release as due on an ordinary feature merge;
 *   • in `publish`, everything still fixable must precede the irreversible publish, and anything that
 *     creates external state must follow it.
 *
 * Assertions are about job MEMBERSHIP and EFFECTIVE permissions rather than the presence of strings,
 * because the failure this most needs to catch is a step silently re-parented into the wrong job by an
 * anchor-based edit — which leaves every name and every permission looking right.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const wf = parse(readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8'))

const job = (name) => {
  const j = wf.jobs[name]
  if (!j) throw new Error(`release.yml has no "${name}" job`)
  return j
}
/** Permissions as GitHub resolves them: the job block wins, else the workflow block. */
const effectivePermissions = (name) => job(name).permissions ?? wf.permissions ?? {}
const stepLabels = (name) => job(name).steps.map((s) => s.name ?? s.uses ?? s.run ?? '')
/** Index of the first step in `name` whose label matches — -1 if the job does not contain it. */
const indexOf = (name, re) => stepLabels(name).findIndex((l) => re.test(l))
/**
 * Index of a step by its `id:`, which is the only stable handle a step has.
 *
 * Matching on label text is how the ordering assertion below was first written, and it was VACUOUS: the
 * pattern `/check/` matched `actions/checkout` at step 0, so `0 < versionStep` held no matter where the
 * real step sat. It passed on a correct tree for the wrong reason and passed on the mutated tree too.
 */
const indexOfId = (name, id) => {
  const i = job(name).steps.findIndex((s) => s.id === id)
  assert.ok(i >= 0, `${name} has no step with id: ${id}`)
  return i
}

describe('release workflow — shape', () => {
  test('has exactly the three jobs, in the dependency order that matters', () => {
    assert.deepEqual(Object.keys(wf.jobs).sort(), ['github-release', 'prepare', 'publish'])
    assert.equal(job('publish').needs, 'prepare')
    assert.equal(job('github-release').needs, 'publish')
  })

  test('only the publish job is gated on the release environment', () => {
    assert.equal(job('publish').environment, 'release')
    assert.equal(job('prepare').environment, undefined)
    assert.equal(job('github-release').environment, undefined)
  })

  test('keeps contents:write OFF the job that publishes — EFFECTIVE, not just job-level', () => {
    // A `contents: write` added at the WORKFLOW level would be inherited by the publish job, and a
    // job-level-only assertion would pass while the hardening claim became false.
    assert.notEqual(effectivePermissions('publish').contents, 'write')
    assert.equal(effectivePermissions('publish')['id-token'], 'write')
    assert.equal(effectivePermissions('github-release').contents, 'write')
    // And the job holding the write scope must not be able to publish.
    assert.equal(effectivePermissions('github-release')['id-token'], undefined)
  })

  // Does this step actually PUBLISH? Two false positives had to be designed out, and both are the same
  // mistake in different clothes: matching the word rather than the command.
  //   • `prepare`'s guard script is full of `should_publish` and "a publish is due";
  //   • the pre-flight echoes "changeset publish will skip it" as an explanatory log line.
  // So: the changesets action's `publish:` input, or a run LINE that begins with a publish command —
  // prose lives inside `echo`, which never starts a line with `npm`/`pnpm`/`changeset`.
  const PUBLISH_LINE =
    /^(npm|pnpm)\s+(-r\s+)?(--filter\s+\S+\s+)?publish\b|^changeset\s+publish\b|^pnpm\s+run\s+release\b/
  const publishesInStep = (s) =>
    Boolean(s.with?.['publish-script']) ||
    (s.run ?? '').split('\n').some((l) => PUBLISH_LINE.test(l.trim()))

  test('nothing outside the publish job runs a publish', () => {
    const elsewhere = Object.entries(wf.jobs)
      .filter(([n]) => n !== 'publish')
      .flatMap(([n, j]) => j.steps.filter(publishesInStep).map((s) => `${n}: ${s.name ?? s.uses}`))
    assert.deepEqual(elsewhere, [])
  })

  test('the publish job really is the one that publishes', () => {
    // The mirror of the test above: if a refactor moved the publish OUT, that check would still pass by
    // being vacuously empty. A guard that can only be satisfied by absence is not a guard.
    assert.equal(job('publish').steps.filter(publishesInStep).length, 1)
  })

  test('a release is never cancelled in flight', () => {
    assert.equal(job('publish').concurrency['cancel-in-progress'], false)
    // prepare only refreshes a PR, so superseding it is correct — and it must NOT share publish's group,
    // or a release parked on the approval gate would let each new push cancel the queued prepare.
    assert.equal(job('prepare').concurrency['cancel-in-progress'], true)
    assert.notEqual(job('prepare').concurrency.group, job('publish').concurrency.group)
  })

  test('every job is bounded by a timeout', () => {
    for (const [name, j] of Object.entries(wf.jobs)) {
      assert.ok(typeof j['timeout-minutes'] === 'number', `${name} has no timeout-minutes`)
    }
  })
})

describe('release workflow — ORDER IS LOAD-BEARING', () => {
  test('prepare: the registry check runs BEFORE changesets/action rewrites the tree', () => {
    const check = indexOfId('prepare', 'check')
    const versionStep = stepLabels('prepare').findIndex((l) => /changesets\/action/.test(l))
    assert.ok(versionStep >= 0, 'prepare does not run changesets/action')
    assert.ok(
      check < versionStep,
      `the registry check (step ${check}) must precede changesets/action (step ${versionStep}); ` +
        'after it, the check reads versions that `changeset version` has already bumped',
    )
  })

  test('publish: everything fixable precedes the irreversible publish', () => {
    const publishStep = stepLabels('publish').findIndex((l) => /changesets\/action/.test(l))
    assert.ok(publishStep >= 0, 'publish does not run changesets/action')
    for (const [what, re] of [
      ['the full gate', /pnpm run test$/],
      ['the release-setup re-verification', /Re-verify the release setup/],
    ]) {
      const i = indexOf('publish', re)
      assert.ok(i >= 0, `publish is missing ${what}`)
      assert.ok(
        i < publishStep,
        `${what} (step ${i}) must run before the publish (step ${publishStep})`,
      )
    }
    for (const id of ['preflight', 'audit', 'tarballs']) {
      assert.ok(
        indexOfId('publish', id) < publishStep,
        `the "${id}" step must run before the publish`,
      )
    }
  })

  test('publish: registry verification runs AFTER the publish, never before', () => {
    const publishStep = stepLabels('publish').findIndex((l) => /changesets\/action/.test(l))
    const verify = indexOf('publish', /Verify the release landed/)
    assert.ok(verify > publishStep, 'the registry verification must follow the publish it verifies')
  })

  test('the checkout that feeds a tag-reading gate is not shallow', () => {
    for (const name of ['publish', 'github-release']) {
      const checkout = job(name).steps.find((s) => (s.uses ?? '').startsWith('actions/checkout'))
      assert.equal(checkout?.with?.['fetch-depth'], 0, `${name}'s checkout must not be shallow`)
    }
  })
})

describe('release workflow — changesets/action v2 contract', () => {
  const changesetsSteps = () =>
    Object.values(wf.jobs).flatMap((j) =>
      j.steps.filter((s) => (s.uses ?? '').startsWith('changesets/action@')),
    )
  const publishStep = () => job('publish').steps.find((s) => s.id === 'changesets')

  test('the action major matches the @changesets/cli major — the half-migration guard', () => {
    // action v1 parses `New tag:` lines out of stdout; CLI 3 never prints them and reports through a
    // CHANGESETS_OUTPUT file instead. Pairing action v1 with CLI 3 therefore publishes for real and then
    // reports `published: false` with an empty package list — packages on npm, no tags, no Releases.
    // Dependabot groups npm and actions updates SEPARATELY, so either half can arrive alone, and CI never
    // runs release.yml. This test is the only thing that would notice.
    const raw = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8')
    const actionMajors = [...raw.matchAll(/changesets\/action@[0-9a-f]{40} # v(\d+)/g)].map((m) =>
      Number(m[1]),
    )
    assert.ok(
      actionMajors.length >= 2,
      'expected both changesets/action steps to carry a # vN comment',
    )
    assert.equal(
      new Set(actionMajors).size,
      1,
      'the two changesets/action steps are on different majors',
    )
    const ws = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8')
    const cli = /^\s+'@changesets\/cli':\s*[\^~]?(\d+)\./m.exec(ws)
    assert.ok(cli, 'could not read the @changesets/cli catalog range')
    assert.equal(
      Number(cli[1]),
      actionMajors[0] + 1,
      `changesets/action v${actionMajors[0]} pairs with @changesets/cli ${actionMajors[0] + 1}.x, not ${cli[1]}.x`,
    )
  })

  test('uses only v2 input names — v1 names make the action throw', () => {
    for (const s of changesetsSteps()) {
      for (const old of ['publish', 'version', 'createGithubReleases']) {
        assert.equal(
          s.with?.[old],
          undefined,
          `changesets/action step uses the removed v1 input "${old}"`,
        )
      }
    }
  })

  test('the publish step turns off BOTH releases and tag pushing', () => {
    // Since v2, `create-github-releases: false` no longer stops tag pushing. Without `push-git-tags: false`
    // the action tries to push tags with an id-token-only token, gets a 403 per package, warns, and carries
    // on — so the guarantee would rest on a missing scope rather than on configuration.
    assert.equal(publishStep().with['create-github-releases'], false)
    assert.equal(publishStep().with['push-git-tags'], false)
  })

  test('reads the RENAMED output — a stale name evaluates to an empty string', () => {
    const raw = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8')
    assert.doesNotMatch(raw, /steps\.changesets\.outputs\.publishedPackages/)
    assert.match(
      job('publish').outputs.publishedPackages,
      /steps\.changesets\.outputs\.published-packages/,
    )
  })

  test('passes no GITHUB_TOKEN env to the action — v2 throws if it disagrees with the input', () => {
    for (const s of changesetsSteps()) assert.equal(s.env?.GITHUB_TOKEN, undefined)
  })
})

describe('release workflow — release-toolchain rules', () => {
  test('npm is pinned to a FLOOR, never @latest', () => {
    const runs = job('publish').steps.map((s) => s.run ?? '')
    const upgrade = runs.find((r) => /npm install -g/.test(r))
    assert.ok(upgrade, 'the publish job does not upgrade npm')
    assert.doesNotMatch(upgrade, /npm@latest/)
    assert.match(upgrade, /npm@\^\d+\.\d+\.\d+/)
  })

  test('every action in EVERY workflow is pinned to a full commit SHA', () => {
    // Every workflow, not just this one. The first version of this test parsed only release.yml, and
    // ci.yml sat on mutable `@v4` tags the whole time without it noticing — a tag can be moved to point at
    // new code, and the job that runs on every pull request is exactly where that matters.
    const dir = join(ROOT, '.github/workflows')
    const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))
    assert.ok(files.length > 1, 'sanity: more than one workflow exists')
    const unpinned = []
    for (const f of files) {
      const w = parse(readFileSync(join(dir, f), 'utf8'))
      for (const [name, j] of Object.entries(w.jobs ?? {})) {
        for (const s of j.steps ?? []) {
          if (s.uses && !s.uses.startsWith('./') && !/@[0-9a-f]{40}$/.test(s.uses)) {
            unpinned.push(`${f} › ${name}: ${s.uses}`)
          }
        }
      }
    }
    assert.deepEqual(unpinned, [])
  })

  test('PUBLISHED_PACKAGES is declared at the workflow level', () => {
    assert.ok(
      typeof wf.env?.PUBLISHED_PACKAGES === 'string' && wf.env.PUBLISHED_PACKAGES.trim() !== '',
    )
  })
})
