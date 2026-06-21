import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { loadPrompt } from '../../src/prompts/loader'
import { SECTION_SUMMARY_START_MARKER, SECTION_SUMMARY_END_MARKER } from '../../src/utils/section-summary'
import { buildAgents } from '../../src/agents'

describe('loadPrompt', () => {
  test('loads architect prompt from bundled markdown', () => {
    const prompt = loadPrompt(['agents', 'architect.md'])
    expect(prompt).toContain('You are a planning agent')
  })

  test('loads code prompt from bundled markdown', () => {
    const prompt = loadPrompt(['agents', 'code.md'])
    expect(prompt).toContain('You are a coding agent')
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

  test('auditor-loop-addendum contains the literal section-summary markers', () => {
    const prompt = loadPrompt(['agents', 'auditor-loop-addendum.md'])
    expect(prompt).toContain(SECTION_SUMMARY_START_MARKER)
    expect(prompt).toContain(SECTION_SUMMARY_END_MARKER)
  })

  test('buildAgents with custom promptsDir uses the custom prompt', () => {
    const tmpDir = join(import.meta.dirname, '..', '..', '.forge', 'tmp', 'test-build-agents')
    mkdirSync(join(tmpDir, 'agents'), { recursive: true })
    writeFileSync(join(tmpDir, 'agents', 'architect.md'), 'CUSTOM', 'utf-8')

    const agents = buildAgents(tmpDir)
    expect(agents.architect.systemPrompt).toBe('CUSTOM')

    rmSync(tmpDir, { recursive: true, force: true })
  })
})
