import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'test/constants/loop.test.ts',
      'test/deterministic-decomposer.test.ts',
      'test/hooks/audit-rotate-ordering.test.ts',
      'test/hooks/loop-decomposing-salvage.test.ts',
      'test/hooks/loop-decomposing.test.ts',
      'test/hooks/loop-section-audit-retry.test.ts',
      'test/section-capture-streaming-completion.test.ts',
      'test/section-capture.test.ts',
      'test/services/execution-decomposer.test.ts',
      'test/services/orphan-sweep.test.ts',
      'test/services/execution-restart.test.ts',
      'test/services/parse-section-summary.test.ts',
      'test/utils/worktree-cleanup.test.ts',
      'test/workspace/forge-worktree-list.test.ts',
      'test/utils/tui-client-workspaces.test.ts',
      'test/index/session-lookup.test.ts',
    ],
  },
})
