import { describe, expect, it } from 'vitest'
import { computeInvalidationHash, type InvalidationInputs } from '../src/index'

const base: InvalidationInputs = {
  configText: 'export default defineConfig({ services: { db: { engine: "mysql" } } })',
  files: [
    { path: 'db/migrations/001_init.sql', contents: 'CREATE TABLE users (id INT);' },
    { path: 'db/seeds/test.sql', contents: 'INSERT INTO users VALUES (1);' },
  ],
  engineImage: 'mysql:8.4',
  toolVersion: '0.0.0',
  buildCommands: ['pnpm db:migrate', 'pnpm db:seed:test'],
}

describe('computeInvalidationHash', () => {
  it('is deterministic for identical inputs', () => {
    expect(computeInvalidationHash(base)).toBe(computeInvalidationHash(base))
  })

  it('is independent of file order', () => {
    const reordered: InvalidationInputs = { ...base, files: [...base.files].reverse() }
    expect(computeInvalidationHash(reordered)).toBe(computeInvalidationHash(base))
  })

  it('changes when a migration file changes', () => {
    const changed: InvalidationInputs = {
      ...base,
      files: [
        { path: 'db/migrations/001_init.sql', contents: 'CREATE TABLE users (id BIGINT);' },
        base.files[1]!,
      ],
    }
    expect(computeInvalidationHash(changed)).not.toBe(computeInvalidationHash(base))
  })

  it('changes when the engine image changes', () => {
    expect(computeInvalidationHash({ ...base, engineImage: 'mysql:8.0' })).not.toBe(
      computeInvalidationHash(base),
    )
  })

  it('changes when the baseline-format (tool) version changes', () => {
    // The whole point of BASELINE_FORMAT_VERSION is "bump to invalidate every cached baseline", so it MUST
    // participate in the hash — guards against a regression that drops `put('tool', …)`.
    expect(computeInvalidationHash({ ...base, toolVersion: '2' })).not.toBe(
      computeInvalidationHash(base),
    )
  })

  it('is not fooled by path/content boundary collisions', () => {
    const a: InvalidationInputs = { ...base, files: [{ path: 'ab', contents: 'c' }] }
    const b: InvalidationInputs = { ...base, files: [{ path: 'a', contents: 'bc' }] }
    expect(computeInvalidationHash(a)).not.toBe(computeInvalidationHash(b))
  })

  it('is injective across file split/merge (length-prefix framing, the trust cliff)', () => {
    // Two files vs. ONE file whose contents embed the second file's framed bytes (label words + separators).
    // A non-length-prefixed encoding would collide these to one hash → the cache reuses a baseline built
    // from different inputs → stale seed. Length-prefixing makes the merge impossible to disguise.
    const twoFiles: InvalidationInputs = {
      ...base,
      files: [
        { path: '01', contents: 'A' },
        { path: '02', contents: 'B' },
      ],
    }
    const merged: InvalidationInputs = {
      ...base,
      files: [{ path: '01', contents: 'A:path:02:contents:B' }],
    }
    expect(computeInvalidationHash(twoFiles)).not.toBe(computeInvalidationHash(merged))
  })

  it('is injective across build-command split/merge', () => {
    const split: InvalidationInputs = { ...base, buildCommands: ['a', 'b'] }
    const merged: InvalidationInputs = { ...base, buildCommands: ['a:cmd:b'] }
    expect(computeInvalidationHash(split)).not.toBe(computeInvalidationHash(merged))
  })
})
