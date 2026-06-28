export type FeatureStage =
  | 'pending'
  | 'planning'
  | 'planned'
  | 'launching'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface SchedulerFeature {
  featureIndex: number
  stage: FeatureStage
}

export interface SchedulerDecision {
  toPlan: number[]
  toLaunch: number[]
  groupStatus: 'planning' | 'running' | 'completed'
}

const TERMINAL_STAGES = new Set<FeatureStage>(['completed', 'failed', 'cancelled'])
const RUNNING_STAGES = new Set<FeatureStage>(['planned', 'launching', 'running'])

export function computeSchedulerActions(
  features: SchedulerFeature[],
  cap: number,
): SchedulerDecision {
  const effectiveCap = cap < 1 ? 1 : cap

  let planningInFlight = 0
  let runningInFlight = 0

  for (const f of features) {
    if (f.stage === 'planning') planningInFlight++
    else if (f.stage === 'launching' || f.stage === 'running') runningInFlight++
  }

  const pendingSlots = Math.max(0, effectiveCap - planningInFlight)
  const launchSlots = Math.max(0, effectiveCap - runningInFlight)

  const toPlan: number[] = []
  const toLaunch: number[] = []

  for (const f of features) {
    if (toPlan.length < pendingSlots && f.stage === 'pending') {
      toPlan.push(f.featureIndex)
    } else if (toLaunch.length < launchSlots && f.stage === 'planned') {
      toLaunch.push(f.featureIndex)
    }
  }

  const allTerminal = features.every(f => TERMINAL_STAGES.has(f.stage))
  if (allTerminal) {
    return { toPlan: [], toLaunch: [], groupStatus: 'completed' }
  }

  const anyRunning =
    features.some(f => RUNNING_STAGES.has(f.stage)) || toLaunch.length > 0

  return { toPlan, toLaunch, groupStatus: anyRunning ? 'running' : 'planning' }
}
