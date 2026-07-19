import { defineConfig } from '@babystack/core'

// A minimal project for the CLI integration test — one MySQL service seeded by a realistic node script.
export default defineConfig({
  services: {
    cli: {
      engine: 'mysql',
      image: 'mysql:8.4',
      // `widget-name.txt` is a watched input: the integration test creates/edits it to prove that changing a
      // seed input and re-running `baby wake` serves FRESH seed (the trust cliff), not a stale cached one.
      baseline: { build: ['node seed.mjs'], invalidateWhenChanged: ['widget-name.txt'] },
    },
  },
})
