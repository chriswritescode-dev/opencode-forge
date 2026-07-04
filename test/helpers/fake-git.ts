import { vi } from 'vitest'
import type { GitService, GitResult } from '../../src/utils/git-service'

const defaultOk: GitResult = { ok: true, status: 0, stdout: '', stderr: '' }

export function createFakeGitService(overrides?: Partial<GitService>): GitService {
  return {
    addAll: vi.fn<[string], GitResult>(() => ({ ...defaultOk })),
    isPathTracked: vi.fn<[string, string], boolean>(() => false),
    statusPorcelain: vi.fn<[string], GitResult>(() => ({ ...defaultOk })),
    commit: vi.fn<[string, string], GitResult>(() => ({ ...defaultOk })),
    isInsideWorkTree: vi.fn<[string], boolean>(() => true),
    branchExists: vi.fn<[string, string], boolean>(() => false),
    currentBranch: vi.fn<[string], string | null>(() => null),
    revParseGitDir: vi.fn<[string], GitResult>(() => ({ ...defaultOk })),
    revParseGitCommonDir: vi.fn<[string], GitResult>(() => ({ ...defaultOk })),
    revParseGitPath: vi.fn<[string, string], GitResult>(() => ({ ...defaultOk })),
    revParseHead: vi.fn<[string], GitResult>(() => ({ ...defaultOk })),
    commitExists: vi.fn<[string, string], boolean>(() => false),
    push: vi.fn<[string, string, string, boolean], GitResult>(() => ({ ...defaultOk })),
    fetchRef: vi.fn<[string, string, string], GitResult>(() => ({ ...defaultOk })),
    worktreeAdd: vi.fn<[string, string, string, boolean, string?], GitResult>(() => ({ ...defaultOk })),
    worktreeRemove: vi.fn<[string, string], GitResult>(() => ({ ...defaultOk })),
    worktreePrune: vi.fn<[string], GitResult>(() => ({ ...defaultOk })),
    ...overrides,
  }
}
