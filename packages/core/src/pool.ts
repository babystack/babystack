import type { Baseline, EngineAdapter, Instance, Lease } from './types'

/**
 * A Pool tracks {@link Lease}s within ONE process, keyed by a stable id (`VITEST_POOL_ID`). `acquire`
 * reloads a fresh database on every call, so a caller that runs many files gets a clean slate per file
 * (the fresh-per-file isolation unit); `release` drops one key's database, `releaseAll` the rest.
 *
 * NOTE: the Vitest vehicle does NOT drive per-worker leases through this Pool — workers live in separate
 * processes and open their lease directly via the adapter ({@link EngineAdapter.openLease}), reaping it by
 * disposing the container at teardown. This Pool is the single-process seam (the forthcoming `baby` CLI /
 * agent data-plane); see the roadmap for the cross-process reconciliation.
 */
export interface Pool {
  acquire(key: string): Promise<Lease>
  release(key: string): Promise<void>
  releaseAll(): Promise<void>
}

/**
 * The default Pool: composes an {@link EngineAdapter} with a provisioned {@link Instance} and a built
 * {@link Baseline}, tracking the latest lease per key for teardown. Pure orchestration — every side
 * effect is delegated to the adapter.
 */
export function createPool(adapter: EngineAdapter, instance: Instance, baseline: Baseline): Pool {
  const open = new Map<string, Lease>()

  return {
    async acquire(key: string): Promise<Lease> {
      // Fresh per call (= fresh per test file): the adapter drops-if-exists then reloads the baseline,
      // so re-acquiring the same worker key yields a clean database. Track the latest for teardown.
      const lease = await adapter.openLease(instance, baseline, key)
      open.set(key, lease)
      return lease
    },

    async release(key: string): Promise<void> {
      const lease = open.get(key)
      if (!lease) return
      // Forget the lease only once its database is actually dropped, so a failed close stays tracked
      // (retry-safe) rather than silently leaking.
      await adapter.closeLease(lease)
      open.delete(key)
    },

    async releaseAll(): Promise<void> {
      // Close every lease; keep going if one fails (a single bad drop must not strand the rest). Only
      // forget the leases that closed; surface all failures together so none is swallowed.
      const settlements = await Promise.allSettled(
        [...open.entries()].map(async ([key, lease]) => {
          await adapter.closeLease(lease)
          return key
        }),
      )
      const failures: unknown[] = []
      for (const settlement of settlements) {
        if (settlement.status === 'fulfilled') open.delete(settlement.value)
        else failures.push(settlement.reason)
      }
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `releaseAll: ${failures.length} lease(s) failed to close`,
        )
      }
    },
  }
}
