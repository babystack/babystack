import type { Baseline, Instance } from '@babystack/core'

// The coordinates globalSetup hands to workers, serializable, crossing the process boundary via
// provide/inject. Ambient module augmentation — imported for its type side-effect by global-setup + setup.
declare module 'vitest' {
  interface ProvidedContext {
    babystack: { instance: Instance; baseline: Baseline }
  }
}
