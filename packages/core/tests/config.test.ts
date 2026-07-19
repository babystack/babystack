import { describe, expect, it } from 'vitest'
import { BabystackError, defineConfig } from '../src/index'

describe('defineConfig', () => {
  it('returns the config unchanged for a valid single-service stack', () => {
    const config = defineConfig({
      services: {
        db: {
          engine: 'mysql',
          image: 'mysql:8.4',
          baseline: { build: ['pnpm db:migrate', 'pnpm db:seed:test'] },
        },
      },
    })
    expect(config.services.db?.engine).toBe('mysql')
  })

  it('accepts a full multi-engine stack', () => {
    const config = defineConfig({
      services: {
        db: { engine: 'mysql' },
        cache: { engine: 'redis' },
        files: { engine: 'minio', buckets: ['uploads'] },
        aws: { engine: 'localstack', services: ['sns', 'sqs'] },
      },
    })
    expect(Object.keys(config.services)).toHaveLength(4)
  })

  it('throws CONFIG_INVALID when no services are defined', () => {
    expect(() => defineConfig({ services: {} })).toThrowError(BabystackError)
    try {
      defineConfig({ services: {} })
    } catch (error) {
      expect(error).toBeInstanceOf(BabystackError)
      expect((error as BabystackError).code).toBe('CONFIG_INVALID')
    }
  })

  it('throws CONFIG_INVALID on an unknown engine', () => {
    expect(() =>
      // @ts-expect-error — 'sqlite' is deliberately not a valid engine (we never emulate).
      defineConfig({ services: { db: { engine: 'sqlite' } } }),
    ).toThrowError(/unknown engine/)
  })

  it('rejects service names that could traverse the cache dir or break SQL identifier quoting', () => {
    for (const bad of ['../pwn', 'a`b', 'has space', 'x'.repeat(33), '']) {
      expect(() => defineConfig({ services: { [bad]: { engine: 'mysql' } } })).toThrowError(
        /service name .* is invalid/,
      )
    }
  })

  it('accepts a normal service name', () => {
    expect(() => defineConfig({ services: { db_1: { engine: 'mysql' } } })).not.toThrow()
  })
})
