import { createPool, type Pool } from './pool'
import type { Baseline, EngineAdapter, Instance, ProvisionSpec, SeedSpec } from './types'

/** A stood-up stack: one provisioned instance, one built baseline, and a Pool over them. */
export interface Stack {
  readonly instance: Instance
  readonly baseline: Baseline
  readonly pool: Pool
  /** Release every open lease, then tear the instance down. Idempotent: a second call is a no-op. */
  dispose(): Promise<void>
}

export interface StackDeps {
  readonly adapter: EngineAdapter
}

/**
 * Stand up the full lifecycle ONCE: provision → waitReady → buildBaseline → a {@link Pool}. This is the
 * cold path (run once per test run, in Vitest `globalSetup`); the returned Pool serves cheap per-worker
 * leases on the hot path. `dispose` releases all leases and tears the instance down.
 *
 * Pure orchestration — all I/O is delegated to the injected adapter, so this composes and unit-tests
 * against a fake adapter with no Docker.
 */
export async function createStack(
  deps: StackDeps,
  spec: ProvisionSpec,
  seed: SeedSpec,
): Promise<Stack> {
  const { adapter } = deps
  const instance = await adapter.provision(spec)

  let baseline: Baseline
  try {
    await adapter.waitReady(instance)
    baseline = await adapter.buildBaseline(instance, seed)
  } catch (error) {
    // Partial init failed after the instance was provisioned. The caller never receives a Stack, so it
    // has no handle to tear it down — dispose here to avoid leaking the instance. Best-effort: a
    // secondary teardown failure must not mask the original init error.
    try {
      await adapter.dispose(instance)
    } catch {
      /* swallow — surfacing the original init failure matters more */
    }
    throw error
  }

  const pool = createPool(adapter, instance, baseline)
  let disposed = false

  return {
    instance,
    baseline,
    pool,
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      // Disposing the instance drops every database anyway, so lease cleanup is best-effort and must
      // never block instance teardown: always dispose, even if a lease failed to close.
      try {
        await pool.releaseAll()
      } finally {
        await adapter.dispose(instance)
      }
    },
  }
}
