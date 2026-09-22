/**
 * Tests for the release-setup gate.
 *
 * These exist because the guards they cover were verified once, by hand, against planted defects — and a
 * hand sweep is not a gate. Every branch below is one that needs a deleted environment, a registry outage
 * or an unpublished package name to reach for real, which is exactly why it would otherwise never be
 * exercised again.
 *
 * Two of them are the load-bearing ones:
 *   • `parsePublishedPackages` against the REAL release.yml. The regex is an undeclared formatting contract
 *     on that file — two-space indent, single quotes, one line. Nothing else pins it, and prettier rewrites
 *     these files on every commit.
 *   • the same file's declared list against the real workspace, so adding a package fails here.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  comparePackages,
  evaluateEnvironment,
  findEscapedManifests,
  parsePublishedPackages,
  readManifests,
  repoSlugFrom,
} from '../../scripts/check-release.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const WORKFLOW = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8')

describe('parsePublishedPackages — the formatting contract on release.yml', () => {
  test('reads the real workflow', () => {
    const names = parsePublishedPackages(WORKFLOW)
    assert.ok(
      Array.isArray(names) && names.length > 0,
      'the real release.yml must yield a package list',
    )
  })

  test('the real declared list matches the real workspace', () => {
    // The live gate, asserted here too so `pnpm test` catches the drift even if nobody runs the script.
    assert.deepEqual(comparePackages(parsePublishedPackages(WORKFLOW), readManifests(ROOT)), [])
  })

  test('fails CLOSED on every reshaping prettier or an edit could produce', () => {
    for (const bad of [
      '  PUBLISHED_PACKAGES: "a b"', // double quotes
      "    PUBLISHED_PACKAGES: 'a b'", // four-space indent
      "PUBLISHED_PACKAGES: 'a b'", // no indent
      '  PUBLISHED_PACKAGES: >-\n    a b', // folded block scalar
      "  PUBLISHED_PACKAGE: 'a b'", // typo'd key
      "# PUBLISHED_PACKAGES: 'a b'", // only a comment mention
    ]) {
      assert.equal(
        parsePublishedPackages(bad),
        null,
        `should not have matched: ${JSON.stringify(bad)}`,
      )
    }
  })

  test('ignores the comment mentions above the real declaration', () => {
    assert.ok(WORKFLOW.includes('# '), 'sanity: the workflow has comments')
    assert.ok(!parsePublishedPackages(WORKFLOW).includes('#'))
  })
})

describe('comparePackages — both directions', () => {
  const m = (name, priv = false) => ({ name, version: '1.0.0', private: priv })

  test('accepts an exact match', () => {
    assert.deepEqual(comparePackages(['a', '@s/b'], [m('a'), m('@s/b')]), [])
  })

  test('accepts a private package that is deliberately unlisted (the look-alike)', () => {
    // A workspace package that exists only to serve the others' tests. The guard must NOT fire — and must
    // not achieve that by skipping private packages, which would blind it to the accident it hunts.
    assert.deepEqual(comparePackages(['a'], [m('a'), m('@s/testkit', true)]), [])
  })

  test('refuses a publishable package that is not listed', () => {
    const [p] = comparePackages(['a'], [m('a'), m('@s/new')])
    assert.match(p, /@s\/new is publishable but is not in/)
  })

  test('refuses a listed package that went private', () => {
    const [p] = comparePackages(['a', '@s/b'], [m('a'), m('@s/b', true)])
    assert.match(p, /carries `private: true`/)
  })

  test('refuses a listed package that vanished', () => {
    const [p] = comparePackages(['a', '@s/gone'], [m('a')])
    assert.match(p, /renamed, moved or removed/)
  })

  test('refuses a rename+add, which leaves the COUNT unchanged', () => {
    // The case a count-based check passes. Both halves must be reported.
    const problems = comparePackages(['a', '@s/old'], [m('a'), m('@s/new')])
    assert.equal(problems.length, 2)
    assert.ok(problems.some((p) => /@s\/old/.test(p)) && problems.some((p) => /@s\/new/.test(p)))
  })

  test('refuses a duplicate name, which a set comparison cannot see', () => {
    // The workflow counts tokens against manifests, so a duplicate would fail the RELEASE job with a
    // misleading "renamed, moved or lost". Catch it here, where the fix is free.
    const [p] = comparePackages(['a', 'a'], [m('a')])
    assert.match(p, /lists a more than once/)
  })
})

describe('evaluateEnvironment — fails closed', () => {
  const slug = 'o/r'
  const ok = {
    status: 200,
    slug,
    body: {
      protection_rules: [
        { type: 'required_reviewers', reviewers: [{ reviewer: { login: 'someone' } }] },
        { type: 'branch_policy' },
      ],
    },
  }

  test('accepts an environment with a reviewer and a branch policy', () => {
    assert.deepEqual(evaluateEnvironment(ok), [])
  })

  test('refuses a MISSING environment, naming the auto-create behaviour', () => {
    const [p] = evaluateEnvironment({ status: 404, slug, repoExists: true })
    assert.match(p, /auto-creates a referenced environment with NO protection rules/)
  })

  test('distinguishes a missing REPO from a missing environment', () => {
    const [p] = evaluateEnvironment({ status: 404, slug, repoExists: false })
    assert.match(p, /GitHub has no repository/)
  })

  test('refuses an environment that exists but pauses for nobody', () => {
    const [p] = evaluateEnvironment({
      ...ok,
      body: { protection_rules: [{ type: 'branch_policy' }] },
    })
    assert.match(p, /NO required reviewers/)
  })

  test('refuses a required_reviewers rule with an EMPTY reviewer list', () => {
    const body = {
      protection_rules: [{ type: 'required_reviewers', reviewers: [] }, { type: 'branch_policy' }],
    }
    assert.match(evaluateEnvironment({ ...ok, body })[0], /NO required reviewers/)
  })

  test('refuses a missing deployment branch policy, which RELEASING.md claims exists', () => {
    const body = {
      protection_rules: [{ type: 'required_reviewers', reviewers: [{ reviewer: { login: 'x' } }] }],
    }
    assert.match(evaluateEnvironment({ ...ok, body })[0], /no deployment branch policy/)
  })

  test('refuses a 5xx, a rate limit and a malformed body rather than guessing', () => {
    for (const status of [500, 403, 429, 301]) {
      assert.match(evaluateEnvironment({ status, slug })[0], /refusing to\s+assume the gate exists/)
    }
    assert.match(evaluateEnvironment({ status: 200, slug, body: {} })[0], /NO required reviewers/)
  })
})

describe('repoSlugFrom', () => {
  test('prefers the Actions environment', () => {
    assert.equal(
      repoSlugFrom({ GITHUB_REPOSITORY: 'a/b' }, { repository: { url: 'nonsense' } }),
      'a/b',
    )
  })

  test('parses the real manifest forms, including a hyphenated org', () => {
    const cases = {
      'git+https://github.com/babystack/babystack.git': 'babystack/babystack',
      // A hyphenated org, the form that would break a lazier regex.
      'git+https://github.com/some-org/some-repo.git': 'some-org/some-repo',
      'git@github.com:some-org/some-repo.git': 'some-org/some-repo',
      'https://github.com/some-org/some-repo': 'some-org/some-repo',
    }
    for (const [url, want] of Object.entries(cases)) {
      assert.equal(repoSlugFrom({}, { repository: { url } }), want, url)
    }
  })

  test('throws rather than guessing when the manifest names no remote', () => {
    assert.throws(() => repoSlugFrom({}, {}), /cannot determine owner\/repo/)
  })

  test('this repo resolves to the slug its workflow names', () => {
    const slug = repoSlugFrom({}, JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')))
    assert.ok(WORKFLOW.includes(slug), `release.yml should mention ${slug}`)
  })
})

describe('readManifests — reports, does not throw', () => {
  test('reads the real workspace', () => {
    const problems = []
    const found = readManifests(ROOT, problems)
    assert.deepEqual(problems, [])
    assert.ok(found.length > 0)
    assert.ok(
      found.every((m) => typeof m.name === 'string' && typeof m.version === 'string'),
      'every manifest must declare a name and a version',
    )
  })

  test('reports a missing packages/ directory instead of throwing', () => {
    const problems = []
    assert.deepEqual(readManifests(join(ROOT, 'does-not-exist'), problems), [])
    assert.match(problems[0], /no packages\/ directory/)
  })
})

describe('findEscapedManifests — mangled manifest metadata must not ship', () => {
  const withFiles = (files, fn) => {
    const dir = mkdtempSync(join(tmpdir(), 'manifest-'))
    try {
      for (const [rel, body] of Object.entries(files)) {
        mkdirSync(join(dir, dirname(rel)), { recursive: true })
        writeFileSync(join(dir, rel), body)
      }
      return fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test('catches an escape a re-serialiser left behind', () => {
    // How this happened for real: Python's json.dumps escapes non-ASCII by default, turning an em-dash in
    // the description into the six literal characters \u2014. Valid JSON, invisible to prettier, and it is
    // the text on the package's registry page.
    const bad = withFiles({ 'package.json': '{"description":"a \\u2014 b"}' }, (d) =>
      findEscapedManifests(d, ['package.json']),
    )
    assert.equal(bad.length, 1)
    assert.deepEqual(bad[0].hits, ['\\u2014'])
  })

  test('does NOT fire on the real character, or on an escape inside a normal string', () => {
    const ok = withFiles(
      {
        'package.json': '{"description":"a — b","homepage":"https://x/y"}',
        'packages/core/package.json': '{"name":"@s/core","version":"1.0.0"}',
      },
      (d) => findEscapedManifests(d, ['package.json', 'packages/core/package.json']),
    )
    assert.deepEqual(ok, [])
  })

  test('skips a path that does not exist rather than throwing', () => {
    assert.deepEqual(findEscapedManifests(ROOT, ['packages/nope/package.json']), [])
  })

  test("this repo's own manifests are clean", () => {
    // Enumerate for real. The first version of this built the package paths with
    // `.map(() => null).filter(Boolean)` — always empty — so it asserted only the root manifest while
    // reading as though it covered the workspace.
    const pkgPaths = readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => `packages/${e.name}/package.json`)
    assert.ok(pkgPaths.length > 0, 'sanity: the workspace has packages')
    assert.deepEqual(findEscapedManifests(ROOT, ['package.json', ...pkgPaths]), [])
  })
})
