import { defineConfig } from '@babystack/core'

// A tiny real-app backend for the walking-skeleton end-to-end: one MySQL service, seeded by a realistic
// Node script (mysql2 over the babystack-injected DATABASE_URL) — exactly how a real `pnpm db:seed` runs.
export default defineConfig({
  services: {
    db: {
      engine: 'mysql',
      image: 'mysql:8.4',
      baseline: { build: ['node seed.mjs'] },
    },
  },
})
