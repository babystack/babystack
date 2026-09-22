/**
 * Tests for the two release-time gates that cannot be exercised by running the pipeline: the scoped
 * dependency audit, and the packed-artifact leak scan. Reaching either for real means being mid-release.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { partition } from '../../scripts/audit-release.mjs'
import { scan, NEEDLES } from '../../scripts/verify-tarballs.mjs'

describe('audit-release — only advisories that reach a PUBLISHED package block', () => {
  const dirs = ['packages/core', 'packages/cli']
  const adv = (severity, module_name, ...paths) => ({
    severity,
    module_name,
    findings: [{ paths }],
  })

  test('blocks an advisory that reaches a published package', () => {
    const { blocking } = partition(
      [adv('high', 'evil', 'packages/core > evil@1.0.0')],
      dirs,
      'high',
    )
    assert.equal(blocking.length, 1)
    assert.deepEqual(blocking[0].reaches, ['packages/core'])
  })

  test('does NOT block one that only reaches a workspace project that is never published', () => {
    // The real case: `examples/users-api > drizzle-orm`. A gate that fails for something the release
    // cannot fix is one people learn to bypass.
    const { blocking, informational } = partition(
      [adv('high', 'drizzle-orm', 'examples/users-api > drizzle-orm@0.36.4')],
      dirs,
      'high',
    )
    assert.deepEqual(blocking, [])
    assert.equal(informational.length, 1)
  })

  test('blocks when an advisory reaches BOTH a published and an unpublished project', () => {
    const { blocking } = partition(
      [adv('high', 'shared', 'examples/demo > shared@1.0.0', 'packages/cli > shared@1.0.0')],
      dirs,
      'high',
    )
    assert.equal(blocking.length, 1)
    assert.deepEqual(blocking[0].reaches, ['packages/cli'])
  })

  test('respects the severity threshold in both directions', () => {
    const a = [adv('moderate', 'x', 'packages/core > x@1.0.0')]
    assert.equal(partition(a, dirs, 'high').blocking.length, 0)
    assert.equal(partition(a, dirs, 'moderate').blocking.length, 1)
  })

  test('an advisory with no findings cannot block', () => {
    assert.equal(
      partition([{ severity: 'high', module_name: 'x' }], dirs, 'high').blocking.length,
      0,
    )
  })
})

describe('verify-tarballs — what must never reach the registry', () => {
  test('catches each needle class', () => {
    const cases = {
      'private key': '-----BEGIN RSA PRIVATE KEY-----\nabc',
      'AWS access key id': 'AKIAIOSFODNN7EXAMPLE',
      'npm token': 'npm_abcdefghijklmnopqrstuvwxyz0123456789',
      'GitHub token': 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'absolute home path': 'at /Users/someone/projects/thing.ts:1',
      'work email domain': 'contact: someone@pray.com',
      'private/internal repo reference': 'see the babystack-internal repo',
      'internal numbered doc': 'described in 07-ARCHITECTURE.md',
      'unresolvable internal citation': 'closes gap #1',
    }
    for (const [name, text] of Object.entries(cases)) {
      assert.ok(scan(text).includes(name), `${name} not detected in: ${text}`)
    }
    assert.equal(NEEDLES.length, Object.keys(cases).length, 'every needle needs a case here')
  })

  test('does NOT fire on the legitimate look-alikes a real package contains', () => {
    // A gate that fires on everything only teaches people to route around it.
    const benign = [
      'import { readFileSync } from "node:fs"',
      'https://github.com/babystack/babystack#readme',
      'see ./docs/guide/getting-started.md',
      'the internal cache is keyed by connection id', // "internal" as an ordinary word
      'node_modules/.pnpm/typescript@6.0.3/node_modules',
      'relative path packages/core/src/index.ts',
      'Apache-2.0',
      'version 2 of the protocol',
    ]
    for (const text of benign) assert.deepEqual(scan(text), [], `false positive on: ${text}`)
  })
})
