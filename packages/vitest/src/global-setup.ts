import type { CleanupMode } from '@babystack/runtime'
import { provisionStack } from '@babystack/runtime'
import type { Stack } from '@babystack/core'
import type { ProvidedContext } from 'vitest'
import './provided'

// Vitest 4 stopped exporting `GlobalSetupContext`, so we type the slice we use structurally. The runtime
// object Vitest passes to globalSetup exposes `provide` across the whole `vitest >=2` peer range.
interface GlobalSetupContext {
  provide<K extends keyof ProvidedContext & string>(key: K, value: ProvidedContext[K]): void
}

/**
 * Tear the stack down honoring `test.cleanup`. 'keep' leaves the container up for inspection; 'destroy'
 * (the default) disposes. ('keep-on-failure' needs a run-result hook Vitest's globalSetup teardown doesn't
 * provide — it falls through to dispose for now; see the roadmap.) Exported so both branches are
 * unit-testable without a real Docker teardown.
 */
export async function teardown(stack: Stack, cleanup: CleanupMode): Promise<void> {
  if (cleanup === 'keep') {
    console.log(
      `babystack: keeping the container (test.cleanup: 'keep') — inspect it, then \`docker rm -f ${stack.instance.id}\` (or \`baby sleep\`).`,
    )
    return
  }
  await stack.dispose()
}

/**
 * Vitest `globalSetup` — runs ONCE in the main process. Provisions the seeded stack, hands its coordinates
 * to workers via `provide` (serializable — it crosses the process boundary to `setupFiles` via `inject`),
 * and returns the teardown. Wire it up with:
 *   `test: { globalSetup: ['@babystack/vitest/global-setup'], setupFiles: ['@babystack/vitest/setup'] }`
 */
export default async function babystackGlobalSetup({
  provide,
}: GlobalSetupContext): Promise<() => Promise<void>> {
  const { stack, cleanup } = await provisionStack()
  provide('babystack', { instance: stack.instance, baseline: stack.baseline })
  return () => teardown(stack, cleanup)
}
