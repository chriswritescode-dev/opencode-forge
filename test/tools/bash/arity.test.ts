import { describe, test, expect } from 'bun:test'
import { prefix } from '../../../src/tools/bash/arity'

describe('BashArity.prefix', () => {
  test('git push origin main -> [git, push]', () => {
    expect(prefix(['git', 'push', 'origin', 'main'])).toEqual(['git', 'push'])
  })
  test('npm run dev -> [npm, run, dev] (arity 3)', () => {
    expect(prefix(['npm', 'run', 'dev'])).toEqual(['npm', 'run', 'dev'])
  })
  test('npm install foo -> [npm, install] (arity 2)', () => {
    expect(prefix(['npm', 'install', 'foo'])).toEqual(['npm', 'install'])
  })
  test('unknown -> first token only', () => {
    expect(prefix(['mycli', 'do', 'stuff'])).toEqual(['mycli'])
  })
  test('docker compose up -> arity 3', () => {
    expect(prefix(['docker', 'compose', 'up', '-d'])).toEqual(['docker', 'compose', 'up'])
  })
  test('empty -> []', () => {
    expect(prefix([])).toEqual([])
  })
})
