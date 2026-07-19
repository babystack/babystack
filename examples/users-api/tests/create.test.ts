import request from 'supertest'
import { expect, test } from 'vitest'
import { createApp } from '../src/app'

const app = createApp()

// Runs FIRST: proves this file's worker got its own fresh baseline — it can't see the user that
// create.test.ts's second test (or any other file) inserts. That's the cross-worker isolation guarantee.
test('is isolated — sees only the baseline, not other files’ writes', async () => {
  const res = await request(app).get('/users')
  expect(res.body).toHaveLength(1)
})

test('creates a user with a real committed write', async () => {
  const created = await request(app)
    .post('/users')
    .send({ email: 'grace@example.com', name: 'Grace Hopper' })
  expect(created.status).toBe(201)

  // Committed, real, and visible to the next request — not a rolled-back transaction.
  const list = await request(app).get('/users')
  expect(list.body).toHaveLength(2)
  expect(list.body.map((u: { email: string }) => u.email)).toContain('grace@example.com')
})
