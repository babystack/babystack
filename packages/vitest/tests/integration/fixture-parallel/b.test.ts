import { test } from 'vitest'
import { checkIsolation } from './isolation-check'

// Worker "b": its own fresh, isolated copy of the seeded baseline (see isolation-check.ts).
test('worker b sees only the baseline seed + its own write', () => checkIsolation('b'))
