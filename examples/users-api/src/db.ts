import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2'
import mysql from 'mysql2/promise'
import * as schema from './schema'

let cached: MySql2Database<typeof schema> | undefined

/**
 * The connection, opened LAZILY on first use. This is the one app-code rule babystack asks for: read
 * `DATABASE_URL` when you first query, not at import time — babystack injects it just before your app is
 * imported, so a module that captured it at import would freeze a stale/absent value.
 */
export function db(): MySql2Database<typeof schema> {
  if (cached) return cached
  const url = process.env['DATABASE_URL']
  if (url === undefined) {
    throw new Error(
      'DATABASE_URL is not set — babystack setup should have injected it before app import',
    )
  }
  cached = drizzle(mysql.createPool(url), { schema, mode: 'default' })
  return cached
}
