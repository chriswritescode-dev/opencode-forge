import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { VERIFIED_OPENCODE_VERSION } from '../../src/constants/plugin'

function readRepoFile(file: string): string {
  return readFileSync(join(__dirname, '../..', file), 'utf-8')
}

const packageJson = JSON.parse(readRepoFile('package.json'))
const readme = readRepoFile('README.md')
const compatibility = readRepoFile('docs/compatibility.md')

describe('VERIFIED_OPENCODE_VERSION', () => {
  it('matches the @opencode/plugin and @opencode/client pins', () => {
    expect(packageJson.dependencies['@opencode/plugin']).toBe(VERIFIED_OPENCODE_VERSION)
    expect(packageJson.devDependencies['@opencode/client']).toBe(VERIFIED_OPENCODE_VERSION)
  })

  it('is the version the README claims Forge was verified on', () => {
    expect(readme).toContain(`verified on OpenCode ${VERIFIED_OPENCODE_VERSION}`)
  })

  it('leaves engines.opencode a floor range instead of an exact pin', () => {
    expect(packageJson.engines.opencode).toMatch(/^>=/)
  })

  it('is the version docs/compatibility.md records evidence for', () => {
    expect(compatibility).toContain(VERIFIED_OPENCODE_VERSION)
  })
})
