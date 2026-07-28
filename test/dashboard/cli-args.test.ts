import { describe, test, expect } from 'vitest'
import { parseDashboardCliArgs } from '../../src/dashboard/cli-args'

describe('parseDashboardCliArgs', () => {
  test('no flags returns empty object', () => {
    expect(parseDashboardCliArgs(['bun', 'scripts/dashboard.ts'])).toEqual({})
  })

  test('--host with space-separated value', () => {
    expect(parseDashboardCliArgs(['bun', 's', '--host', '0.0.0.0'])).toEqual({
      host: '0.0.0.0',
    })
  })

  test('--host=value form', () => {
    expect(parseDashboardCliArgs(['bun', 's', '--host=0.0.0.0'])).toEqual({
      host: '0.0.0.0',
    })
  })

  test('--port accepts space and equals forms', () => {
    expect(parseDashboardCliArgs(['bun', 's', '--port', '5000'])).toEqual({ port: 5000 })
    expect(parseDashboardCliArgs(['bun', 's', '--port=5000'])).toEqual({ port: 5000 })
  })

  test('--db accepts space and equals forms', () => {
    expect(parseDashboardCliArgs(['bun', 's', '--db', '/tmp/x.db'])).toEqual({
      dbPath: '/tmp/x.db',
    })
    expect(parseDashboardCliArgs(['bun', 's', '--db=/tmp/x.db'])).toEqual({
      dbPath: '/tmp/x.db',
    })
  })

  test('all three flags combined', () => {
    expect(
      parseDashboardCliArgs(['bun', 's', '--host', '0.0.0.0', '--port', '5000', '--db', '/tmp/x.db']),
    ).toEqual({ host: '0.0.0.0', port: 5000, dbPath: '/tmp/x.db' })
  })

  test('unknown flags are ignored', () => {
    expect(parseDashboardCliArgs(['bun', 's', '--nope', '--host', '0.0.0.0'])).toEqual({
      host: '0.0.0.0',
    })
  })

  test('dangling flag with no value is ignored', () => {
    expect(parseDashboardCliArgs(['bun', 's', '--host'])).toEqual({})
  })

  test('non-numeric port yields NaN', () => {
    const result = parseDashboardCliArgs(['bun', 's', '--port', 'abc'])
    expect(Number.isNaN(result.port)).toBe(true)
  })

  test('--port=0 is preserved (not dropped by a falsy check)', () => {
    expect(parseDashboardCliArgs(['bun', 's', '--port=0'])).toEqual({ port: 0 })
  })

  test('empty values from equals form are preserved', () => {
    expect(parseDashboardCliArgs(['bun', 's', '--db='])).toEqual({ dbPath: '' })
    expect(parseDashboardCliArgs(['bun', 's', '--host='])).toEqual({ host: '' })
  })

  test('last occurrence wins', () => {
    expect(parseDashboardCliArgs(['bun', 's', '--port', '1', '--port', '2'])).toEqual({
      port: 2,
    })
  })
})
