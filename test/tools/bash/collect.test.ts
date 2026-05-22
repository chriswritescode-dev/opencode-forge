import { describe, test, expect } from 'bun:test'
import os from 'os'
import { parseBash } from '../../../src/tools/bash/parse'
import { collect } from '../../../src/tools/bash/collect'

describe('collect', () => {
  test('rm of external path adds parent dir to scan.dirs', async () => {
    const root = await parseBash('rm /tmp/forge-test/foo.txt')
    const scan = collect(root, '/home/proj')
    expect(scan.dirs).toContain('/tmp/forge-test')
  })

  test('rm inside cwd does NOT add to scan.dirs', async () => {
    const root = await parseBash('rm src/foo.txt')
    const scan = collect(root, '/home/proj')
    expect(scan.dirs).toEqual([])
  })

  test('git push origin main adds bash pattern + arity always', async () => {
    const root = await parseBash('git push origin main')
    const scan = collect(root, '/home/proj')
    expect(scan.patterns).toContain('git push origin main')
    expect(scan.always).toContain('git push *')
  })

  test('cd alone is not added to bash patterns', async () => {
    const root = await parseBash('cd /tmp')
    const scan = collect(root, '/home/proj')
    expect(scan.patterns).toEqual([])
  })

  test('dynamic path arg ($HOME/foo) is skipped from dirs', async () => {
    const root = await parseBash('rm $HOME/foo.txt')
    const scan = collect(root, '/home/proj')
    expect(scan.dirs).toEqual([])
  })

  test('home expansion (~) maps to homedir', async () => {
    const root = await parseBash('rm ~/oops.txt')
    const scan = collect(root, '/home/proj')
    expect(scan.dirs.some(d => d.includes(os.homedir()))).toBe(true)
  })
})
