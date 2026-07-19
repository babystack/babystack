import { describe, expect, it } from 'vitest'
import { BabystackError } from '../src/index'

describe('BabystackError', () => {
  it('TYPED: carries a code + name + message and is an Error/BabystackError', () => {
    const err = new BabystackError('PROVISION_FAILED', 'boom')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(BabystackError)
    expect(err.code).toBe('PROVISION_FAILED')
    expect(err.name).toBe('BabystackError')
    expect(err.message).toBe('boom')
  })

  it('CAUSE: chains an underlying cause', () => {
    const cause = new Error('root')
    const err = new BabystackError('BASELINE_BUILD_FAILED', 'wrap', { cause })
    expect(err.cause).toBe(cause)
  })
})
