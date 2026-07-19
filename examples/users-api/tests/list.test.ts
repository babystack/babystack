import request from 'supertest'
import { expect, test } from 'vitest'
import { createApp } from '../src/app'

// NOTE: zero babystack imports. This is an ordinary integration test against a real API + real MySQL.
const app = createApp()

test('a fresh worker starts from exactly the seeded baseline', async () => {
  const res = await request(app).get('/users')
  expect(res.status).toBe(200)
  expect(res.body).toHaveLength(1) // just Ada — writes from other test files never leak in
  expect(res.body[0].email).toBe('ada@example.com')
})
