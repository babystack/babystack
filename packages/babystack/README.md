# babystack

**Real MySQL, fresh every run — a local baby of your production stack.**

Every test run and every AI-agent session gets its own private, seeded, disposable copy of the **real**
services your app uses — spun up in Docker, injected as env vars, thrown away after. No shared dev DB, no
mocks, no lifecycle code in your tests.

This is the **flagship package**: it re-exports the public API (`defineConfig` and the config types) and
ships the **`baby`** CLI. For the Vitest test wedge you also install the scoped packages below.

> **Pre-alpha.** Today babystack implements exactly one engine — **real MySQL** — delivered through Vitest
> and the `baby` CLI. Other engines (**Postgres next**, then Redis, S3/MinIO, the AWS tail via LocalStack)
> are on the roadmap.

## Install

```bash
# the CLI (operator + AI-agent surface):
pnpm add -D babystack     # gives you the `baby` command

# the Vitest wedge (fresh, seeded, isolated real MySQL for your tests):
pnpm add -D @babystack/vitest     # one package — pulls the engine transitively
```

## The `baby` CLI

```bash
baby doctor     # preflight: Node, a reachable Docker engine, your config
baby wake       # provision + seed a real MySQL and leave it running
eval "$(baby home)"   # export a DATABASE_URL for the running stack
baby reset      # reload a pristine DB from the baseline (the agent's undo)
baby sleep      # dispose this project's stack
```

An AI coding agent gets a real, disposable backend for a session and can `baby reset` between attempts —
without ever touching your real dev/prod services.

## The config

```ts
// babystack.config.ts
import { defineConfig } from 'babystack' // (or '@babystack/core')

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

## Learn more

Full docs, the Vitest setup, and a runnable example app live in the repository:
<https://github.com/babystack/babystack>. Licensed **Apache-2.0**.
