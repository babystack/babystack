/**
 * The release job's `pnpm` shim must add `--provenance` to a publish and touch nothing else. It runs here
 * against a stub `pnpm` that only echoes its arguments: no real pnpm, and nothing that could publish. The stub
 * sits later on PATH than the shim, exactly as the real pnpm does in the release job.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SHIM_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/provenance')

describe('provenance shim', () => {
  const stubDir = mkdtempSync(join(tmpdir(), 'pnpm-stub-'))
  writeFileSync(join(stubDir, 'pnpm'), '#!/usr/bin/env bash\necho "$*"\n', { mode: 0o755 })
  // Only PATH: a task runner such as turbo may drop every other variable before calling pnpm.
  const run = (args, path = `${SHIM_DIR}:${stubDir}:/usr/bin:/bin`) =>
    spawnSync(join(SHIM_DIR, 'pnpm'), args, { env: { PATH: path }, encoding: 'utf8' })

  test('adds --provenance to a publish, however it is spelled', () => {
    for (const [args, want] of [
      [['publish', '--json', '--tag', 'latest'], 'publish --json --tag latest --provenance'],
      [['-r', 'publish'], '-r publish --provenance'],
      [['--filter', 'pkg', 'publish'], '--filter pkg publish --provenance'],
    ]) {
      const r = run(args)
      assert.equal(r.status, 0, r.stderr)
      assert.equal(r.stdout.trim(), want)
    }
  })

  test('does not add it twice', () => {
    assert.equal(run(['publish', '--provenance']).stdout.trim(), 'publish --provenance')
  })

  test('passes every other command through unchanged, with nothing but PATH set', () => {
    assert.equal(run(['run', 'build']).stdout.trim(), 'run build')
    assert.equal(run(['--filter', 'publish', 'build']).stdout.trim(), '--filter publish build')
    assert.equal(run(['--version']).stdout.trim(), '--version')
  })

  test('refuses when the only pnpm on PATH is the shim itself', () => {
    const r = run(['publish'], `${SHIM_DIR}:/usr/bin:/bin`)
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /no pnpm on PATH besides this shim/)
  })

  test.after(() => rmSync(stubDir, { recursive: true, force: true }))
})
