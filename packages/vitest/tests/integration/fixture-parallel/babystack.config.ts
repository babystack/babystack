import { defineConfig } from '@babystack/core'

// A backend for the parallelism proof: one MySQL service whose baseline seeds a single `items` table with
// one known row. Four test files then run in parallel workers, each in its own leased copy of this baseline.
export default defineConfig({
  services: {
    parallel: {
      engine: 'mysql',
      image: 'mysql:8.4',
      baseline: { build: ['node seed.mjs'] },
    },
  },
})
