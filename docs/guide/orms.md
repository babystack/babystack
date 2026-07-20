# babystack with your ORM (or none)

> babystack is **ORM-agnostic**. It provisions a real MySQL and injects a disposable connection into
> both your baseline `build` commands and your tests/app — as `DATABASE_URL`
> (`mysql://root:<minted>@127.0.0.1:<port>/<db>`) plus the decomposed `MYSQL_HOST` / `MYSQL_PORT` /
> `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DATABASE`. It never reads, writes, or guesses your schema. So
> the **only** thing that changes between ORMs is one config field — `baseline.build`, the commands that
> migrate + seed. Your app just reads `DATABASE_URL`, exactly like production.

## Table of contents

- [The whole contract](#the-whole-contract)
- [Prisma](#prisma)
- [Drizzle](#drizzle)
- [Sequelize](#sequelize)
- [TypeORM](#typeorm)
- [Knex](#knex)
- [Kysely](#kysely)
- [Raw mysql2 (no ORM)](#raw-mysql2-no-orm)
- [Anything else](#anything-else)

## The whole contract

Two things, and nothing else:

1. **`baseline.build`** — ordered shell commands, run **once** against a temp build DB, that apply your
   schema and seed it. babystack injects `DATABASE_URL` (+ `MYSQL_*`) into their environment; point your
   migrate/seed tool at `DATABASE_URL`. (These are separate processes — the tool reads the env directly.)
2. **Your app/tests read `DATABASE_URL` lazily** — build the client on first use, not at module-import
   time, because babystack sets the URL just before your app is imported. This is the one app-code rule
   (see [the env contract](./getting-started.md#the-env-contract--and-the-one-rule)). The `x ??= …` lazy
   getter below is all it takes.

Everything below is just those two things, per tool. The [`users-api` example](../../examples/users-api)
is the full runnable proof (Drizzle).

## Prisma

```ts
// babystack.config.ts
baseline: {
  build: ['pnpm prisma migrate deploy', 'pnpm tsx prisma/seed.ts']
}
```

Prisma reads `DATABASE_URL` from the environment (`datasource db { url = env("DATABASE_URL") }`), so
`migrate deploy` and the client both just work — no extra wiring:

```ts
import { PrismaClient } from '@prisma/client'
let prisma: PrismaClient
export const getDb = () => (prisma ??= new PrismaClient())
```

## Drizzle

```ts
baseline: {
  build: ['pnpm db:migrate', 'pnpm db:seed:test']
}
```

```ts
import { drizzle } from 'drizzle-orm/mysql2'
import mysql from 'mysql2/promise'
let db: ReturnType<typeof drizzle>
export const getDb = () => (db ??= drizzle(mysql.createPool(process.env.DATABASE_URL!)))
```

This is exactly what [`examples/users-api`](../../examples/users-api) does — clone-and-run it.

## Sequelize

```ts
baseline: {
  build: ['pnpm sequelize-cli db:migrate', 'pnpm sequelize-cli db:seed:all']
}
```

Point the CLI config at the URL (`config/config.js` → `{ use_env_variable: 'DATABASE_URL', dialect: 'mysql' }`),
and in the app:

```ts
import { Sequelize } from 'sequelize'
let sequelize: Sequelize
export const getDb = () =>
  (sequelize ??= new Sequelize(process.env.DATABASE_URL!, { dialect: 'mysql' }))
```

## TypeORM

```ts
baseline: {
  build: ['pnpm typeorm migration:run -d ./data-source.ts', 'pnpm tsx seed.ts']
}
```

```ts
import { DataSource } from 'typeorm'
let ds: DataSource
export const getDb = async () =>
  ds?.isInitialized
    ? ds
    : (ds = await new DataSource({
        type: 'mysql',
        url: process.env.DATABASE_URL,
        entities: [/* … */],
      }).initialize())
```

## Knex

```ts
baseline: {
  build: ['pnpm knex migrate:latest', 'pnpm knex seed:run']
}
```

Both `knexfile` and app use `connection: process.env.DATABASE_URL`:

```ts
import knex from 'knex'
let db: ReturnType<typeof knex>
export const getDb = () =>
  (db ??= knex({ client: 'mysql2', connection: process.env.DATABASE_URL! }))
```

## Kysely

```ts
baseline: {
  build: ['pnpm kysely migrate:latest', 'pnpm tsx seed.ts']
}
```

```ts
import { Kysely, MysqlDialect } from 'kysely'
import { createPool } from 'mysql2'
let db: Kysely<DB>
export const getDb = () =>
  (db ??= new Kysely<DB>({
    dialect: new MysqlDialect({ pool: createPool(process.env.DATABASE_URL!) }),
  }))
```

Run migrations with `kysely-ctl` (or any runner that reads `DATABASE_URL`).

## Raw mysql2 (no ORM)

No ORM, no migration tool — just SQL. Apply your `schema.sql` + `seed.sql` with a tiny script, and
connect with the driver. This is the **simplest** case of all:

```ts
baseline: {
  build: ['pnpm tsx db/apply.ts']
} // runs schema.sql then seed.sql against the build DB
```

```ts
// db/apply.ts — uses the decomposed MYSQL_* vars + multipleStatements
import { readFileSync } from 'node:fs'
import mysql from 'mysql2/promise'
const c = await mysql.createConnection({
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  multipleStatements: true,
})
await c.query(readFileSync('db/schema.sql', 'utf8'))
await c.query(readFileSync('db/seed.sql', 'utf8'))
await c.end()
```

```ts
// app — one line
import mysql from 'mysql2/promise'
let pool: mysql.Pool
export const getPool = () => (pool ??= mysql.createPool(process.env.DATABASE_URL!))
```

## Anything else

Not listed? It still works. babystack only needs a `build` command that migrates + seeds against
`DATABASE_URL`, and your app to read `DATABASE_URL`. Whatever sits between — an ORM, a query builder, a
raw driver, a migration tool of your choice — babystack neither knows nor cares.
