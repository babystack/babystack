/**
 * Tests for the two release scripts that had no coverage: the post-publish verifier and the release-notes
 * extractor. Both run at moments where a wrong answer is expensive — one decides whether a release is
 * reported as successful, the other gates the publish on notes existing — and neither could be exercised
 * by running the pipeline, because reaching them means publishing.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { compareSets } from '../../scripts/verify-published.mjs'
import { extractSection, MAX_BODY } from '../../scripts/release-notes.mjs'

describe('verify-published — compareSets', () => {
  const pkgs = (...names) => names.map((n) => ({ name: n, version: '1.0.0' }))

  test('accepts the set pre-flight predicted, in any order', () => {
    assert.equal(compareSets(pkgs('b', 'a'), 'a b'), null)
  })

  test('REFUSES an empty expected list rather than proving nothing', () => {
    // `[] vs []` compares equal. The script's whole thesis is "a green run is not proof", so being asked
    // to verify nothing must be a failure, not a pass — otherwise a renamed step id silently disarms it.
    assert.match(compareSets([], ''), /nothing to verify/)
    assert.match(compareSets(pkgs('a'), ''), /nothing to verify/)
  })

  test('refuses a run that published NOTHING when something was expected', () => {
    assert.match(compareSets([], 'a b'), /reports\s+publishing \[\(none\)\]/)
  })

  test('refuses a PARTIAL publish', () => {
    assert.match(compareSets(pkgs('a'), 'a b'), /expected to publish \[a, b\]/)
  })

  test('refuses a package nobody expected', () => {
    assert.match(compareSets(pkgs('a', 'evil'), 'a'), /evil/)
  })

  test('tolerates the whitespace a workflow output can carry', () => {
    assert.equal(compareSets(pkgs('a', 'b'), '  a   b  '), null)
  })
})

describe('release-notes — extractSection', () => {
  const CL = [
    '# @s/pkg',
    '',
    '## 1.2.3',
    '',
    '- the new thing',
    '',
    '## 1.2.2',
    '',
    '- the old thing',
    '',
  ].join('\n')

  test('extracts the right section and stops at the next heading', () => {
    assert.equal(extractSection(CL, '1.2.3'), '- the new thing')
    assert.equal(extractSection(CL, '1.2.2'), '- the old thing')
  })

  test('extracts the last section, which has no following heading', () => {
    assert.equal(extractSection('# t\n\n## 0.1.0\n\n- only\n', '0.1.0'), '- only')
  })

  test('fails loudly on a missing section rather than emitting nothing', () => {
    assert.throws(() => extractSection(CL, '9.9.9'), /no "## 9.9.9" section/)
  })

  test('fails loudly on an EMPTY section', () => {
    assert.throws(() => extractSection('# t\n\n## 1.0.0\n\n## 0.9.0\n\n- x\n', '1.0.0'), /is empty/)
  })

  test("fails on a body past the host's size cap", () => {
    // A first release can absorb the whole pre-1.0 dev log; GitHub then rejects the release body — after
    // the publish, when the tarball is already immutable.
    const huge = `# t\n\n## 1.0.0\n\n${'x'.repeat(MAX_BODY + 1)}\n`
    assert.throws(() => extractSection(huge, '1.0.0'), /past GitHub's .* cap/)
  })

  test('accepts a body exactly at the cap — the guard must not fire on the legitimate edge', () => {
    const atCap = `# t\n\n## 1.0.0\n\n${'x'.repeat(MAX_BODY)}\n`
    assert.equal(extractSection(atCap, '1.0.0').length, MAX_BODY)
  })

  test('does not confuse a version that is a prefix of another', () => {
    const cl = '# t\n\n## 1.2.30\n\n- thirty\n\n## 1.2.3\n\n- three\n'
    assert.equal(extractSection(cl, '1.2.3'), '- three')
    assert.equal(extractSection(cl, '1.2.30'), '- thirty')
  })
})
