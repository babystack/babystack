# @babystack/vitest

The **Vitest integration** for [babystack](https://github.com/babystack/babystack) — fresh, seeded,
isolated real MySQL for your integration tests, with **zero test-code changes**.

Add three lines to `vitest.config.ts` and your tests just read `process.env.DATABASE_URL`, exactly like
production. One `mysqld` container is provisioned once and seeded into a baseline; each Vitest worker gets
its own fresh database loaded from it (keyed by `VITEST_POOL_ID`), so tests run in parallel against isolated
real databases.

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: '@babystack/vitest/global-setup',
    setupFiles: ['@babystack/vitest/setup'],
    pool: 'forks',
  },
})
```

```bash
npm i -D @babystack/vitest   # one package — pulls the engine (core + mysql + docker) transitively
```

Your `babystack.config.ts` imports `defineConfig` from `@babystack/vitest` (re-exported here, so this is the
only package you install for tests). Requires a running Docker engine. For the config format, isolation semantics, and a runnable example, see
the [babystack repository](https://github.com/babystack/babystack). Licensed **Apache-2.0**.
