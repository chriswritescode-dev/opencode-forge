import { describe, test, expect } from 'bun:test'
import { parseBash, parts, commands, source, unquote } from '../../../src/tools/bash/parse'

describe('parseBash', () => {
  test('parses single command and exposes parts', async () => {
    const root = await parseBash('ls -la /tmp')
    const cmds = commands(root)
    expect(cmds).toHaveLength(1)
    const tokens = parts(cmds[0]!).map(p => p.text)
    expect(tokens[0]).toBe('ls')
    expect(tokens).toContain('/tmp')
  })

  test('parses piped command into multiple command nodes', async () => {
    const root = await parseBash('git status | head -5')
    const cmds = commands(root)
    expect(cmds.length).toBeGreaterThanOrEqual(2)
  })

  test('source() returns trimmed full command text', async () => {
    const root = await parseBash('  git push origin main  ')
    const cmds = commands(root)
    expect(source(cmds[0]!)).toBe('git push origin main')
  })

  test('unquote strips matching surrounding quotes', () => {
    expect(unquote('"hello"')).toBe('hello')
    expect(unquote("'hello'")).toBe('hello')
    expect(unquote('hello')).toBe('hello')
    expect(unquote('"mismatched\'')).toBe('"mismatched\'')
  })
})
