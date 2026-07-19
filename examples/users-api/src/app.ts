import express, { type Express, type Request, type Response } from 'express'
import { db } from './db'
import { users } from './schema'

// Is this a MySQL duplicate-key error? (mysql2 surfaces ER_DUP_ENTRY / errno 1062; drizzle may wrap it.)
function isDuplicateKey(error: unknown): boolean {
  const e = error as { code?: string; errno?: number; cause?: { code?: string; errno?: number } }
  return (
    e?.code === 'ER_DUP_ENTRY' ||
    e?.errno === 1062 ||
    e?.cause?.code === 'ER_DUP_ENTRY' ||
    e?.cause?.errno === 1062
  )
}

/** A tiny, ordinary Express API over the real MySQL — nothing here knows it's under test. */
export function createApp(): Express {
  const app = express()
  app.use(express.json())

  app.get('/users', async (_req: Request, res: Response) => {
    const rows = await db().select().from(users)
    res.json(rows)
  })

  app.post('/users', async (req: Request, res: Response) => {
    const { email, name } = (req.body ?? {}) as { email?: string; name?: string }
    if (!email || !name) {
      res.status(400).json({ error: 'email and name are required' })
      return
    }
    try {
      const [result] = await db().insert(users).values({ email, name })
      res.status(201).json({ id: result.insertId, email, name })
    } catch (error) {
      if (isDuplicateKey(error)) {
        res.status(409).json({ error: 'a user with that email already exists' })
        return
      }
      throw error // Express 5 forwards a rejected async handler to the error pipeline → 500
    }
  })

  return app
}
