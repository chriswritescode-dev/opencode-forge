import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { loadPrompt } from '../../src/prompts/loader'
import { buildAgents } from '../../src/agents'

describe('loadPrompt', () => {
  test('loads architect prompt from bundled markdown', () => {
    const prompt = loadPrompt(['agents', 'architect.md'])
    expect(prompt).toContain('You are a planning agent')
    expect(prompt).toContain('plan-write')
    expect(prompt).toContain('plan-edit')
  })

  test('architect-auto prompt retains forge-plan:none token', () => {
    const prompt = loadPrompt(['agents', 'architect-auto.md'])
    expect(prompt).toContain('<!-- forge-plan:none -->')
    expect(prompt).toContain('plan-write')
  })

  test('loads code prompt from bundled markdown', () => {
    const prompt = loadPrompt(['agents', 'code.md'])
    expect(prompt).toContain('You are an AI agent running in OpenCode')
  })

  test('uses user-provided prompts dir when file exists', () => {
    const tmpDir = join(import.meta.dirname, '..', '..', '.forge', 'tmp', 'test-prompts')
    mkdirSync(join(tmpDir, 'agents'), { recursive: true })
    writeFileSync(join(tmpDir, 'agents', 'architect.md'), 'CUSTOM ARCHITECT', 'utf-8')

    const prompt = loadPrompt(['agents', 'architect.md'], tmpDir)
    expect(prompt).toBe('CUSTOM ARCHITECT')

    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('falls back to bundled when user dir does not contain the file', () => {
    const tmpDir = join(import.meta.dirname, '..', '..', '.forge', 'tmp', 'test-prompts-empty')
    mkdirSync(tmpDir, { recursive: true })

    const prompt = loadPrompt(['agents', 'code.md'], tmpDir)
    expect(prompt).toContain('coding agent')

    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('auditor-loop-addendum describes the loop-handoff protocol without hand-written markers', () => {
    const prompt = loadPrompt(['agents', 'auditor-loop-addendum.md'])
    expect(prompt).toContain('loop-handoff')
    expect(prompt).toContain('never parses your response text')
    expect(prompt).not.toContain('section-summary block')
    expect(prompt).not.toContain('<!-- section-summary')
  })

  test('auditor-loop-addendum requires remediation guidance for blocking findings', () => {
    const prompt = loadPrompt(['agents', 'auditor-loop-addendum.md'])
    expect(prompt).toContain('## Remediation Guidance')
    expect(prompt).toContain('**Detailed solution**')
    expect(prompt).toContain('implementation-ready fix')
    expect(prompt).toContain('exact files, symbols, and code paths')
    expect(prompt).toContain('ordered implementation steps or concise pseudocode/code shape')
    expect(prompt).toContain('**Acceptance criteria**')
    expect(prompt).toContain('**Verification**')
  })

  test('auditor-loop-addendum blocks a section on bugs at or before it, with no final-audit special case', () => {
    const prompt = loadPrompt(['agents', 'auditor-loop-addendum.md'])
    expect(prompt).toContain('A clean section means no outstanding bugs at or before it')
    expect(prompt).toContain('attributed to this section or any earlier section')
    expect(prompt).toContain('later, not-yet-started section do not block')
    expect(prompt).toContain('`review-read` returns the current and earlier sections')
    expect(prompt).toContain('Every section, including the last, follows this same rule')
    expect(prompt).not.toContain('Last open section')
    expect(prompt).not.toContain("Confirm the master plan's top-level Verification commands")
    expect(prompt).not.toContain('final audit')
    expect(prompt).not.toContain('AUDIT_SCOPE:1')
  })

  test('auditor-loop-addendum documents session continuation for same-section retries', () => {
    const prompt = loadPrompt(['agents', 'auditor-loop-addendum.md'])
    expect(prompt).toContain('**Follow-up turns.**')
    expect(prompt).toContain('possibly stale')
    expect(prompt).toContain('audit the delta plus anything it affects')
    expect(prompt).toContain('apply to every turn')
    expect(prompt).not.toContain('single-iteration')
    expect(prompt).not.toContain('this session is deleted by the loop runner')
  })

  test('auditor-loop-addendum treats sandbox-unsatisfiable requirements as plan defects, not coder failures', () => {
    const loop = loadPrompt(['agents', 'auditor-loop-addendum.md'])
    expect(loop).toContain('**Sandbox feasibility.**')
    expect(loop).toContain('satisfiable inside the sandbox')
    expect(loop).toContain('applying Terraform or other infrastructure-as-code against a cloud provider')
    expect(loop).toContain('Never write a finding demanding the unsatisfiable requirement itself')
    expect(loop).toContain('This substitution is not weakening')
  })

  test('buildAgents with custom promptsDir uses the custom prompt', () => {
    const tmpDir = join(import.meta.dirname, '..', '..', '.forge', 'tmp', 'test-build-agents')
    mkdirSync(join(tmpDir, 'agents'), { recursive: true })
    writeFileSync(join(tmpDir, 'agents', 'architect.md'), 'CUSTOM', 'utf-8')

    const agents = buildAgents(tmpDir)
    expect(agents.architect.systemPrompt).toBe('CUSTOM')

    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('loadPrompt memoizes per resolved path', () => {
    const tmpDir = join(import.meta.dirname, '..', '..', '.forge', 'tmp', 'memo-' + Date.now())
    mkdirSync(join(tmpDir, 'agents'), { recursive: true })
    writeFileSync(join(tmpDir, 'agents', 'architect.md'), 'V1', 'utf-8')

    const result1 = loadPrompt(['agents', 'architect.md'], tmpDir)
    expect(result1).toBe('V1')

    writeFileSync(join(tmpDir, 'agents', 'architect.md'), 'V2', 'utf-8')

    const result2 = loadPrompt(['agents', 'architect.md'], tmpDir)
    expect(result2).toBe('V1')

    rmSync(tmpDir, { recursive: true, force: true })
  })
})
