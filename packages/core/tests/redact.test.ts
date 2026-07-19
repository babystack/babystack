import { describe, expect, it } from 'vitest'
import { redactSecrets } from '../src/index'

describe('redactSecrets', () => {
  it('redacts credentials embedded in a URL', () => {
    expect(redactSecrets('connect mysql://root:s3cr3tpw@127.0.0.1:3306/db failed')).toBe(
      'connect mysql://root:***@127.0.0.1:3306/db failed',
    )
  })

  it('redacts key=value / key: value secret shapes', () => {
    expect(redactSecrets('password=hunter2 rest')).toBe('password=*** rest')
    expect(redactSecrets('token: abc123def')).toBe('token: ***')
    expect(redactSecrets('api_key="zzz-999"')).toBe('api_key=***')
  })

  it('redacts AWS access key ids', () => {
    expect(redactSecrets('leaked AKIAIOSFODNN7EXAMPLE here')).toBe('leaked *** here')
  })

  it('redacts known literal secrets passed in', () => {
    expect(redactSecrets('the password is bs_9f3a2c1e0011', ['bs_9f3a2c1e0011'])).toBe(
      'the password is ***',
    )
  })

  it('ignores trivially short literals (which would blanket the whole message)', () => {
    expect(redactSecrets('a b a', ['a'])).toBe('a b a')
  })

  it('leaves non-secret text untouched', () => {
    expect(redactSecrets('table `users` does not exist')).toBe('table `users` does not exist')
  })
})
