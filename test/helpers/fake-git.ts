import { vi } from 'vitest'
import type { GitService, GitResult } from '../../src/utils/git-service'

const defaultOk: GitResult = { ok: true, status: 0, stdout: '', stderr: '' }

export function createFakeGitService(overrides?: Partial<GitService>): GitService {
  return {
    addAll: vi.fn<(a: string) => GitResult>(() => ({ ...defaultOk })),
    isPathTracked: vi.fn<(a: string, b: string) => boolean>(() => false),
    statusPorcelain: vi.fn<(a: string) => GitResult>(() => ({ ...defaultOk })),
    commit: vi.fn<(a: string, b: string) => GitResult>(() => ({ ...defaultOk })),
    isInsideWorkTree: vi.fn<(a: string) => boolean>(() => true),
    branchExists: vi.fn<(a: string, b: string) => boolean>(() => false),
    currentBranch: vi.fn<(a: string) => string | null>(() => null),
    revParseGitDir: vi.fn<(a: string) => GitResult>(() => ({ ...defaultOk })),
    revParseGitCommonDir: vi.fn<(a: string) => GitResult>(() => ({ ...defaultOk })),
    revParseGitPath: vi.fn<(a: string, b: string) => GitResult>(() => ({ ...defaultOk })),
    revParseHead: vi.fn<(a: string) => GitResult>(() => ({ ...defaultOk })),
    revParse: vi.fn<(a: string, b: string) => GitResult>(() => ({ ...defaultOk })),
    worktreeAdd: vi.fn<(a: string, b: string, c: string, d: boolean, e?: string) => GitResult>(() => ({ ...defaultOk })),
    worktreeAddDetached: vi.fn<(a: string, b: string, c: string) => GitResult>(() => ({ ...defaultOk })),
    worktreeList: vi.fn<(a: string) => GitResult>(() => ({ ...defaultOk })),
    worktreeRemove: vi.fn<(a: string, b: string) => GitResult>(() => ({ ...defaultOk })),
    worktreePrune: vi.fn<(a: string) => GitResult>(() => ({ ...defaultOk })),
    branchDelete: vi.fn<(a: string, b: string) => GitResult>(() => ({ ...defaultOk })),
    checkRefFormatBranch: vi.fn<(a: string, b: string) => GitResult>(() => ({ ...defaultOk })),
    isAncestor: vi.fn<(a: string, b: string, c: string) => boolean>(() => false),
    branchForceUpdate: vi.fn<(a: string, b: string, c: string) => GitResult>(() => ({ ...defaultOk })),
    ...overrides,
  }
}
