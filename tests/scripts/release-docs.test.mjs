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
  {
    // The one that actually got through, in two spellings.
    pattern: /stop\w*\s+at\s+the\s+first\s+failure/i,
    why:
      '`changeset publish` publishes the family CONCURRENTLY (up to ten at a time) — it does NOT stop at ' +
      'the first failure. The difference matters: "stops at the first failure" implies topological safety, ' +
      'where a dependency lands and its dependents do not. Real concurrency lets a DEPENDENT land while the ' +
      'dependency it needs does not, which is the strictly worse partial release.',
  },
  {
    pattern: /publish\w*\s+(the\s+family\s+)?in\s+(dependency|topological)\s+order/i,
    why: '`changeset publish` does not order by dependency — that is `pnpm -r publish`.',
  },
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
    // The miss that motivated normalising: prettier puts the break wherever the column width lands.
    const wrapped =
      '  > the publish errors — but with `changeset publish` stopping\n  > at the first failure, a binding'
    assert.ok(
      !FORBIDDEN[0].pattern.test(wrapped),
      'sanity: the raw text really is split across lines',
    )
    assert.ok(
      FORBIDDEN[0].pattern.test(normalise(wrapped)),
      'normalised text must expose the claim',
    )
  })

  test('the detector itself catches both spellings it was written for', () => {
    // A guard that has never fired is not known to work.
    const [rule] = FORBIDDEN
    assert.ok(rule.pattern.test('changeset publish stops at the first failure'))
    assert.ok(rule.pattern.test('with changeset publish stopping at the first failure, a binding'))
    assert.ok(rule.pattern.test('it STOPPED AT THE FIRST FAILURE'))
    // …and does not fire on the correct sentence.
    assert.ok(
      !rule.pattern.test(
        'publishes the family concurrently, so a failure on one does not stop the others',
      ),
    )
  })
})
