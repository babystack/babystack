# @babystack/core

The **pure core** of [babystack](https://github.com/babystack/babystack) — real, fresh, seeded, disposable
backing services for tests and AI agents.

This package holds the config surface, the lifecycle orchestrator, the `EngineAdapter` seam, the
`Lease`/`Pool` types, the injected `Clock`/`CommandRunner` ports, the baseline invalidation hash, and secret
redaction. It is **pure** — no Docker SDK, no adapter, no raw I/O (enforced by a dependency/lint rule) — so
it's deterministic and safe to import anywhere.

Most users don't import this directly beyond `defineConfig`:

```ts
// babystack.config.ts
import { defineConfig } from '@babystack/core'

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

For the full picture — the Vitest wedge, the `baby` CLI, and a runnable example — see the
[babystack repository](https://github.com/babystack/babystack). Licensed **Apache-2.0**.
