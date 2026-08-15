import { describe, test, expect, vi } from 'vitest'
import { executeSandboxGlob, executeSandboxGrep } from '../../src/sandbox/exec-fs'
import type { SandboxRuntime } from '../../src/sandbox/msb'

function recordingRuntime() {
  const commands: string[] = []
  const runtime = {
    exec: vi.fn(async (_name: string, command: string) => {
      commands.push(command)
      return { stdout: '', stderr: '', exitCode: 0 }
    }),
  } as unknown as SandboxRuntime
  return { runtime, commands }
}

describe('sandbox exec-fs', () => {
  test('escapes a single quote in the search path of executeSandboxGlob', async () => {
    const { runtime, commands } = recordingRuntime()
    await executeSandboxGlob(
      { runtime, containerName: 'forge-c', hostDir: '/host' },
      '*.ts',
      "/it's",
    )
    expect(commands[0]).toContain("'/it'\\''s' 2>/dev/null")
  })

  test('escapes a single quote in the search path of executeSandboxGrep', async () => {
    const { runtime, commands } = recordingRuntime()
    await executeSandboxGrep(
      { runtime, containerName: 'forge-c', hostDir: '/host' },
      'foo',
      { path: "/it's" },
    )
    expect(commands[0]).toContain("'/it'\\''s' 2>/dev/null")
  })
})
