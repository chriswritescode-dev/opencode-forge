import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  materializeSkillsIntoWorktree,
} from '../../src/utils/skill-materializer'
import { resolveConfigDir } from '../../src/setup'

vi.mock('../../src/setup', () => ({
  resolveConfigDir: vi.fn(),
}))

describe('materializeSkillsIntoWorktree', () => {
  let tmpDir: string
  let worktreeDir: string
  let sourceSkillsDir: string
  let excludeFilePath: string
  let resolveExcludePath: (worktreeDir: string) => string | null

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'skill-materializer-'))
    worktreeDir = join(tmpDir, 'worktree')
    sourceSkillsDir = join(tmpDir, 'source-skills')
    excludeFilePath = join(tmpDir, 'exclude-file')
    resolveExcludePath = () => excludeFilePath

    mkdirSync(worktreeDir, { recursive: true })
    mkdirSync(sourceSkillsDir, { recursive: true })
  })

  afterEach(() => {
    vi.clearAllMocks()
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // ── Happy path ──────────────────────────────────────────────

  it('copies skill directory recursively to .opencode/skills/<name>', () => {
    // Create source skill with SKILL.md and helper.sh
    const skillDir = join(sourceSkillsDir, 'demo')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), '# Demo skill')
    writeFileSync(join(skillDir, 'helper.sh'), 'echo hello')

    const result = materializeSkillsIntoWorktree({
      worktreeDir,
      skills: ['demo'],
      sourceSkillsDir,
      resolveExcludePath,
    })

    expect(result).toEqual({ copied: ['demo'], missing: [] })

    // Both files copied
    const destSkillDir = join(worktreeDir, '.opencode', 'skills', 'demo')
    expect(existsSync(join(destSkillDir, 'SKILL.md'))).toBe(true)
    expect(existsSync(join(destSkillDir, 'helper.sh'))).toBe(true)
    expect(readFileSync(join(destSkillDir, 'SKILL.md'), 'utf-8')).toBe('# Demo skill')
  })

  it('writes .opencode/skills/ to git exclude file after copy', () => {
    const skillDir = join(sourceSkillsDir, 'demo')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), '# Demo')

    materializeSkillsIntoWorktree({
      worktreeDir,
      skills: ['demo'],
      sourceSkillsDir,
      resolveExcludePath,
    })

    const excludeContent = readFileSync(excludeFilePath, 'utf-8')
    expect(excludeContent).toContain('.opencode/skills/')
  })

  // ── Missing skill ───────────────────────────────────────────

  it('records missing skills without throwing and does not create exclude file', () => {
    const result = materializeSkillsIntoWorktree({
      worktreeDir,
      skills: ['nonexistent'],
      sourceSkillsDir,
      resolveExcludePath,
    })

    expect(result).toEqual({ copied: [], missing: ['nonexistent'] })
    // Exclude file should not have been created
    expect(existsSync(excludeFilePath)).toBe(false)
  })

  it('does not create .opencode/skills dir when no skills are copied', () => {
    const result = materializeSkillsIntoWorktree({
      worktreeDir,
      skills: ['nonexistent'],
      sourceSkillsDir,
      resolveExcludePath,
    })

    expect(result.missing).toContain('nonexistent')
    expect(existsSync(join(worktreeDir, '.opencode'))).toBe(false)
  })

  // ── Idempotent exclude line ─────────────────────────────────

  it('does not duplicate .opencode/skills/ line on second call', () => {
    const skillDir = join(sourceSkillsDir, 'demo')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), '# Demo')

    // First call
    materializeSkillsIntoWorktree({
      worktreeDir,
      skills: ['demo'],
      sourceSkillsDir,
      resolveExcludePath,
    })

    // Second call
    materializeSkillsIntoWorktree({
      worktreeDir,
      skills: ['demo'],
      sourceSkillsDir,
      resolveExcludePath,
    })

    const excludeContent = readFileSync(excludeFilePath, 'utf-8')
    const matches = excludeContent.match(/\.opencode\/skills\//g)
    expect(matches).toHaveLength(1)
  })

  it('does not add exclude line if already present from prior operation', () => {
    const skillDir = join(sourceSkillsDir, 'demo')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), '# Demo')

    // Pre-populate exclude file with the line
    const excludeDir = join(tmpDir)
    const excludePath = join(excludeDir, 'pre-existing-exclude')
    writeFileSync(excludePath, '.opencode/skills/\n', 'utf-8')

    materializeSkillsIntoWorktree({
      worktreeDir,
      skills: ['demo'],
      sourceSkillsDir,
      resolveExcludePath: () => excludePath,
    })

    const content = readFileSync(excludePath, 'utf-8')
    expect(content).toBe('.opencode/skills/\n')
  })

  // ── Unsafe name ─────────────────────────────────────────────

  it('rejects path-traversal names as missing', () => {
    const result = materializeSkillsIntoWorktree({
      worktreeDir,
      skills: ['../evil'],
      sourceSkillsDir,
      resolveExcludePath,
    })

    expect(result).toEqual({ copied: [], missing: ['../evil'] })
    expect(existsSync(join(worktreeDir, '.opencode'))).toBe(false)
    expect(existsSync(excludeFilePath)).toBe(false)
  })

  it('rejects names with forward slash as missing', () => {
    const result = materializeSkillsIntoWorktree({
      worktreeDir,
      skills: ['foo/bar'],
      sourceSkillsDir,
      resolveExcludePath,
    })

    expect(result).toEqual({ copied: [], missing: ['foo/bar'] })
  })

  it('rejects names with backslash as missing', () => {
    const result = materializeSkillsIntoWorktree({
      worktreeDir,
      skills: ['foo\\bar'],
      sourceSkillsDir,
      resolveExcludePath,
    })

    expect(result).toEqual({ copied: [], missing: ['foo\\bar'] })
  })

  // ── Empty skills ────────────────────────────────────────────

  it('returns empty result and writes nothing when skills list is empty', () => {
    const result = materializeSkillsIntoWorktree({
      worktreeDir,
      skills: [],
      sourceSkillsDir,
      resolveExcludePath,
    })

    expect(result).toEqual({ copied: [], missing: [] })
    expect(existsSync(join(worktreeDir, '.opencode'))).toBe(false)
    expect(existsSync(excludeFilePath)).toBe(false)
  })

  // ── Copy error handling ─────────────────────────────────────

  it('handles copy failure gracefully (non-existent source directory)', () => {
    // Point to a directory that doesn't exist as source
    const result = materializeSkillsIntoWorktree({
      worktreeDir,
      skills: ['ghost'],
      sourceSkillsDir,
      resolveExcludePath,
    })

    // The source doesn't exist, so it's missing — not a copy failure
    expect(result).toEqual({ copied: [], missing: ['ghost'] })
  })

  // ── Default sourceSkillsDir ─────────────────────────────────

  it('uses default sourceSkillsDir (resolveConfigDir/skills) when not provided', () => {
    // Point resolveConfigDir to our controlled temp directory
    const mockResolveConfigDir = resolveConfigDir as ReturnType<typeof vi.fn>
    mockResolveConfigDir.mockReturnValue(tmpDir)

    // Create tdd skill in the controlled default location
    const defaultSkillsDir = join(tmpDir, 'skills', 'tdd')
    mkdirSync(defaultSkillsDir, { recursive: true })
    writeFileSync(join(defaultSkillsDir, 'SKILL.md'), '# TDD skill')

    const result = materializeSkillsIntoWorktree({
      worktreeDir,
      skills: ['tdd'],
      resolveExcludePath,
    })

    // With a controlled default path, tdd should be found and copied
    expect(result.copied).toContain('tdd')
    expect(result.missing).not.toContain('tdd')
    expect(existsSync(join(worktreeDir, '.opencode', 'skills', 'tdd', 'SKILL.md'))).toBe(true)
  })

  // ── Logger integration ──────────────────────────────────────

  it('does not call logger.error on success path', () => {
    const skillDir = join(sourceSkillsDir, 'okay')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), '# Okay')

    const logger = { log: vi.fn(), error: vi.fn() }

    materializeSkillsIntoWorktree({
      worktreeDir,
      skills: ['okay'],
      sourceSkillsDir,
      resolveExcludePath,
      logger,
    })

    expect(logger.error).not.toHaveBeenCalled()
  })

  // ── Multiple skills: mixed present and missing ──────────────

  it('handles a mix of present and missing skills', () => {
    // Create one skill
    const skillDir = join(sourceSkillsDir, 'present')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), '# Present')

    const result = materializeSkillsIntoWorktree({
      worktreeDir,
      skills: ['present', 'missing-one'],
      sourceSkillsDir,
      resolveExcludePath,
    })

    expect(result.copied).toEqual(['present'])
    expect(result.missing).toEqual(['missing-one'])
    expect(existsSync(join(worktreeDir, '.opencode', 'skills', 'present', 'SKILL.md'))).toBe(true)
  })
})
