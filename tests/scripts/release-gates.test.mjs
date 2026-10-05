/**
 * Tests for the two release-time gates that cannot be exercised by running the pipeline: the scoped
 * dependency audit, and the packed-artifact leak scan. Reaching either for real means being mid-release.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  partition,
  projectOf,
  publishableDirs,
  unexplained,
  workspaceProjects,
} from '../../scripts/audit-release.mjs'
import { scan, NEEDLES, parseExtraNeedles } from '../../scripts/verify-tarballs.mjs'

// Real `pnpm audit --json` output from pnpm 12.4.2, the version CI runs — captured, never written by hand. A
// hand-written fixture in pnpm 9's shape (`packages/core > dep@1.0.0`) once kept these tests green while pnpm
// 12 switched to `packages__core>dep` and the gate silently stopped blocking anything. Re-capture on a pnpm bump.
//   reaches-published: `pnpm audit --prod --json` on on-a-diet/onadiet at 5be640a (sharp 0.34, svgo 4.0)
//   examples-only:     `pnpm audit --prod --json` on babystack/babystack at fde6336 (only examples/ affected)
//   full-every-root:   `pnpm audit --json` on this branch (paths start at `.`, examples/ and packages/)
const HERE = dirname(fileURLToPath(import.meta.url))
const fixture = (name) =>
  JSON.parse(readFileSync(join(HERE, 'fixtures', `pnpm-12.4.2-audit-${name}.json`), 'utf8'))
const advisoriesOf = (report) => Object.values(report.advisories)

describe('audit-release — real pnpm 12 output, both directions', () => {
  test('BLOCKS high advisories that reach published packages', () => {
    const published = [
      'packages/cli',
      'packages/core',
      'packages/image',
      'packages/pdf',
      'packages/svg',
    ]
    const projects = new Set(['.', ...published, 'packages/testkit'])
    const report = fixture('prod-reaches-published')
    assert.deepEqual(unexplained(report, 'high'), [])
    const { blocking, informational } = partition(advisoriesOf(report), published, projects, 'high')
    assert.equal(blocking.length, 3)
    assert.deepEqual(informational, [])
    for (const a of blocking) {
      assert.ok(a.reaches.length > 0, `${a.module_name} should reach a published package`)
      assert.deepEqual(a.unplaced, [])
    }
  })

  test('does NOT block advisories that only reach a project that is never published', () => {
    const published = ['packages/core', 'packages/cli']
    const projects = new Set(['.', ...published, 'examples/users-api'])
    const report = fixture('prod-examples-only')
    assert.deepEqual(unexplained(report, 'moderate'), [])
    const { blocking, informational } = partition(
      advisoriesOf(report),
      published,
      projects,
      'moderate',
    )
    assert.deepEqual(blocking, [])
    assert.equal(informational.length, 4)
    for (const a of informational) assert.deepEqual(a.roots, ['examples/users-api'])
  })

  test('places every path start pnpm 12 writes: the root, examples/ and packages/', () => {
    const roots = advisoriesOf(fixture('full-every-root'))
      .flatMap((a) => a.findings.flatMap((f) => f.paths))
      .map(projectOf)
    assert.ok(roots.includes('.'))
    assert.ok(roots.includes('examples/users-api'))
    assert.ok(roots.includes('packages/core'))
    for (const r of roots)
      assert.match(r, /^(\.|(packages|examples)\/[\w.-]+)$/, `unplaceable root: ${r}`)
  })

  test('the workspace projects come from the lockfile, including pnpm 12 multi-document lockfiles', () => {
    const projects = workspaceProjects(
      readFileSync(join(HERE, '..', '..', 'pnpm-lock.yaml'), 'utf8'),
    )
    assert.ok(projects.has('.'))
    for (const dir of publishableDirs())
      assert.ok(projects.has(dir), `${dir} missing from the lockfile`)
  })
})

describe('audit-release — fails closed on what it cannot read', () => {
  const adv = (severity, ...paths) => ({ severity, module_name: 'x', findings: [{ paths }] })
  const published = ['packages/core']
  const projects = new Set(['.', 'packages/core', 'examples/app'])

  test('a path starting at an unknown project blocks', () => {
    const { blocking } = partition([adv('high', 'mystery__thing>x')], published, projects, 'high')
    assert.equal(blocking.length, 1)
    assert.deepEqual(blocking[0].unplaced, ['mystery/thing'])
  })

  test('an advisory with no path at all blocks', () => {
    const { blocking } = partition(
      [{ severity: 'high', module_name: 'x' }],
      published,
      projects,
      'high',
    )
    assert.equal(blocking.length, 1)
  })

  test('totals the listed advisories do not account for are reported', () => {
    const report = {
      advisories: { 1: adv('high', 'examples__app>x') },
      metadata: { vulnerabilities: { high: 2 } },
    }
    assert.deepEqual(unexplained(report, 'high'), ['pnpm counts 2 high but lists 1'])
    assert.deepEqual(unexplained({ advisories: {} }, 'high'), [
      'the report carries no metadata.vulnerabilities totals',
    ])
  })

  test('respects the severity threshold in both directions', () => {
    const a = [adv('moderate', 'packages__core>x')]
    assert.equal(partition(a, published, projects, 'high').blocking.length, 0)
    assert.equal(partition(a, published, projects, 'moderate').blocking.length, 1)
  })

  test('reads pnpm 9 paths too', () => {
    assert.equal(projectOf('packages/core > dep@1.0.0 > sub@2.0.0'), 'packages/core')
    assert.equal(projectOf('packages__core>dep>sub'), 'packages/core')
    assert.equal(projectOf('.>dep'), '.')
  })
})

describe('verify-tarballs — what must never reach the registry', () => {
  test('catches each needle class', () => {
    const cases = {
      'private key': ['-----BEGIN RSA PRIVATE KEY-----\nabc'],
      'AWS access key id': ['AKIAIOSFODNN7EXAMPLE'],
      'npm token': ['npm_abcdefghijklmnopqrstuvwxyz0123456789'],
      'GitHub token': ['ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
      'absolute home path': ['at /Users/someone/projects/thing.ts:1'],
      'private/internal repo reference': [
        'see the acme-internal repo',
        'moved to docs/internal/notes',
      ],
      // With and without the extension: a sourcemap once carried three references written each way.
      'internal numbered doc': [
        'described in 42-EXAMPLE.md',
        'see 42-EXAMPLE',
        'documented in docs/43-SAMPLE-DOC',
      ],
      'unresolvable internal citation': [
        'closes gap #1',
        'per finding S2',
        'see ADR 88',
        'from PRD-22',
        'covered by test-strategy T3',
      ],
      'reference to a private handbook': ['typed errors, per the handbook'],
    }
    for (const [name, texts] of Object.entries(cases)) {
      for (const text of texts) {
        assert.ok(scan(text).includes(name), `${name} not detected in: ${text}`)
      }
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
      'Phase 0 supports exactly one service', // a phase the public getting-started guide defines
      'UTF-8 and x86-64 at 2026-09-22T10:00:00Z',
      'grid-template-columns: 1fr; gap: 8px',
      'finding the right driver',
    ]
    for (const text of benign) assert.deepEqual(scan(text), [], `false positive on: ${text}`)
  })
})

describe('verify-tarballs — private needles come from outside the repository', () => {
  // The real ones (an employer's name, private repository names) live in a gitignored file or a CI secret:
  // committing them here would publish what they guard. These tests use made-up values.
  test('one case-insensitive expression per line; blanks and comments ignored', () => {
    const extra = parseExtraNeedles('# employer\nexample-employer\\.test\n\n', 'acme corp')
    assert.equal(extra.length, 2)
    assert.deepEqual(scan('contact: someone@EXAMPLE-EMPLOYER.test', extra), ['private needle #1'])
    assert.deepEqual(scan('built at Acme Corp', extra), ['private needle #2'])
    assert.deepEqual(scan('nothing to see', extra), [])
  })

  test('a hit is reported by number, never by the text it matched', () => {
    const [hit] = scan('mail someone@example-employer.test', parseExtraNeedles('example-employer'))
    assert.equal(hit, 'private needle #1')
    assert.doesNotMatch(hit, /example-employer/)
  })

  test('an invalid expression is an error naming only its number, not a silent skip', () => {
    assert.throws(
      () => parseExtraNeedles('ok\n(unclosed'),
      (err) => {
        assert.match(err.message, /private needle #2 is not a valid regular expression/)
        assert.doesNotMatch(err.message, /unclosed/)
        return true
      },
    )
  })

  test('no sources means no needles — the caller decides whether that may pass', () => {
    assert.deepEqual(parseExtraNeedles('', ''), [])
  })
})
