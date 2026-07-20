// @ts-check
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '.turbo/**', 'examples/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Plain-JS config + bin files run under Node — give them Node/CommonJS globals.
    files: ['**/*.{js,cjs,mjs}'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        module: 'writable',
        require: 'readonly',
        exports: 'writable',
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
  },
  {
    // The public site (site/) is browser code — give it browser globals and allow the
    // idiomatic empty catch used by the anti-FOUC / localStorage guards.
    files: ['site/**/*.{js,mjs}'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        navigator: 'readonly',
        matchMedia: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        IntersectionObserver: 'readonly',
      },
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },
  {
    // Pure-core determinism + credential boundary: no direct clock/randomness and no ambient
    // process/env access in core source — use the injected Clock/CommandRunner ports and passed-in
    // config. (Adapters and tests are free to read the real clock and env.)
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: 'Pure core: inject a Clock port instead of Date.now().',
        },
        {
          selector: "NewExpression[callee.name='Date']",
          message: 'Pure core: inject a Clock port instead of new Date().',
        },
        {
          selector: "MemberExpression[object.name='Math'][property.name='random']",
          message: 'Pure core: inject a port instead of Math.random().',
        },
        {
          selector: "MemberExpression[object.name='process']",
          message:
            'Pure core: no ambient process/env access (credential boundary) — receive values via config or the injected ports.',
        },
      ],
    },
  },
)
