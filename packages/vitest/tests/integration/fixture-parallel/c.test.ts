import { test } from 'vitest'
import { checkIsolation } from './isolation-check'

// Worker "c": its own fresh, isolated copy of the seeded baseline (see isolation-check.ts).
test('worker c sees only the baseline seed + its own write', () => checkIsolation('c'))
