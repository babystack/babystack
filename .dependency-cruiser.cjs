/**
 * Architectural lint. Enforces the "pure core" seam from the handbook:
 * @babystack/core holds interfaces + pure lifecycle logic and must NOT depend on
 * engine/runtime adapters or reach for raw I/O — adapters depend on core, never the reverse.
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'core-stays-pure',
      comment:
        'packages/core must not import sibling adapters (docker/mysql/vitest/cli) — dependencies point INTO core.',
      severity: 'error',
      from: { path: '^packages/core/src' },
      to: { path: '^packages/(docker|mysql|vitest|cli|mcp)/' },
    },
    {
      name: 'core-no-node-io',
      comment:
        'packages/core is PURE — no Node I/O built-ins (fs, child_process, net, http, os, ...). Reach the ' +
        'outside world only through injected ports (Clock, CommandRunner). crypto/path/util stay allowed ' +
        '(deterministic, no I/O).',
      severity: 'error',
      from: { path: '^packages/core/src' },
      to: {
        dependencyTypes: ['core'],
        path: '^(node:)?(fs|fs/promises|child_process|net|tls|dns|http|https|http2|dgram|cluster|worker_threads|readline|repl|inspector|perf_hooks|v8|os|timers|stream|zlib|vm|events|async_hooks)(/|$)',
      },
    },
    {
      name: 'no-orphans',
      comment: 'Dead source module — not imported anywhere. Delete it or wire it up.',
      severity: 'warn',
      from: {
        orphan: true,
        // Only flag real source modules; skip package entrypoints, configs, and bin scripts.
        path: '^packages/[^/]+/src/',
        pathNot: ['\\.d\\.ts$', '(^|/)index\\.ts$'],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|node_modules)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'require'] },
  },
}
