import { createConnection } from 'mysql2/promise'
import { expect, test } from 'vitest'

// ZERO babystack imports — the whole point of the walking skeleton. The app just reads DATABASE_URL, like
// production; babystack's `setup` hook has already handed this worker its own fresh, seeded database.
test('sees its own seeded database over DATABASE_URL', async () => {
  const url = process.env['DATABASE_URL']
  if (url === undefined)
    throw new Error('DATABASE_URL was not injected — babystack setup did not run')

  const conn = await createConnection(url)
  try {
    const [rows] = await conn.query('SELECT name FROM users WHERE id = 1')
    const users = rows as unknown as Array<{ name: string }>
    expect(users[0]?.name).toBe('Ada') // the seeded row, visible through a fresh per-worker lease
  } finally {
    await conn.end()
  }
})
