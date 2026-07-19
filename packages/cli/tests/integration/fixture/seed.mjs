import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import mysql from 'mysql2/promise'

// The widget name comes from an optional watched file (`widget-name.txt`), defaulting to 'seeded-widget'
// when absent. This lets the integration test prove that editing a watched input and re-running `baby wake`
// serves the NEW seed — the DB the app connects to reflects the change, not a stale cached baseline.
const name = await readFile(join(import.meta.dirname, 'widget-name.txt'), 'utf8')
  .then((text) => text.trim())
  .catch(() => 'seeded-widget')

const conn = await mysql.createConnection(process.env.DATABASE_URL)
await conn.query('CREATE TABLE widgets (id INT PRIMARY KEY, name VARCHAR(64) NOT NULL)')
await conn.query('INSERT INTO widgets (id, name) VALUES (1, ?)', [name])
await conn.end()
