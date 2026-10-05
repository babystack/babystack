/**
 * No tracked file may carry a pointer the public cannot follow, or a private name. The tarball scan
 * (scripts/verify-tarballs.mjs) guards what ships to npm; this guards everything else a reader of this public
 * repository sees — docs, workflows, comments, tests — with the same needles, private ones included, so the
 * two checks cannot drift apart.
 *
 * Private needles come from `.leak-needles` or `LEAK_SCAN_EXTRA` (a repository secret in CI). Without them
 * only the public needles run, and the test says so; the release job is the one that refuses to run without.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NEEDLES, loadExtraNeedles } from '../../scripts/verify-tarballs.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// Files that must contain matches, because they define or prove the needles.
const DEFINE_THE_NEEDLES = new Set([
  'scripts/verify-tarballs.mjs',
  'tests/scripts/release-gates.test.mjs',
])
// Generated, and every name in it is a public package; its integrity hashes are random base64.
const GENERATED = new Set(['pnpm-lock.yaml'])
// Known lines still to fix, matched exactly, with the reason in the file. Every entry must still exist, so a
// fixed line cannot leave a stale exception behind.
const KNOWN_FILE = 'tests/scripts/fixtures/known-pointers.json'
const KNOWN = existsSync(join(ROOT, KNOWN_FILE))
  ? JSON.parse(readFileSync(join(ROOT, KNOWN_FILE), 'utf8')).lines
  : []

function trackedTextFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((f) => f && !DEFINE_THE_NEEDLES.has(f) && !GENERATED.has(f))
    .map((f) => ({ f, text: readFileSync(join(ROOT, f), 'utf8') }))
    .filter(({ text }) => !text.includes('\u0000'))
}

test('no tracked file points somewhere the public cannot follow, or names something private', (t) => {
  const extra = loadExtraNeedles()
  if (extra.length === 0)
    t.diagnostic('no private needles supplied — employer and private-repo names unchecked')
  const known = new Set(KNOWN.map((k) => `${k.file}:${k.text}`))
  const seen = new Set()
  const hits = []
  for (const { f, text } of trackedTextFiles()) {
    text.split('\n').forEach((line, i) => {
      const names = [...NEEDLES, ...extra].filter(({ re }) => re.test(line)).map(({ name }) => name)
      if (names.length === 0) return
      const key = `${f}:${line.trim()}`
      if (known.has(key)) return void seen.add(key)
      hits.push(`${f}:${i + 1} — ${names.join(', ')}`)
    })
  }
  assert.deepEqual(
    hits,
    [],
    `rewrite the sentence; do not just delete the token:\n${hits.join('\n')}`,
  )
  const stale = [...known].filter((k) => !seen.has(k))
  assert.deepEqual(stale, [], `remove these from ${KNOWN_FILE} — the line is gone or fixed`)
})
