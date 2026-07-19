# users-api — a babystack example

A tiny but **real** app — Express 5 + Drizzle ORM + MySQL — whose integration tests run against a **fresh,
seeded, isolated real MySQL database per worker**, with **zero lifecycle code in the tests**. It's the
end-to-end proof that babystack works on a normal stack, and the thing to copy into your own repo.

## Run it

```bash
# from the repo root — Docker must be running (that's the only prerequisite)
pnpm install
pnpm --filter users-api test
```

You'll see three test files pass in parallel in ~10s. Under the hood, on that one command babystack:

1. provisioned **one** real `mysql:8.4` container,
2. ran your `db:migrate` + `db:seed` **once** to build a seeded baseline (`mysqldump`, cached),
3. handed each Vitest worker **its own fresh database** loaded from that baseline, as `DATABASE_URL`,
4. tore it all down afterward (0 leftover containers).

## What makes it work — three lines, no test changes

**`babystack.config.ts`** — describe the backend + how to seed it, once:

```ts
export default defineConfig({
  services: {
    db: {
      engine: 'mysql',
      image: 'mysql:8.4',
      baseline: { build: ['pnpm db:migrate', 'pnpm db:seed'] },
    },
  },
})
```

**`vitest.config.ts`** — wire the two hooks + `pool: 'forks'`:

```ts
test: {
  globalSetup: ['@babystack/vitest/global-setup'],
  setupFiles: ['@babystack/vitest/setup'],
  pool: 'forks',
}
```

**The tests** — [`tests/`](./tests) — import **no babystack**. They hit the Express app with `supertest` and
read the app's normal `DATABASE_URL`, exactly like production. The app ([`src/`](./src)) can't tell it's in
a test.

## Before / after

```diff
- # docker-compose.test.yml + a shared dev DB that flakes when suites run in parallel
- beforeAll(async () => { /* boot db, migrate, seed, wire env… */ })
- afterEach(async () => { /* truncate tables, hope nothing leaked across tests… */ })
+ // babystack.config.ts describes the stack once; the tests below stay clean.
+ test('creates a user', async () => { await request(app).post('/users')… })
```

## What each test proves

- [`list.test.ts`](./tests/list.test.ts) — a worker starts from **exactly the seeded baseline** (just Ada).
- [`create.test.ts`](./tests/create.test.ts) — **cross-worker isolation** (it never sees another file's
  writes) + a **real committed write** (not a rolled-back transaction).
- [`constraint.test.ts`](./tests/constraint.test.ts) — the **real `UNIQUE(email)` constraint** returns a 409. A mock would have let the duplicate through and lied to you.

> In your own repo these would just be `tests/*.test.ts` run by `pnpm test`. Here they run via
> `pnpm --filter users-api test` so this monorepo's fast, Docker-free CI tier can skip them and the
> Docker-backed tier runs them.
