import { describe, test, expect } from 'bun:test'
import { architectAgent } from '../src/agents/architect'
import { codeAgent } from '../src/agents/code'
import { auditorAgent, auditorLoopAgent } from '../src/agents/auditor'

describe('Agent definitions', () => {
  describe('metadata stability', () => {
    test('architect agent has stable metadata', () => {
      expect(architectAgent.role).toBe('architect')
      expect(architectAgent.id).toBe('opencode-architect')
      expect(architectAgent.displayName).toBe('architect')
      expect(architectAgent.mode).toBe('primary')
    })

    test('code agent has stable metadata', () => {
      expect(codeAgent.role).toBe('code')
      expect(codeAgent.id).toBe('opencode-code')
      expect(codeAgent.displayName).toBe('code')
      expect(codeAgent.mode).toBe('primary')
    })

    test('auditor agent has stable metadata', () => {
      expect(auditorAgent.role).toBe('auditor')
      expect(auditorAgent.id).toBe('opencode-auditor')
      expect(auditorAgent.displayName).toBe('auditor')
      expect(auditorAgent.mode).toBe('subagent')
      expect(auditorAgent.temperature).toBe(0.0)
    })

    test('auditor agent has expected tool exclusions', () => {
      expect(auditorAgent.tools?.exclude).toBeDefined()
      expect(auditorAgent.tools?.exclude).toContain('plan-execute')
      expect(auditorAgent.tools?.exclude).toContain('loop')
      expect(auditorAgent.tools?.exclude).toContain('loop-cancel')
      expect(auditorAgent.tools?.exclude).toContain('loop-status')
    })

    test('code agent has expected tool exclusions', () => {
      expect(codeAgent.tools?.exclude).toBeDefined()
      expect(codeAgent.tools?.exclude).toContain('review-delete')
      expect(codeAgent.tools?.exclude).toContain('plan-execute')
      expect(codeAgent.tools?.exclude).not.toContain('loop-cancel')
      expect(codeAgent.tools?.exclude).not.toContain('loop-status')
    })

    test('auditor-loop agent has stable metadata and primary mode', () => {
      expect(auditorLoopAgent.role).toBe('auditor-loop')
      expect(auditorLoopAgent.id).toBe('opencode-auditor-loop')
      expect(auditorLoopAgent.displayName).toBe('auditor-loop')
      expect(auditorLoopAgent.mode).toBe('primary')
      expect(auditorLoopAgent.hidden).toBe(true)
      expect(auditorLoopAgent.temperature).toBe(0.0)
    })

    test('auditor-loop agent shares tool exclusions with auditor', () => {
      expect(auditorLoopAgent.tools?.exclude).toEqual(auditorAgent.tools?.exclude)
    })

    test('auditor-loop prompt extends the base auditor prompt with loop context', () => {
      expect(auditorLoopAgent.systemPrompt).toContain('isolated audit session')
      expect(auditorLoopAgent.systemPrompt).toContain('Loop Audit Context')
      expect(auditorLoopAgent.systemPrompt).toContain('primary agent')
    })

    test('auditor-loop prompt requires parallel subtasks after finding checks', () => {
      const prompt = auditorLoopAgent.systemPrompt
      expect(prompt).toContain('review-finding flow has completed')
      expect(prompt).toContain('launch at least two Task subtasks in parallel')
      expect(prompt).toContain('Keep the existing review-finding order unchanged')
    })
  })

  describe('graph-first policy in system prompts', () => {
    test('architect prompt names graph tools', () => {
      const prompt = architectAgent.systemPrompt
      expect(prompt).toContain('graph-query')
      expect(prompt).toContain('graph-symbols')
      expect(prompt).toContain('graph-analyze')
    })

    test('code prompt names three graph tools', () => {
      const prompt = codeAgent.systemPrompt
      expect(prompt).toContain('graph-query')
      expect(prompt).toContain('graph-symbols')
      expect(prompt).toContain('graph-analyze')
      expect(prompt).not.toContain('graph-status')
    })

    test('auditor prompt names graph tools', () => {
      const prompt = auditorAgent.systemPrompt
      expect(prompt).toContain('graph-query')
      expect(prompt).toContain('graph-symbols')
      expect(prompt).toContain('graph-analyze')
    })

    test('architect prompt expresses graph-first discovery semantics', () => {
      const prompt = architectAgent.systemPrompt
      expect(prompt).toMatch(/graph.*first|start.*graph|graph.*readiness/i)
      expect(prompt).toMatch(/fallback.*glob.*grep|glob.*grep.*fallback/i)
    })

    test('code prompt expresses graph-first discovery semantics', () => {
      const prompt = codeAgent.systemPrompt
      expect(prompt).toMatch(/graph.*first|start.*graph|graph.*readiness/i)
      expect(prompt).toMatch(/fallback.*glob.*grep|glob.*grep.*fallback/i)
    })

    test('auditor prompt expresses graph-first discovery semantics', () => {
      const prompt = auditorAgent.systemPrompt
      expect(prompt).toMatch(/graph.*first|start.*graph|graph.*readiness/i)
      expect(prompt).toMatch(/fallback.*glob.*grep|glob.*grep.*fallback/i)
    })

    test('architect prompt does not restrict graph tools to narrow scenarios', () => {
      const prompt = architectAgent.systemPrompt
      expect(prompt).toMatch(/use whichever graph tool|whichever graph tool best fits|as appropriate/i)
    })

    test('code prompt does not restrict graph tools to narrow scenarios', () => {
      const prompt = codeAgent.systemPrompt
      expect(prompt).toMatch(/use whichever graph tool|whichever graph tool best fits|as appropriate/i)
    })

    test('auditor prompt does not restrict graph tools to narrow scenarios', () => {
      const prompt = auditorAgent.systemPrompt
      expect(prompt).toMatch(/use whichever graph tool|whichever graph tool best fits|as appropriate/i)
    })

    test('architect prompt mentions blast_radius for impact analysis', () => {
      const prompt = architectAgent.systemPrompt
      expect(prompt).toContain('blast_radius')
    })

    test('code prompt mentions callers and callees', () => {
      const prompt = codeAgent.systemPrompt
      expect(prompt).toContain('callers')
      expect(prompt).toContain('callees')
    })

    test('auditor prompt mentions blast_radius and dependency tracing', () => {
      const prompt = auditorAgent.systemPrompt
      expect(prompt).toContain('blast_radius')
      expect(prompt).toMatch(/dependency.*relationship|file_deps|file_dependents/i)
    })

    test('architect prompt includes all four canonical approval options', () => {
      const prompt = architectAgent.systemPrompt
      expect(prompt).toContain('"New session"')
      expect(prompt).toContain('"Execute here"')
      expect(prompt).toContain('"Loop (worktree)"')
      expect(prompt).toContain('"Loop"')
    })

    test('architect prompt includes pre-plan checkpoint instructions', () => {
      const prompt = architectAgent.systemPrompt
      expect(prompt).toContain('Pre-plan approval')
      expect(prompt).toContain('present a brief pre-plan summary')
      expect(prompt).toContain('Do NOT output the marked plan until the user approves')
    })

    test('architect prompt requires detailed self-contained plans', () => {
      const prompt = architectAgent.systemPrompt
      expect(prompt).toContain('detailed, self-contained, and implementation-ready')
      expect(prompt).toContain('Concrete file targets')
      expect(prompt).toContain('Intended edits per file')
      expect(prompt).toContain('Step-by-step implementation instructions')
      expect(prompt).toContain('Specific integration points')
      expect(prompt).toContain('Explicit test targets')
      expect(prompt).toContain('Explicit validation')
      expect(prompt).toContain('Phase acceptance criteria')
      expect(prompt).toContain('extremely detailed and execution-ready')
      expect(prompt).not.toContain('plan-write')
      expect(prompt).not.toContain('plan-edit')
    })

    test('architect prompt includes pre-plan approval section', () => {
      const prompt = architectAgent.systemPrompt
      expect(prompt).toContain('## Pre-plan approval')
      expect(prompt).toContain('present a brief pre-plan summary')
      expect(prompt).toContain('Should I write the implementation plan?')
    })
  })
})
