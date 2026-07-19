import { test } from 'vitest'
import { checkIsolation } from './isolation-check'

// Worker "d": its own fresh, isolated copy of the seeded baseline (see isolation-check.ts).
test('worker d sees only the baseline seed + its own write', () => checkIsolation('d'))
