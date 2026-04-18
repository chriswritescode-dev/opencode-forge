import { describe, test, expect } from 'bun:test'
import { architectAgent } from '../src/agents/architect'
import { codeAgent } from '../src/agents/code'
import { auditorAgent } from '../src/agents/auditor'

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
    })

    test('code agent has expected tool exclusions', () => {
      expect(codeAgent.tools?.exclude).toBeDefined()
      expect(codeAgent.tools?.exclude).toContain('review-delete')
      expect(codeAgent.tools?.exclude).toContain('plan-execute')
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
      expect(prompt).toContain('Do NOT call `plan-write` until the user has approved writing the plan')
    })

    test('architect prompt requires detailed self-contained plans', () => {
      const prompt = architectAgent.systemPrompt
      expect(prompt).toContain('detailed, self-contained, and implementation-ready')
      expect(prompt).toContain('Concrete file targets')
      expect(prompt).toContain('Intended edits per file')
      expect(prompt).toContain('Specific integration points')
      expect(prompt).toContain('Explicit test targets')
      expect(prompt).toContain('Phase acceptance criteria')
    })

    test('architect prompt includes pre-plan approval section', () => {
      const prompt = architectAgent.systemPrompt
      expect(prompt).toContain('## Pre-plan approval')
      expect(prompt).toContain('present a brief pre-plan summary')
      expect(prompt).toContain('Should I write the implementation plan?')
    })
  })
})
