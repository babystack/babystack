import { appendFileSync } from 'node:fs'
import { URL, fileURLToPath } from 'node:url'
import { createConnection } from 'mysql2/promise'

// Seed the build database once, over the injected DATABASE_URL (like a real `pnpm db:seed`).
const conn = await createConnection(process.env.DATABASE_URL)
await conn.query('CREATE TABLE items (id INT PRIMARY KEY, tag VARCHAR(32) NOT NULL)')
await conn.query("INSERT INTO items (id, tag) VALUES (0, 'seed')")
await conn.end()

// Prove the baseline is built exactly ONCE (in the main process), not per worker: append a marker the
// harness counts after the run. The `.log` suffix keeps it git-ignored.
appendFileSync(fileURLToPath(new URL('./.seed-runs.log', import.meta.url)), 'x\n')
