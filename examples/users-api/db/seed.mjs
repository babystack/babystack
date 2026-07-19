// "Seed" step for baseline.build — insert the baseline fixtures every worker's fresh DB will start from.
import mysql from 'mysql2/promise'

const conn = await mysql.createConnection(process.env.DATABASE_URL)
await conn.query('INSERT INTO users (email, name) VALUES (?, ?)', [
  'ada@example.com',
  'Ada Lovelace',
])
await conn.end()
