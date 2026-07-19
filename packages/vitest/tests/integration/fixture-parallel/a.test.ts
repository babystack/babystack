import { test } from 'vitest'
import { checkIsolation } from './isolation-check'

// Worker "a": its own fresh, isolated copy of the seeded baseline (see isolation-check.ts).
test('worker a sees only the baseline seed + its own write', () => checkIsolation('a'))
