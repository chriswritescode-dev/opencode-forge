export { initializeDatabase, closeDatabase, resolveDataDir, resolveLogPath } from './database'
export { migrations } from './migrations'

export { createLoopsRepo } from './repos/loops-repo'
export type { LoopRow, LoopLargeFields, LoopsRepo } from './repos/loops-repo'

export { createPlansRepo } from './repos/plans-repo'
export type { PlanRow, PlansRepo } from './repos/plans-repo'

export { createReviewFindingsRepo } from './repos/review-findings-repo'
export type { ReviewFindingRow, ReviewFindingsRepo, WriteFindingResult } from './repos/review-findings-repo'

export { createGraphStatusRepo } from './repos/graph-status-repo'
export type { GraphStatusRow, GraphStatusRepo } from './repos/graph-status-repo'

export { createTuiPrefsRepo } from './repos/tui-prefs-repo'
export type { TuiPrefsRepo } from './repos/tui-prefs-repo'

export { createApiRegistryRepo } from './repos/api-registry-repo'
export type {
  ApiRegistryRepo,
  ApiCoordinatorRow,
  ApiProjectInstanceRow,
} from './repos/api-registry-repo'

export type {
  CompactionConfig,
} from '../types'
