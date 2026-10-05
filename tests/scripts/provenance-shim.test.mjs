/**
 * The release job's `pnpm` shim must add `--provenance` to `pnpm publish` and touch nothing else. It is
 * exercised against a stub that only echoes its arguments: no real pnpm, and nothing that could publish.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SHIM = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/provenance/pnpm')

function run(args, realPnpm) {
  const env = { PATH: process.env.PATH }
  if (realPnpm !== undefined) env.REAL_PNPM = realPnpm
  return spawnSync('bash', [SHIM, ...args], { env, encoding: 'utf8' })
}

describe('provenance shim', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pnpm-stub-'))
  const stub = join(dir, 'pnpm')
  writeFileSync(stub, '#!/usr/bin/env bash\necho "$*"\n', { mode: 0o755 })

  test('adds --provenance to pnpm publish', () => {
    const r = run(['publish', '--json', '--access', 'public', '--tag', 'latest'], stub)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout.trim(), 'publish --json --access public --tag latest --provenance')
  })

  test('does not add it twice', () => {
    assert.equal(run(['publish', '--provenance'], stub).stdout.trim(), 'publish --provenance')
  })

  test('passes every other command through unchanged', () => {
    assert.equal(run(['run', 'release'], stub).stdout.trim(), 'run release')
    assert.equal(run(['--version'], stub).stdout.trim(), '--version')
  })

  test('refuses without REAL_PNPM, and when REAL_PNPM is the shim itself', () => {
    assert.notEqual(run(['publish']).status, 0)
    assert.notEqual(run(['publish'], SHIM).status, 0)
  })

  test.after(() => rmSync(dir, { recursive: true, force: true }))
})
