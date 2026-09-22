/**
 * A detector for release claims that are FALSE about this pipeline.
 *
 * This exists because a hand sweep missed one. Three copies of "changeset publish stops at the first
 * failure" were corrected by grepping for that exact string; a fourth said "stopping at the first failure"
 * and survived, in the same file, contradicting a correct paragraph two sections above it. Searching one
 * spelling of a pattern is how a sweep ends while the defect is still in the tree — so the pattern lives
 * here instead, applied to every release-facing file, and it keeps running.
 *
 * Each entry names what is actually true, because the point is not to ban a phrase — it is to stop the
 * docs from teaching a maintainer the wrong model of what a failed release leaves behind.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** Every file that describes the release to a human or to CI. */
const FILES = [
  'RELEASING.md',
  '.github/workflows/release.yml',
  '.github/workflows/ci.yml',
  'CONTRIBUTING.md',
].filter((f) => existsSync(join(ROOT, f)))

const FORBIDDEN = [
  // ── What @changesets/cli 2.x did, and 3.x (this repo's version) does not. ─────────────────────────────
  // 2.x published the whole family at once, so "a failure on one does not stop the others" was true and
  // was written into these docs. 3.x publishes in DEPENDENCY LEVELS and stops at the first level with a
  // failure. The old sentence now describes the opposite of what happens, which is the worst kind of
  // stale: it tells a maintainer mid-incident that the rest of the family has landed when it has not.
  {
    pattern: /failure\s+on\s+one\s+(package\s+)?does\s+not\s+stop\s+the\s+others/i,
    why:
      '`changeset publish` 3.x publishes in dependency levels and STOPS at the first level with a failure — ' +
      'levels below it and same-level siblings land, nothing above it does. "Does not stop the others" was ' +
      'true of 2.x only.',
  },
  {
    pattern: /(rather\s+than|not)\s+in\s+(dependency|topological)\s+order|\bnot\s+topological/i,
    why: '`changeset publish` 3.x DOES publish in dependency order (graphSequencer levels). 2.x did not.',
  },
  {
    pattern: /changeset\s+version`?\s+(still\s+)?bumps\s+(them|private)/i,
    why:
      'Since @changesets/cli 3.0, private packages are no longer versioned by default. A package that goes ' +
      'private by accident now simply vanishes from the Version PR.',
  },
  // ── Claims that are false for this pipeline regardless of version. ──────────────────────────────────
  {
    pattern: /publishes\s+every\s+bumped\s+package/i,
    why:
      'Changesets bumps only what changed and skips the rest, and it silently drops `private: true` ' +
      'packages entirely. "Every bumped package" reads as a guarantee the tool does not make.',
  },
  {
    pattern: /\bnpm@latest\b/,
    why:
      'The release toolchain is pinned to a FLOOR, not to `latest` — ENGINEERING-STANDARDS § Release ' +
      'pipelines. A doc showing `@latest` invites someone to restore it.',
  },
  {
    pattern: /re-?runs?\s+the\s+complete\s+(CI\s+)?gate/i,
    why:
      "The publish job re-runs the Tier-1 gate only. It does not repeat the integration job or CI's Node " +
      'matrix, and claiming otherwise tells a reviewer they need not check that `main` is green.',
  },
  {
    pattern:
      /no\s+(unauthenticated\s+)?way\s+to\s+(read|check|verify)\s+whether\s+a\s+(package\s+has\s+a\s+)?[Tt]rusted\s+[Pp]ublisher/,
    why:
      '`npm trust list <package>` reads the bindings for an authenticated maintainer. The claim is only ' +
      'true of an UNAUTHENTICATED caller, which is what stops a CI gate covering it — say that instead.',
  },
]

/**
 * Flatten a file to one whitespace-normalised string, stripping the markers that only exist because of
 * line wrapping: Markdown blockquote `>` and YAML comment `#`.
 *
 * Line-by-line matching was the detector's own version of the bug it hunts. Both of these claims wrap:
 *
 *     > ... There is NO
 *     > unauthenticated way to read whether a package has a Trusted Publisher bound ...
 *
 * so a per-line regex sees neither half and reports the file clean. Prettier decides where those breaks
 * fall, which means the detector's verdict would depend on the column width — exactly the kind of
 * accidental coverage that makes a gate untrustworthy.
 */
const normalise = (text) =>
  text
    .split('\n')
    .map((l) => l.replace(/^\s*[>#]\s?/, ' '))
    .join(' ')
    .replace(/\s+/g, ' ')

describe('release docs — no claims that are false about this pipeline', () => {
  for (const file of FILES) {
    test(file, () => {
      const raw = readFileSync(join(ROOT, file), 'utf8')
      const flat = normalise(raw)
      const hits = []
      for (const { pattern, why } of FORBIDDEN) {
        const m = pattern.exec(flat)
        if (m) hits.push(`${file}\n    "…${m[0]}…"\n    → ${why}`)
      }
      assert.deepEqual(hits, [], `\n${hits.join('\n\n')}\n`)
    })
  }

  test('the detector sees a claim that WRAPS across lines', () => {
    // The miss that motivated normalising: prettier puts the break wherever the column width lands, so a
    // per-line regex sees neither half of a wrapped claim and reports the file clean.
    const wrapped =
      '  > publishes the family concurrently, so a failure on one does not\n  > stop the others'
    assert.ok(
      !FORBIDDEN[0].pattern.test(wrapped),
      'sanity: the raw text really is split across lines',
    )
    assert.ok(
      FORBIDDEN[0].pattern.test(normalise(wrapped)),
      'normalised text must expose the claim',
    )
  })

  test('the detector catches the stale 2.x claims, and passes the true 3.x ones', () => {
    // A guard that has never fired is not known to work — and one that fires on the TRUE sentence is worse,
    // because it teaches people to route around it.
    const [stops, order, priv] = FORBIDDEN
    assert.ok(
      stops.pattern.test(
        'publishes the family concurrently, so a failure on one does not stop the others',
      ),
    )
    assert.ok(
      order.pattern.test('uploads up to ten packages at once rather than in dependency order'),
    )
    assert.ok(order.pattern.test('it is concurrent, not topological'))
    assert.ok(priv.pattern.test('while `changeset version` still bumps them'))
    const truth =
      '`changeset publish` publishes in dependency levels — up to ten at a time within a level — and stops ' +
      'at the first level with a failure. Since 3.0, `changeset version` no longer bumps private packages.'
    for (const { pattern } of FORBIDDEN)
      assert.ok(!pattern.test(truth), `false positive on the truth: ${pattern}`)
  })
})
