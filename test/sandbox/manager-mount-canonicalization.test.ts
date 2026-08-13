import { describe, test, expect, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { buildSandboxWorkspaces } from '../../src/sandbox/manager'
import { buildMsbCreateArgs } from '../../src/sandbox/msb'
import { createMockLogger } from '../helpers/sandbox-mocks'

describe('buildSandboxWorkspaces host-path canonicalization', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
    tempDirs.length = 0
  })

  test('canonicalizes the host side of a symlinked mount while keeping the container side as the original path', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-mount-canonical-'))
    tempDirs.push(root)
    const target = join(root, 'target')
    mkdirSync(target)
    const link = join(root, 'link')
    symlinkSync(target, link)

    const workspaces = buildSandboxWorkspaces([{ hostDir: link, containerDir: link }], createMockLogger())

    expect(workspaces).toHaveLength(1)
    expect(workspaces[0].hostDir).toBe(realpathSync(target))
    expect(workspaces[0].hostDir).not.toBe(link)
    expect(workspaces[0].containerDir).toBe(link)
  })

  test('emits the canonical host with the original container path in msb create args', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-mount-canonical-'))
    tempDirs.push(root)
    const target = join(root, 'target')
    mkdirSync(target)
    const link = join(root, 'link')
    symlinkSync(target, link)

    const [workspace] = buildSandboxWorkspaces([{ hostDir: link, containerDir: link }], createMockLogger())
    const args = buildMsbCreateArgs('forge-c', [workspace], { image: 'oc-forge-sandbox:latest' })
    const [roWorkspace] = buildSandboxWorkspaces(
      [{ hostDir: link, containerDir: link, readOnly: true }],
      createMockLogger(),
    )
    const roArgs = buildMsbCreateArgs('forge-c', [roWorkspace], { image: 'oc-forge-sandbox:latest' })

    expect(args).toContain('-v')
    expect(args).toContain(`${realpathSync(target)}:${link}`)
    expect(args).not.toContain(`${link}:${link}`)
    expect(roArgs).toContain(`${realpathSync(target)}:${link}:ro`)
  })
})
