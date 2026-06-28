import { describe, test, expect } from 'vitest'
import { createConfigHandler } from '../src/config'
import { buildAgents } from '../src/agents'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'

describe('createConfigHandler commands', () => {
  test('registers bundled command templates via loadPrompt', async () => {
    const configHandler = createConfigHandler(buildAgents())
    const config: Record<string, unknown> = {}

    await configHandler(config)

    const commands = config.command as Record<string, Record<string, unknown>>

    const review = commands.review
    expect(review).toBeDefined()
    expect(review.template).toContain('code reviewer')
    expect(review.agent).toBe('auditor')
    expect(review.subtask).toBe(true)

    const reviewPlan = commands['review-plan']
    expect(reviewPlan).toBeDefined()
    expect(reviewPlan.template).toContain('reviewing a completed implementation')
    expect(reviewPlan.agent).toBe('auditor')
    expect(reviewPlan.subtask).toBe(true)

    const executePlan = commands['execute-plan']
    expect(executePlan).toBeDefined()
    expect(executePlan.template).toContain('Execute the Plan')
    expect(executePlan.agent).toBe('code')
    expect(executePlan.subtask).toBe(false)

    const launchGroup = commands['launch-group']
    expect(launchGroup).toBeDefined()
    expect(launchGroup.template).toContain('launch-group')
    expect(launchGroup.template).toContain('smallest independently reviewable plan/PR')
    expect(launchGroup.template).toContain('Incidental same-file edits are not enough to group')
    expect(launchGroup.template).not.toContain('never merge or split')
    expect(launchGroup.agent).toBe('code')
    expect(launchGroup.subtask).toBe(false)

    const loopStatus = commands['loop-status']
    expect(loopStatus).toBeDefined()
    expect(loopStatus.template).toContain('Check the status')
    expect(loopStatus.agent).toBe('code')

    const loopCancel = commands['loop-cancel']
    expect(loopCancel).toBeDefined()
    expect(loopCancel.template).toContain('Identify the Loop')
    expect(loopCancel.agent).toBe('code')
  })

  test('user command template overrides via promptsDir', async () => {
    const tmpDir = '/tmp/forge-commands-test-' + Date.now()
    const commandsDir = join(tmpDir, 'commands')
    mkdirSync(commandsDir, { recursive: true })
    writeFileSync(join(commandsDir, 'review.md'), 'CUSTOM REVIEW')

    try {
      const configHandler = createConfigHandler(buildAgents(tmpDir), undefined, tmpDir)
      const config: Record<string, unknown> = {}

      await configHandler(config)

      const commands = config.command as Record<string, Record<string, unknown>>
      expect(commands.review.template).toBe('CUSTOM REVIEW')
      expect(commands['review-plan'].template).toContain('reviewing a completed implementation')
    } finally {
      if (existsSync(tmpDir)) {
        rmSync(tmpDir, { recursive: true, force: true })
      }
    }
  })
})
