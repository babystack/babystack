import { describe, expect, it } from 'vitest'
import { COMMANDS, doctorChecks, readsEnvTooEarly, run } from '../src/index'

// Docker-free unit tests — the argv paths that don't touch Docker, plus the pure env-scan heuristic. The
// real commands (which provision MySQL) are covered by the integration test.

describe('baby CLI', () => {
  it('prints help listing every command (and its aliases) with no args', async () => {
    const result = await run([])
    expect(result.code).toBe(0)
    for (const command of COMMANDS) expect(result.output).toContain(command)
    for (const alias of ['(up)', '(env)', '(down)']) expect(result.output).toContain(alias)
  })

  it('exits non-zero and shows help for an unknown command', async () => {
    const result = await run(['frobnicate'])
    expect(result.code).toBe(1)
    expect(result.output).toContain('unknown command')
  })

  it('documents the wake --rebuild escape hatch in help', async () => {
    const result = await run([])
    expect(result.output).toContain('--rebuild')
  })
})

describe('readsEnvTooEarly (doctor heuristic)', () => {
  it('flags a module-level binding that captures DATABASE_URL at import', () => {
    expect(readsEnvTooEarly('export const pool = mysql.createPool(process.env.DATABASE_URL)')).toBe(
      true,
    )
    expect(readsEnvTooEarly('const url = process.env.DATABASE_URL')).toBe(true)
  })

  it('flags a destructured read from process.env', () => {
    expect(readsEnvTooEarly('const { DATABASE_URL } = process.env')).toBe(true)
    expect(readsEnvTooEarly('export const { DATABASE_URL: url } = process.env')).toBe(true)
  })

  it('flags a genuine early read even when an arrow appears later on the line', () => {
    // The old `=>`-anywhere guard let this slip; the RHS starts with process.env, so it IS an import read.
    expect(readsEnvTooEarly("const u = process.env.DATABASE_URL ?? (() => '')()")).toBe(true)
  })

  it('does NOT flag a lazy getter (RHS starts with an arrow or function)', () => {
    expect(
      readsEnvTooEarly('export const db = () => mysql.createPool(process.env.DATABASE_URL)'),
    ).toBe(false)
    expect(
      readsEnvTooEarly('export const db = async () => connect(process.env.DATABASE_URL)'),
    ).toBe(false)
  })

  it('does NOT flag a read inside a function body (indented, not module-level)', () => {
    expect(readsEnvTooEarly('function connect() {\n  return process.env.DATABASE_URL\n}')).toBe(
      false,
    )
  })

  it('does NOT flag DATABASE_URL that only appears in a comment', () => {
    expect(readsEnvTooEarly('const timeout = 5000 // set from DATABASE_URL later')).toBe(false)
  })

  it('does NOT flag source that never touches DATABASE_URL', () => {
    expect(readsEnvTooEarly('export const x = 1')).toBe(false)
  })
})

describe('doctorChecks', () => {
  it('runs all preflight checks in display order, and node passes on a supported runtime', async () => {
    // Inject the Docker probe so the unit test never shells out to `docker info` (deterministic + fast).
    const checks = await doctorChecks(async () => true)
    expect(checks.map((c) => c.name)).toEqual(['node', 'docker', 'config', 'cache', 'env-read'])
    // Node is the one check independent of the environment (we run the suite on a supported major).
    expect(checks.find((c) => c.name === 'node')?.ok).toBe(true)
    // Docker check reflects the injected probe.
    expect(checks.find((c) => c.name === 'docker')?.ok).toBe(true)
    // env-read and cache are warnings, never hard failures.
    const envRead = checks.find((c) => c.name === 'env-read')
    if (envRead && !envRead.ok) expect(envRead.warn).toBe(true)
    const cache = checks.find((c) => c.name === 'cache')
    if (cache && !cache.ok) expect(cache.warn).toBe(true)
  })
})
