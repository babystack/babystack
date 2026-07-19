import { defineConfig } from '@babystack/vitest'

// Describe the backend ONCE. babystack provisions this real MySQL, runs your migrate + seed to build a
// seeded baseline, and hands every test worker its own fresh copy — over a normal DATABASE_URL.
export default defineConfig({
  services: {
    db: {
      engine: 'mysql',
      image: 'mysql:8.4',
      // Your own commands — babystack runs them against a throwaway build DB (injected DATABASE_URL),
      // then mysqldumps the result into the reusable baseline. It never edits your migrations/seeds.
      baseline: { build: ['pnpm db:migrate', 'pnpm db:seed'] },
    },
  },
})
