// Shim for bun:test that re-exports vitest APIs.
// Used when running bun:test files under vitest via the vitest alias.
// Note: vi.mock() needs globals to resolve properly — see vitest.config.ts.
import { describe, it, test, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'

// bun:test's `mock()` is equivalent to vitest's `vi.fn()`.
const mock = vi.fn

export {
  describe,
  it,
  test,
  expect,
  vi,
  mock,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
}
