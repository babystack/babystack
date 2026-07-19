import type { Stack } from '@babystack/core'
import { describe, expect, it, vi } from 'vitest'
import { teardown } from '../src/global-setup'

// Docker-free unit test for the teardown decision. The full provision→dispose loop is proven by the
// integration suite; here we pin the `test.cleanup` branching (a regression that disposed a `keep` container
// — or skipped disposing a `destroy` one — would otherwise ship green).

function fakeStack(onDispose: () => void): Stack {
  return {
    instance: { id: 'c1', service: 'db', engine: 'mysql', host: '127.0.0.1', port: 3306 },
    dispose: async () => onDispose(),
  } as unknown as Stack
}

describe('globalSetup teardown', () => {
  it("disposes the container by default (cleanup 'destroy')", async () => {
    let disposed = 0
    await teardown(
      fakeStack(() => {
        disposed++
      }),
      'destroy',
    )
    expect(disposed).toBe(1)
  })

  it("keeps the container up (no dispose) when cleanup is 'keep', and logs how to remove it", async () => {
    let disposed = 0
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await teardown(
      fakeStack(() => {
        disposed++
      }),
      'keep',
    )
    expect(disposed).toBe(0) // NOT torn down
    expect(log).toHaveBeenCalledOnce()
    expect(log.mock.calls[0]?.[0]).toContain('baby sleep')
    log.mockRestore()
  })
})
