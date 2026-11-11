import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, test } from 'vitest'
import { readProjectConfig, writeProjectSandboxEnv } from '../src/project-config'

const tempDirs: string[] = []

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forge-project-config-'))
  tempDirs.push(dir)
  return dir
}

function createConfigPath(): string {
  return join(createTempDir(), 'forge-projects.jsonc')
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('readProjectConfig', () => {
  test('returns an empty config for a missing file', () => {
    expect(readProjectConfig('proj', createConfigPath())).toEqual({})
  })

  test('returns an empty config for invalid JSONC', () => {
    const path = createConfigPath()
    writeFileSync(path, '{ "projects": ')
    expect(readProjectConfig('proj', path)).toEqual({})
  })

  test('returns an empty config for a missing project entry', () => {
    const path = createConfigPath()
    writeFileSync(path, '{ "projects": { "other": { "name": "other" } } }')
    expect(readProjectConfig('proj', path)).toEqual({})
  })

  test('validates the entry and drops invalid env names', () => {
    const path = createConfigPath()
    writeFileSync(
      path,
      `{
        "projects": {
          "proj": {
            "name": "demo",
            "sandbox": {
              "env": { "NODE_ENV": "test", "BAD-NAME": "drop" },
              "network": { "env": ["DATABASE_URL", "PATH"] }
            }
          }
        }
      }`,
    )
    expect(readProjectConfig('proj', path)).toEqual({
      name: 'demo',
      sandbox: { env: { NODE_ENV: 'test' }, network: { env: ['DATABASE_URL'] } },
    })
  })

  test('reads the file fresh on every call', () => {
    const path = createConfigPath()
    expect(readProjectConfig('proj', path)).toEqual({})
    writeProjectSandboxEnv('proj', { name: 'demo', env: { A: '1' }, passthrough: [] }, path)
    expect(readProjectConfig('proj', path)).toEqual({ name: 'demo', sandbox: { env: { A: '1' } } })
  })
})

describe('writeProjectSandboxEnv', () => {
  test('creates the file with the project entry', () => {
    const path = createConfigPath()
    writeProjectSandboxEnv(
      'proj',
      { name: 'demo', env: { NODE_ENV: 'test' }, passthrough: [' DATABASE_URL ', 'DATABASE_URL'] },
      path,
    )
    expect(readProjectConfig('proj', path)).toEqual({
      name: 'demo',
      sandbox: { env: { NODE_ENV: 'test' }, network: { env: ['DATABASE_URL'] } },
    })
  })

  test('preserves comments and other project entries', () => {
    const path = createConfigPath()
    writeFileSync(
      path,
      `{
  // keep me
  "projects": {
    "other": { "name": "other", "sandbox": { "env": { "OTHER": "1" } } }
  }
}`,
    )
    writeProjectSandboxEnv('proj', { name: 'demo', env: { NODE_ENV: 'test' }, passthrough: [] }, path)

    expect(readFileSync(path, 'utf-8')).toContain('// keep me')
    expect(readProjectConfig('other', path)).toEqual({ name: 'other', sandbox: { env: { OTHER: '1' } } })
    expect(readProjectConfig('proj', path)).toEqual({
      name: 'demo',
      sandbox: { env: { NODE_ENV: 'test' } },
    })
  })

  test('removes the sandbox when env and passthrough are empty while keeping the name', () => {
    const path = createConfigPath()
    writeProjectSandboxEnv('proj', { name: 'demo', env: { NODE_ENV: 'test' }, passthrough: ['A'] }, path)
    writeProjectSandboxEnv('proj', { env: {}, passthrough: [] }, path)

    expect(readProjectConfig('proj', path)).toEqual({ name: 'demo' })
    expect(readFileSync(path, 'utf-8')).not.toContain('"sandbox"')
  })

  test('keeps unknown sandbox and network keys', () => {
    const path = createConfigPath()
    writeFileSync(
      path,
      `{
  "projects": {
    "proj": {
      "sandbox": { "image": "custom", "network": { "allow": ["example.com"] } }
    }
  }
}`,
    )
    writeProjectSandboxEnv('proj', { env: { NODE_ENV: 'test' }, passthrough: ['DATABASE_URL'] }, path)

    const text = readFileSync(path, 'utf-8')
    expect(text).toContain('"image": "custom"')
    expect(text).toContain('"allow"')
    expect(readProjectConfig('proj', path)).toEqual({
      sandbox: { env: { NODE_ENV: 'test' }, network: { env: ['DATABASE_URL'] } },
    })
  })

  test('throws and leaves the file byte-identical when it is invalid JSONC', () => {
    const path = createConfigPath()
    const original = '{ "projects": '
    writeFileSync(path, original)

    expect(() =>
      writeProjectSandboxEnv('proj', { name: 'demo', env: { A: '1' }, passthrough: [] }, path),
    ).toThrow(`Cannot update ${path}: the file is not valid JSONC`)
    expect(readFileSync(path, 'utf-8')).toBe(original)
  })

  test.skipIf(process.platform === 'win32')('writes the file with mode 0600', () => {
    const path = createConfigPath()
    writeProjectSandboxEnv('proj', { name: 'demo', env: { A: '1' }, passthrough: [] }, path)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})
