import request from 'supertest'
import { expect, test } from 'vitest'
import { createApp } from '../src/app'

const app = createApp()

// The payoff of testing against a REAL engine: the UNIQUE(email) constraint actually fires. A mock or an
// in-memory fake would happily accept the duplicate and give you false confidence.
test('enforces the real UNIQUE(email) constraint — second insert is a 409', async () => {
  await request(app).post('/users').send({ email: 'dup@example.com', name: 'First' }).expect(201)
  await request(app).post('/users').send({ email: 'dup@example.com', name: 'Second' }).expect(409)
})
