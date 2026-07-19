import { defineConfig } from '@babystack/core'
import { MysqlAdapter } from '@babystack/mysql'
import { describe, expect, it } from 'vitest'
import {
  buildEnvAllowlist,
  createMysqlAdapter,
  resolveMysqlService,
  toProvisionSpec,
  toSeedSpec,
} from '../src/index'

// Pure resolver logic — no Docker, no MySQL. The provision→lease path is covered by the integration test.

describe('buildEnvAllowlist', () => {
  it('passes only the safe basics and drops app/DB secrets', () => {
    const env = buildEnvAllowlist({
      PATH: '/usr/bin',
      HOME: '/home/ada',
      DATABASE_URL: 'mysql://real:secret@prod/db', // must NOT cross into a seed command
      AWS_SECRET_ACCESS_KEY: 'nope',
    })
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/ada' })
  })

  it('drops keys that are absent from the source', () => {
    expect(buildEnvAllowlist({ PATH: '/usr/bin' })).toEqual({ PATH: '/usr/bin' })
  })
})

describe('resolveMysqlService', () => {
  it('returns the single mysql service', () => {
    const config = defineConfig({ services: { db: { engine: 'mysql', image: 'mysql:8.4' } } })
    const { name, service } = resolveMysqlService(config)
    expect(name).toBe('db')
    expect(service.engine).toBe('mysql')
  })

  it('rejects zero services', () => {
    expect(() => resolveMysqlService({ services: {} })).toThrowError(/exactly one service/)
  })

  it('rejects more than one service (Phase 0 scope)', () => {
    const config = defineConfig({
      services: { db: { engine: 'mysql' }, cache: { engine: 'redis' } },
    })
    expect(() => resolveMysqlService(config)).toThrowError(/exactly one service/)
  })

  it('rejects a non-mysql engine', () => {
    const config = defineConfig({ services: { cache: { engine: 'redis' } } })
    expect(() => resolveMysqlService(config)).toThrowError(/only the 'mysql' engine/)
  })
})

describe('toProvisionSpec', () => {
  it('carries the image when configured', () => {
    expect(toProvisionSpec('db', { engine: 'mysql', image: 'mysql:8.4' })).toEqual({
      service: 'db',
      engine: 'mysql',
      image: 'mysql:8.4',
    })
  })

  it('omits image entirely when not configured (adapter default applies)', () => {
    const spec = toProvisionSpec('db', { engine: 'mysql' })
    expect(spec).toEqual({ service: 'db', engine: 'mysql' })
    expect('image' in spec).toBe(false)
  })
})

describe('toSeedSpec', () => {
  it('lifts baseline.build into commands with a scrubbed env', () => {
    const spec = toSeedSpec({
      engine: 'mysql',
      baseline: { build: ['pnpm db:migrate', 'pnpm db:seed'] },
    })
    expect(spec.commands).toEqual(['pnpm db:migrate', 'pnpm db:seed'])
    expect(spec.env).not.toHaveProperty('DATABASE_URL')
  })

  it('defaults to no commands when no baseline build is set', () => {
    expect(toSeedSpec({ engine: 'mysql' }).commands).toEqual([])
  })
})

describe('createMysqlAdapter', () => {
  it('wires a real MySQL adapter over the Docker runtime ports', () => {
    // Construction only — no Docker call happens until provision(); safe in the Docker-free unit tier.
    expect(createMysqlAdapter({ runId: 'unit', image: 'mysql:8.4' })).toBeInstanceOf(MysqlAdapter)
  })
})
