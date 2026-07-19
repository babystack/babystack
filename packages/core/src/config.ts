import type { Engine, Mode } from './types'
import { BabystackError } from './types'

export interface BaselineConfig {
  /** Phase 0: `'logical-dump'` only (mysqldump → reload). `'cow'`/`'clone-plugin'` are added when a real
   * second strategy exists — offering them now would be a silently-ignored no-op (fail-fast + YAGNI). */
  readonly strategy?: 'logical-dump'
  /** Shell commands run once to build the reusable baseline (migrate + seed). */
  readonly build?: readonly string[]
  /** Globs whose content feeds the invalidation hash; a change rebuilds the baseline. */
  readonly invalidateWhenChanged?: readonly string[]
}

export interface TestPolicy {
  /** Phase 0: `'snapshot'` only — a fresh per-worker DB reloaded from the baseline per test file.
   * `'truncate'` is cut from Phase 0 (added later only on real demand). */
  readonly reset?: 'snapshot'
  readonly cleanup?: 'destroy' | 'keep-on-failure' | 'keep'
}

interface ServiceBase {
  readonly image?: string
  readonly baseline?: BaselineConfig
  readonly test?: TestPolicy
}

export interface MysqlService extends ServiceBase {
  readonly engine: 'mysql'
  readonly database?: string
}
export interface RedisService extends ServiceBase {
  readonly engine: 'redis'
}
export interface MinioService extends ServiceBase {
  readonly engine: 'minio'
  readonly buckets?: readonly string[]
}
export interface DynamoService extends ServiceBase {
  readonly engine: 'dynamodb-local'
  readonly tables?: readonly string[]
}
export interface ElasticmqService extends ServiceBase {
  readonly engine: 'elasticmq'
  readonly queues?: readonly string[]
}
export interface LocalstackService extends ServiceBase {
  readonly engine: 'localstack'
  readonly services?: readonly string[]
}

/** Discriminated union over `engine`. */
export type ServiceConfig =
  MysqlService | RedisService | MinioService | DynamoService | ElasticmqService | LocalstackService

export interface BabystackConfig {
  readonly mode?: Mode
  readonly services: Readonly<Record<string, ServiceConfig>>
}

const KNOWN_ENGINES: ReadonlySet<Engine> = new Set([
  'mysql',
  'redis',
  'minio',
  'dynamodb-local',
  'elasticmq',
  'localstack',
])

// Service names flow UNQUOTED into filesystem paths (the baseline cache dir) and backtick-quoted SQL
// identifiers (`babystack_<name>_w<id>`). Constrain them at the boundary so a name can't traverse the
// cache dir (`../…`) or break out of an identifier (a backtick) — fail fast rather than at exec time.
const SERVICE_NAME = /^[A-Za-z0-9_]{1,32}$/

/**
 * Identity helper that gives editors full typing on `babystack.config.ts` and fails fast on obviously
 * invalid config. Pure: no I/O.
 */
export function defineConfig(config: BabystackConfig): BabystackConfig {
  const names = Object.keys(config.services ?? {})
  if (names.length === 0) {
    throw new BabystackError(
      'CONFIG_INVALID',
      'babystack config must define at least one service under `services`.',
    )
  }
  for (const name of names) {
    if (!SERVICE_NAME.test(name)) {
      throw new BabystackError(
        'CONFIG_INVALID',
        `service name "${name}" is invalid — use only letters, digits, and underscores (1–32 chars).`,
      )
    }
    const engine = config.services[name]?.engine
    if (engine === undefined || !KNOWN_ENGINES.has(engine)) {
      throw new BabystackError(
        'CONFIG_INVALID',
        `service "${name}" has an unknown engine: ${String(engine)}.`,
      )
    }
  }
  return config
}
