import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createConnection } from 'mysql2/promise'
import { expect } from 'vitest'

// Each worker records the database it used here (O_APPEND is atomic for these short lines across the
// concurrent worker processes); the harness reads it to confirm N DISTINCT databases ran in parallel.
const workerDbLog = fileURLToPath(new URL('./.worker-dbs.log', import.meta.url))

// The cross-worker sentinel. Each file runs in its own worker, in its own leased copy of the baseline. It
// must see ONLY the baseline seed row + the single marker it writes itself — never a concurrent worker's.
// The 500ms window between write and read widens the race, so a broken (shared) database is CAUGHT here
// rather than passing by luck of timing.
export async function checkIsolation(tag: string): Promise<void> {
  const url = process.env['DATABASE_URL']
  if (url === undefined)
    throw new Error('DATABASE_URL was not injected — babystack setup did not run')

  const conn = await createConnection(url)
  try {
    // The seeded baseline row is present → this worker got its own fresh copy of the baseline.
    const [seedRows] = await conn.query("SELECT tag FROM items WHERE tag = 'seed'")
    expect((seedRows as unknown as unknown[]).length).toBe(1)

    // Write this worker's unique marker, then wait so any concurrent worker sharing this DB would show up.
    await conn.query('INSERT INTO items (id, tag) VALUES (?, ?)', [tag.charCodeAt(0), tag])
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 500)
    })

    // Exactly the seed + this worker's own row — no foreign markers leaked across the isolation boundary.
    const [rows] = await conn.query('SELECT tag FROM items ORDER BY id')
    const tags = (rows as unknown as Array<{ tag: string }>).map((row) => row.tag)
    expect(tags).toEqual(['seed', tag])

    // Report the database this worker used, so the harness can confirm N distinct DBs ran in parallel.
    appendFileSync(workerDbLog, `${process.env['MYSQL_DATABASE'] ?? '?'}\n`)
  } finally {
    await conn.end()
  }
}
