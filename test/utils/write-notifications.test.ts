import { describe, test, expect, vi } from 'vitest'
import { withWriteNotifications } from '../../src/utils/write-notifications'

interface FakeRepo {
  write(value: string): string
  remove(id: number): boolean
  read(id: number): string | null
}

function fakeRepo(): FakeRepo {
  const rows = new Map<number, string>()
  return {
    write(value: string): string {
      rows.set(rows.size + 1, value)
      return value
    },
    remove(id: number): boolean {
      return rows.delete(id)
    },
    read(id: number): string | null {
      return rows.get(id) ?? null
    },
  }
}

describe('withWriteNotifications', () => {
  test('notifies once per successful call and preserves the return value', () => {
    const repo = fakeRepo()
    const notify = vi.fn()
    const wrapped = withWriteNotifications(repo, ['write', 'remove'], notify)

    expect(wrapped.write('a')).toBe('a')
    expect(notify).toHaveBeenCalledTimes(1)
    expect(wrapped.remove(1)).toBe(true)
    expect(notify).toHaveBeenCalledTimes(2)
  })

  test('still notifies when the write reports nothing changed', () => {
    const repo = fakeRepo()
    const notify = vi.fn()
    const wrapped = withWriteNotifications(repo, ['remove'], notify)

    expect(wrapped.remove(99)).toBe(false)
    expect(notify).toHaveBeenCalledTimes(1)
  })

  test('notifies with the call arguments of the wrapped method', () => {
    const repo = fakeRepo()
    const notify = vi.fn()
    const wrapped = withWriteNotifications(repo, ['write', 'remove'], notify)

    wrapped.write('a')
    expect(notify).toHaveBeenLastCalledWith(['a'])
    wrapped.remove(1)
    expect(notify).toHaveBeenLastCalledWith([1])
  })

  test('notifies after the write completes', () => {
    let written = false
    const repo = {
      write(): boolean {
        written = true
        return true
      },
    }
    const notify = vi.fn(() => expect(written).toBe(true))
    const wrapped = withWriteNotifications(repo, ['write'], notify)

    wrapped.write()
    expect(notify).toHaveBeenCalledTimes(1)
  })

  test('does not touch unlisted methods', () => {
    const repo = fakeRepo()
    const notify = vi.fn()
    const wrapped = withWriteNotifications(repo, ['write'], notify)

    wrapped.write('a')
    expect(wrapped.read(1)).toBe('a')
    expect(notify).toHaveBeenCalledTimes(1)
  })

  test('leaves the original repo unwrapped', () => {
    const repo = fakeRepo()
    const notify = vi.fn()
    withWriteNotifications(repo, ['write'], notify)

    repo.write('a')
    expect(notify).not.toHaveBeenCalled()
  })

  test('rethrows a failing write without notifying', () => {
    const error = new Error('disk full')
    const notify = vi.fn()
    const repo: FakeRepo = { ...fakeRepo(), write: () => { throw error } }
    const wrapped = withWriteNotifications(repo, ['write'], notify)

    expect(() => wrapped.write('a')).toThrow(error)
    expect(notify).not.toHaveBeenCalled()
  })

  test('rejects a method name that is not callable', () => {
    const repo = { run: 'nope' }
    expect(() => withWriteNotifications(repo, ['run'], () => {})).toThrow(TypeError)
  })
})
