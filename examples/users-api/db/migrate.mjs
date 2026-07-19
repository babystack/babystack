// "Migrate" step for baseline.build — apply the schema to the babystack-injected build database.
// A real app would run Drizzle/Prisma/Knex migrations here; we keep it to one plain SQL file.
import { readFile } from 'node:fs/promises'
import { URL, fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'

const sql = await readFile(fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf8')
const conn = await mysql.createConnection(process.env.DATABASE_URL)
await conn.query(sql)
await conn.end()
