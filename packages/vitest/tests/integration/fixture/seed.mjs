// Seed the build database the way a real app would: connect over the babystack-injected DATABASE_URL and
// run DDL + inserts. No babystack import — just the connection string, like production. babystack builds
// this into the reusable baseline; every worker then leases a fresh copy of it.
import { createConnection } from 'mysql2/promise'

const conn = await createConnection(process.env.DATABASE_URL)
await conn.query('CREATE TABLE users (id INT PRIMARY KEY, name VARCHAR(64) NOT NULL)')
await conn.query("INSERT INTO users (id, name) VALUES (1, 'Ada')")
await conn.end()
