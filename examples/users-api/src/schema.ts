import { int, mysqlTable, timestamp, varchar } from 'drizzle-orm/mysql-core'

// One table, with a real UNIQUE(email) constraint — the kind of thing a mock silently lets pass but a real
// engine enforces (see tests/constraint.test.ts).
export const users = mysqlTable('users', {
  id: int('id').autoincrement().primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  name: varchar('name', { length: 255 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})
