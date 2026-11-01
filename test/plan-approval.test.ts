import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'

import { createToolExecuteBeforeHook, createToolExecuteAfterHook, createPlanApprovalEventHook } from '../src/hooks/plan-approval'
import type { LoopState } from '../src/loop/state'
import type { ToolContext } from '../src/tools/types'
import { createFakeForgeClient } from './helpers/fake-client'
import { buildLoopRuntime, makeLoopState } from './helpers/loop-fixtures'
import { createMockLogger } from './helpers/logger'
import { createTestDb, type TestDb } from './helpers/test-db'
import { buildToolContext, planApprovalQuestionArgs } from './helpers/tool-context'

const TEST_PROJECT = 'test-project'
const TEST_DIRECTORY = '/test'

describe('Plan approval hooks', () => {
  let testDb: TestDb
  let runtime: ReturnType<typeof buildLoopRuntime>

  beforeEach(() => {
    testDb = createTestDb()
    runtime = buildLoopRuntime(testDb.db, { projectId: TEST_PROJECT })
  })

  afterEach(() => {
    testDb.cleanup()
  })

  function createContext(overrides: Omit<Partial<ToolContext>, 'db'> = {}): ToolContext {
    return buildToolContext({
      db: testDb.db,
      projectId: TEST_PROJECT,
      directory: TEST_DIRECTORY,
      loop: runtime.loop,
      ...overrides,
    })
  }

  describe('answers', () => {
    test('New session matches metadata prefixes and output fallbacks, aborts the source and preserves the plan', async () => {
      let resolvePrompt!: () => void
      const pendingPrompt = new Promise<void>((resolve) => {
        resolvePrompt = resolve
      })
      const abortSpy = vi.fn(async () => {})
      const { client, calls } = createFakeForgeClient({
        session: {
          abort: abortSpy,
          promptAsync: () => pendingPrompt,
          create: async () => ({ id: 'new-session-id' }),
        },
      })
      const prefixSessionID = 'new-session-prefix'
      const fallbackSessionID = 'new-session-fallback'
      const prefixPlan = '# Prefix Plan\n\nFirst body.'
      const fallbackPlan = '# Fallback Plan\n\nSecond body.'
      runtime.plansRepo.writeForSession(TEST_PROJECT, prefixSessionID, prefixPlan)
      runtime.plansRepo.writeForSession(TEST_PROJECT, fallbackSessionID, fallbackPlan)
      const hook = createToolExecuteAfterHook(createContext({ client }))
      const args = planApprovalQuestionArgs()

      const prefixOutput = {
        title: 'Asked 1 question',
        output: 'User has answered your questions: ...',
        metadata: { answers: [['New session (Recommended)']] },
      }
      await Promise.race([
        hook({ tool: 'question', sessionID: prefixSessionID, callID: 'new-prefix', args }, prefixOutput),
        new Promise((_, reject) => setTimeout(() => reject(new Error('hook waited for the dispatch')), 50)),
      ])

      expect(prefixOutput.output).toBe('User has answered your questions: ...')
      expect(prefixOutput.metadata).toMatchObject({ forgePlanApprovalHandled: true })
      expect(abortSpy).toHaveBeenCalledWith({ sessionID: prefixSessionID, directory: TEST_DIRECTORY })
      await vi.waitFor(() => {
        expect(calls.filter((call) => call.method === 'session.create')).toHaveLength(1)
      })

      resolvePrompt()

      const fallbackOutput = { title: '', output: 'New session', metadata: {} }
      await expect(
        hook({ tool: 'question', sessionID: fallbackSessionID, callID: 'new-fallback', args }, fallbackOutput),
      ).resolves.toBeUndefined()

      expect(fallbackOutput.output).toBe('New session')
      expect(fallbackOutput.metadata).toMatchObject({ forgePlanApprovalHandled: true })
      expect(abortSpy).toHaveBeenCalledWith({ sessionID: fallbackSessionID, directory: TEST_DIRECTORY })
      await vi.waitFor(() => {
        expect(calls.filter((call) => call.method === 'session.create')).toHaveLength(2)
      })

      expect(runtime.plansRepo.getForSession(TEST_PROJECT, prefixSessionID)?.content).toBe(prefixPlan)
      expect(runtime.plansRepo.getForSession(TEST_PROJECT, fallbackSessionID)?.content).toBe(fallbackPlan)
    })

    test('Execute here aborts the source, preserves the plan and does not dispatch', async () => {
      const abortSpy = vi.fn(async () => {})
      const { client, calls } = createFakeForgeClient({ session: { abort: abortSpy } })
      const executeSessionID = 'execute-here-session'
      const plan = '# Execute Here Plan\n\nBody.'
      runtime.plansRepo.writeForSession(TEST_PROJECT, executeSessionID, plan)
      const hook = createToolExecuteAfterHook(createContext({ client }))
      const output = {
        title: 'Asked 1 question',
        output: 'Execute here',
        metadata: { answers: [['Execute here']] },
      }

      await expect(
        hook({ tool: 'question', sessionID: executeSessionID, callID: 'execute-here', args: planApprovalQuestionArgs() }, output),
      ).resolves.toBeUndefined()

      expect(output.output).toBe('Execute here')
      expect(output.metadata).toMatchObject({ forgePlanApprovalHandled: true })
      expect(abortSpy).toHaveBeenCalledWith({ sessionID: executeSessionID, directory: TEST_DIRECTORY })
      expect(calls.some((call) => call.method === 'session.create')).toBe(false)
      expect(runtime.plansRepo.getForSession(TEST_PROJECT, executeSessionID)?.content).toBe(plan)
    })

    test('Loop approval defers to the loop tool without aborting or dispatching', async () => {
      const abortSpy = vi.fn(async () => {})
      const createSpy = vi.fn(async () => ({ id: 'should-not-exist' }))
      const promptAsync = vi.fn(async (_params: { sessionID: string }) => new Promise<void>(() => {}))
      const { client, calls } = createFakeForgeClient({
        session: { abort: abortSpy, create: createSpy, promptAsync },
      })
      const loopSessionID = 'loop-approval-session'
      const plan = '# Loop Plan\n\nBody.'
      runtime.plansRepo.writeForSession(TEST_PROJECT, loopSessionID, plan)
      const hook = createToolExecuteAfterHook(createContext({ client }))
      const output = {
        title: 'Asked 1 question',
        output: 'Loop',
        metadata: { answers: [['Loop']] },
      }

      const executionModule = await import('../src/services/execution')
      const createServiceSpy = vi.spyOn(executionModule, 'createForgeExecutionService')
      try {
        await Promise.race([
          hook({ tool: 'question', sessionID: loopSessionID, callID: 'loop-call', args: planApprovalQuestionArgs() }, output),
          new Promise((_, reject) => setTimeout(() => reject(new Error('hook did not resolve before promptAsync')), 50)),
        ])
        expect(createServiceSpy).not.toHaveBeenCalled()
      } finally {
        createServiceSpy.mockRestore()
      }

      expect(abortSpy).not.toHaveBeenCalled()
      expect(promptAsync).not.toHaveBeenCalled()
      expect(createSpy).not.toHaveBeenCalled()
      expect(calls.some((call) => call.method === 'session.create')).toBe(false)
      expect(output.metadata).toMatchObject({ forgePlanApprovalHandled: true })
      expect(output.output).toContain('<system-reminder>')
      expect(output.output).toContain('execute-plan')
      expect(output.output).not.toContain('memory-loop')
      expect(runtime.plansRepo.getForSession(TEST_PROJECT, loopSessionID)?.content).toBe(plan)
    })

    test('Loop (worktree) answer is handled like Loop without toasts or dispatch', async () => {
      const abortSpy = vi.fn(async () => {})
      const createSpy = vi.fn(async () => ({ id: 'should-not-exist' }))
      const promptAsync = vi.fn(async (_params: { sessionID: string }) => new Promise<void>(() => {}))
      const { client, calls } = createFakeForgeClient({
        session: { abort: abortSpy, create: createSpy, promptAsync },
      })
      const worktreeSessionID = 'loop-worktree-approval-session'
      const plan = '# Loop Worktree Plan\n\nBody.'
      runtime.plansRepo.writeForSession(TEST_PROJECT, worktreeSessionID, plan)
      const hook = createToolExecuteAfterHook(createContext({ client }))
      const output = {
        title: 'Asked 1 question',
        output: 'Loop (worktree)',
        metadata: { answers: [['Loop (worktree)']] },
      }

      await hook(
        { tool: 'question', sessionID: worktreeSessionID, callID: 'loop-worktree-call', args: planApprovalQuestionArgs() },
        output,
      )

      expect(abortSpy).not.toHaveBeenCalled()
      expect(promptAsync).not.toHaveBeenCalled()
      expect(createSpy).not.toHaveBeenCalled()
      expect(calls.some((call) => call.method === 'toast')).toBe(false)
      expect(calls.some((call) => call.method === 'session.create')).toBe(false)
      expect(output.metadata).toMatchObject({ forgePlanApprovalHandled: true })
      expect(output.output).toContain('<system-reminder>')
      expect(output.output).toContain('execute-plan')
      expect(runtime.plansRepo.getForSession(TEST_PROJECT, worktreeSessionID)?.content).toBe(plan)
    })

    test('custom answers append the custom-response system reminder', async () => {
      const abortSpy = vi.fn(async () => {})
      const { client } = createFakeForgeClient({ session: { abort: abortSpy } })
      const customSessionID = 'custom-answer-session'
      runtime.plansRepo.writeForSession(TEST_PROJECT, customSessionID, '# Custom Plan\n\nBody.')
      const hook = createToolExecuteAfterHook(createContext({ client }))
      const output = { title: '', output: 'Custom answer', metadata: {} }

      await hook({ tool: 'question', sessionID: customSessionID, callID: 'custom-answer', args: planApprovalQuestionArgs() }, output)

      expect(output.output).toContain('Custom answer')
      expect(output.output).toContain('<system-reminder>')
      expect(output.output).toContain('custom response')
      expect(output.output).toContain('respond accordingly')
      expect(output.metadata).not.toMatchObject({ forgePlanApprovalHandled: true })
      expect(abortSpy).not.toHaveBeenCalled()
    })

    test('does not match a label in the middle of the answer', async () => {
      const abortSpy = vi.fn(async () => {})
      const { client } = createFakeForgeClient({ session: { abort: abortSpy } })
      const sessionID = 'middle-of-string-session'
      runtime.plansRepo.writeForSession(TEST_PROJECT, sessionID, '# Middle Plan\n\nBody.')
      const hook = createToolExecuteAfterHook(createContext({ client }))
      const output = {
        title: 'Asked 1 question',
        output: 'User has answered your questions: ...',
        metadata: { answers: [['Please use New session']] },
      }

      await hook({ tool: 'question', sessionID, callID: 'middle-of-string', args: planApprovalQuestionArgs() }, output)

      expect(output.output).toContain('<system-reminder>')
      expect(abortSpy).not.toHaveBeenCalled()
    })

    test('leaves non-approval questions unchanged', async () => {
      const hook = createToolExecuteAfterHook(createContext())
      const output = { title: '', output: 'Option A', metadata: {} }
      const args = {
        questions: [
          {
            question: 'What is your preference?',
            options: [
              { label: 'Option A', description: 'First option' },
              { label: 'Option B', description: 'Second option' },
            ],
          },
        ],
      }

      await hook({ tool: 'question', sessionID: 'non-approval-session', callID: 'non-approval', args }, output)

      expect(output.output).toBe('Option A')
      expect(output.output).not.toContain('<system-reminder>')
    })

    test('leaves non-question tools unchanged', async () => {
      const hook = createToolExecuteAfterHook(createContext())
      const output = { title: '', output: 'Some result', metadata: {} }

      await hook({ tool: 'plan-read', sessionID: 'plan-read-session', callID: 'plan-read', args: {} }, output)

      expect(output).toEqual({ title: '', output: 'Some result', metadata: {} })
    })

    test('does not treat a pre-plan approval question as execution approval', async () => {
      const hook = createToolExecuteAfterHook(createContext())
      const output = { title: '', output: 'Yes', metadata: {} }
      const args = {
        questions: [
          {
            question: 'Should I write the implementation plan?',
            options: [
              { label: 'Yes', description: 'Write the plan' },
              { label: 'No', description: 'Not yet' },
            ],
          },
        ],
      }

      await hook({ tool: 'question', sessionID: 'pre-plan-session', callID: 'pre-plan', args }, output)

      expect(output.output).toBe('Yes')
      expect(output.output).not.toContain('<system-reminder>')
      expect(output.output).not.toContain('Switching to code agent')
    })
  })

  describe('session.idle', () => {
    test('prompts the pending Execute here session once and ignores other sessions', async () => {
      const promptSpy = vi.fn(async (_params: { sessionID: string; agent: string; parts: Array<{ text: string }> }) => {})
      const { client } = createFakeForgeClient({ session: { promptAsync: promptSpy } })
      const idleSessionID = 'execute-here-idle'
      runtime.plansRepo.writeForSession(TEST_PROJECT, idleSessionID, '# Idle Plan\n\nBody.')
      const ctx = createContext({ client })
      const afterHook = createToolExecuteAfterHook(ctx)
      const eventHook = createPlanApprovalEventHook(ctx)
      const output = {
        title: 'Asked 1 question',
        output: 'Execute here',
        metadata: { answers: [['Execute here']] },
      }

      await afterHook(
        { tool: 'question', sessionID: idleSessionID, callID: 'idle-call', args: planApprovalQuestionArgs() },
        output,
      )

      await eventHook({
        event: {
          type: 'session.status',
          properties: { sessionID: 'non-pending-session', status: { type: 'idle' } },
        },
      })
      expect(promptSpy).not.toHaveBeenCalled()

      await eventHook({
        event: {
          type: 'session.status',
          properties: { sessionID: idleSessionID, status: { type: 'idle' } },
        },
      })

      expect(promptSpy).toHaveBeenCalledTimes(1)
      const callArgs = promptSpy.mock.calls[0][0]
      expect(callArgs.sessionID).toBe(idleSessionID)
      expect(callArgs.agent).toBe('code')
      expect(callArgs.parts[0].text).toContain('The architect agent has created an implementation plan')

      await eventHook({
        event: {
          type: 'session.status',
          properties: { sessionID: idleSessionID, status: { type: 'idle' } },
        },
      })
      expect(promptSpy).toHaveBeenCalledTimes(1)
    })
  })

  describe('dispatch dedupe', () => {
    test('duplicate New session approval with the same callID dispatches once', async () => {
      const abortSpy = vi.fn(async () => {})
      const createSpy = vi.fn(async () => ({ id: 'new-session-id' }))
      const { client } = createFakeForgeClient({ session: { abort: abortSpy, create: createSpy } })
      const sessionID = 'duplicate-same-call'
      runtime.plansRepo.writeForSession(TEST_PROJECT, sessionID, '# Duplicate Plan\n\nBody.')
      const hook = createToolExecuteAfterHook(createContext({ client }))
      const args = planApprovalQuestionArgs()
      const output = {
        title: 'Asked 1 question',
        output: 'New session',
        metadata: { answers: [['New session']] },
      }

      await expect(hook({ tool: 'question', sessionID, callID: 'same-call', args }, output)).resolves.toBeUndefined()

      const duplicateOutput = {
        title: 'Asked 1 question',
        output: 'New session',
        metadata: { answers: [['New session']] },
      }
      await expect(hook({ tool: 'question', sessionID, callID: 'same-call', args }, duplicateOutput)).resolves.toBeUndefined()

      await vi.waitFor(() => {
        expect(createSpy).toHaveBeenCalledTimes(1)
        expect(abortSpy).toHaveBeenCalledTimes(2)
      })
      expect(duplicateOutput.output).toBe('New session')
      expect(duplicateOutput.metadata).toMatchObject({ forgePlanApprovalDuplicate: true })
    })

    test('duplicate New session approval with a different callID dispatches once', async () => {
      const abortSpy = vi.fn(async () => {})
      const createSpy = vi.fn(async () => ({ id: 'new-session-id' }))
      const { client } = createFakeForgeClient({ session: { abort: abortSpy, create: createSpy } })
      const sessionID = 'duplicate-different-call'
      runtime.plansRepo.writeForSession(TEST_PROJECT, sessionID, '# Duplicate Plan\n\nBody.')
      const hook = createToolExecuteAfterHook(createContext({ client }))
      const args = planApprovalQuestionArgs()

      const firstOutput = {
        title: 'Asked 1 question',
        output: 'New session',
        metadata: { answers: [['New session']] },
      }
      const firstHook = hook({ tool: 'question', sessionID, callID: 'first-call', args }, firstOutput)

      const duplicateOutput = {
        title: 'Asked 1 question',
        output: 'New session',
        metadata: { answers: [['New session']] },
      }
      const duplicateHook = hook({ tool: 'question', sessionID, callID: 'second-call', args }, duplicateOutput)

      await expect(duplicateHook).resolves.toBeUndefined()
      await expect(firstHook).resolves.toBeUndefined()

      await vi.waitFor(() => {
        expect(createSpy).toHaveBeenCalledTimes(1)
        expect(abortSpy).toHaveBeenCalledTimes(2)
      })
      expect(duplicateOutput.metadata).toMatchObject({ forgePlanApprovalDuplicate: true })

      const laterDuplicateOutput = {
        title: 'Asked 1 question',
        output: 'New session',
        metadata: { answers: [['New session']] },
      }
      await expect(
        hook({ tool: 'question', sessionID, callID: 'third-call', args }, laterDuplicateOutput),
      ).resolves.toBeUndefined()

      await vi.waitFor(() => {
        expect(createSpy).toHaveBeenCalledTimes(1)
        expect(abortSpy).toHaveBeenCalledTimes(3)
      })
      expect(laterDuplicateOutput.metadata).toMatchObject({ forgePlanApprovalDuplicate: true })
    })
  })

  describe('source abort', () => {
    test('dispatch survives a slow source-session abort', async () => {
      let resolveAbort!: () => void
      const abortSpy = vi.fn(() => new Promise<void>((resolve) => {
        resolveAbort = resolve
      }))
      const { client } = createFakeForgeClient({ session: { abort: abortSpy } })
      const sessionID = 'slow-abort-session'
      runtime.plansRepo.writeForSession(TEST_PROJECT, sessionID, '# Slow Plan\n\nBody.')
      const hook = createToolExecuteAfterHook(createContext({ client }))
      const output = {
        title: '',
        output: 'New session',
        metadata: { answers: [['New session']] },
      }

      const hookPromise = hook({ tool: 'question', sessionID, callID: 'slow-abort', args: planApprovalQuestionArgs() }, output)

      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(resolveAbort).toBeDefined()
      resolveAbort()

      await expect(hookPromise).resolves.toBeUndefined()
    })

    test('logs an error when session.abort rejects', async () => {
      const abortError = new Error('Unable to connect')
      const logger = createMockLogger()
      const { client } = createFakeForgeClient({
        session: {
          abort: vi.fn(async () => {
            throw abortError
          }),
        },
      })
      const sessionID = 'abort-error-session'
      runtime.plansRepo.writeForSession(TEST_PROJECT, sessionID, '# Error Plan')
      const hook = createToolExecuteAfterHook(createContext({ client, logger }))
      const output = {
        title: 'Asked 1 question',
        output: 'Execute here',
        metadata: { answers: [['Execute here']] },
      }

      await expect(
        hook({ tool: 'question', sessionID, callID: 'abort-error', args: planApprovalQuestionArgs() }, output),
      ).resolves.toBeUndefined()

      expect(logger.error).toHaveBeenCalledWith('Plan approval: session.abort threw', abortError)
    })
  })

  describe('tool blocking', () => {
    const outsideSessionID = 'outside-session'
    const loopSessionID = 'loop-session'
    const loopName = 'active-loop'

    function createContextForLoopState(state: Partial<LoopState> | null): ToolContext {
      if (state) {
        const fullState = makeLoopState({ loopName, ...state })
        runtime.loopService.setState(loopName, fullState)
        runtime.loopService.registerLoopSession(fullState.sessionId, loopName)
      }
      return createContext()
    }

    test('does not block question when resolved loop belongs to another session', async () => {
      const hook = createToolExecuteBeforeHook(
        createContextForLoopState({ active: true, sessionId: loopSessionID, phase: 'auditing' }),
      )

      await expect(
        hook({ tool: 'question', sessionID: outsideSessionID, callID: 'call-1' }, { args: {} }),
      ).resolves.toBeUndefined()
    })

    test('blocks question for active loop session', async () => {
      const hook = createToolExecuteBeforeHook(
        createContextForLoopState({ active: true, sessionId: loopSessionID, phase: 'coding' }),
      )

      await expect(
        hook({ tool: 'question', sessionID: loopSessionID, callID: 'call-1' }, { args: {} }),
      ).rejects.toThrow('question tool is not available')
    })

    test('blocks question for active audit session', async () => {
      const hook = createToolExecuteBeforeHook(
        createContextForLoopState({ active: true, sessionId: loopSessionID, phase: 'auditing' }),
      )

      await expect(
        hook({ tool: 'question', sessionID: loopSessionID, callID: 'call-1' }, { args: {} }),
      ).rejects.toThrow('question tool is not available')
    })

    test('blocks question for child sessions resolved into an active loop', async () => {
      const hook = createToolExecuteBeforeHook(createContextForLoopState(null), {
        resolveActiveLoopForSession: async (sessionID) =>
          sessionID === 'child-session'
            ? { active: true, loopName, phase: 'auditing' }
            : null,
      })

      await expect(
        hook({ tool: 'question', sessionID: 'child-session', callID: 'call-1' }, { args: {} }),
      ).rejects.toThrow('question tool is not available')
    })

    test('rewrites blocked question output for child sessions resolved into an active loop', async () => {
      const hook = createToolExecuteAfterHook(createContextForLoopState(null), {
        resolveActiveLoopForSession: async (sessionID) =>
          sessionID === 'child-session'
            ? { active: true, loopName, phase: 'auditing' }
            : null,
      })
      const output = { title: '', output: 'original output', metadata: {} }

      await hook({ tool: 'question', sessionID: 'child-session', callID: 'call-1', args: {} }, output)

      expect(output.title).toBe('Tool blocked')
      expect(output.output).toContain('question tool is not available')
    })

    test('does not rewrite after-hook output when resolved loop belongs to another session', async () => {
      const hook = createToolExecuteAfterHook(
        createContextForLoopState({ active: true, sessionId: loopSessionID, phase: 'auditing' }),
      )
      const output = { title: '', output: 'original output', metadata: {} }

      await hook({ tool: 'execute-plan', sessionID: outsideSessionID, callID: 'call-1', args: {} }, output)

      expect(output.title).toBe('')
      expect(output.output).toBe('original output')
    })

    test('blocks execute-plan in the after hook when the loop is active', async () => {
      const hook = createToolExecuteAfterHook(
        createContextForLoopState({ active: true, sessionId: loopSessionID, phase: 'auditing' }),
      )
      const output = { title: '', output: 'original output', metadata: {} }

      await hook({ tool: 'execute-plan', sessionID: loopSessionID, callID: 'call-1', args: {} }, output)

      expect(output.title).toBe('Tool blocked')
      expect(output.output).toContain('execute-plan tool is not available')
    })

    test('leaves non-blocked tools untouched in the after hook when the loop is active', async () => {
      const hook = createToolExecuteAfterHook(
        createContextForLoopState({ active: true, sessionId: loopSessionID, phase: 'auditing' }),
      )
      const output = { title: '', output: 'original output', metadata: {} }

      await hook({ tool: 'plan-read', sessionID: loopSessionID, callID: 'call-1', args: {} }, output)

      expect(output.title).toBe('')
      expect(output.output).toBe('original output')
    })

    test('allows execute-plan in the after hook when the loop is inactive', async () => {
      const hook = createToolExecuteAfterHook(
        createContextForLoopState({
          active: false,
          status: 'completed',
          sessionId: loopSessionID,
          phase: 'post_action',
        }),
      )
      const output = { title: '', output: 'original output', metadata: {} }

      await hook({ tool: 'execute-plan', sessionID: loopSessionID, callID: 'call-1', args: {} }, output)

      expect(output.title).toBe('')
      expect(output.output).toBe('original output')
    })
  })
})
