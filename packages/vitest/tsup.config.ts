import { defineConfig } from 'tsup'

export default defineConfig({
  // Three entrypoints: the programmatic API (index) + the two Vitest hooks consumers wire up by subpath
  // (`@babystack/vitest/global-setup`, `@babystack/vitest/setup`).
  entry: ['src/index.ts', 'src/global-setup.ts', 'src/setup.ts'],
  // Build-only tsconfig with `ignoreDeprecations: '6.0'` — tsup's dts emit injects the deprecated
  // `baseUrl`, which TS 6.0 errors on. Kept off tsconfig.json so the TS 7 `typecheck:next` gate stays
  // honest (dual-compiler play, see the design decisions).
  tsconfig: './tsconfig.build.json',
  // ESM-only: `setup.ts` uses top-level await (invalid in CJS), and Vitest loads setupFiles/globalSetup
  // via the `import` condition anyway. No CJS output for this package.
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
})
