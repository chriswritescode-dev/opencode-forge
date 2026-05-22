import { describe, test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { tail, preview, writeOverflow, MAX_METADATA_LENGTH } from '../../../src/tools/bash/truncate'

describe('tail', () => {
  test('returns full text under limits with cut=false', () => {
    const t = tail('a\nb\nc', 10, 100)
    expect(t).toEqual({ text: 'a\nb\nc', cut: false })
  })
  test('cuts when over line limit (keeps tail)', () => {
    const text = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n')
    const t = tail(text, 5, 10_000)
    expect(t.cut).toBe(true)
    expect(t.text.split('\n')).toHaveLength(5)
    expect(t.text.endsWith('line19')).toBe(true)
  })
  test('cuts when over byte limit', () => {
    const text = 'x'.repeat(2000)
    const t = tail(text, 10_000, 500)
    expect(t.cut).toBe(true)
    expect(Buffer.byteLength(t.text, 'utf-8')).toBeLessThanOrEqual(500)
  })
})

describe('preview', () => {
  test('passes short text through', () => {
    expect(preview('hi')).toBe('hi')
  })
  test('truncates long text to last MAX_METADATA_LENGTH', () => {
    const text = 'x'.repeat(MAX_METADATA_LENGTH + 100)
    const p = preview(text)
    expect(p.startsWith('...')).toBe(true)
    expect(p.length).toBe(3 + 2 + MAX_METADATA_LENGTH)
  })
})

describe('writeOverflow', () => {
  test('writes file under <dataDir>/bash-output/', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-bash-out-'))
    const file = writeOverflow(dir, 'call-1', 'hello')
    expect(existsSync(file)).toBe(true)
    expect(file).toContain('bash-output')
    expect(readFileSync(file, 'utf-8')).toBe('hello')
  })
})
