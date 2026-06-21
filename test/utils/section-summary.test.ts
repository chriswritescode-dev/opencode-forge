import { describe, test, expect, vi } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { hasSectionSummaryMarkers, SECTION_SUMMARY_START_MARKER, SECTION_SUMMARY_END_MARKER } from '../../src/utils/section-summary'
import { buildAuditorLoopAgent } from '../../src/agents/auditor'

describe('hasSectionSummaryMarkers', () => {
  test('returns true when text contains both markers', () => {
    const text = `some content\n${SECTION_SUMMARY_START_MARKER}\nmid\n${SECTION_SUMMARY_END_MARKER}\nmore`
    expect(hasSectionSummaryMarkers(text)).toBe(true)
  })

  test('returns false when missing start marker', () => {
    const text = `some content\n${SECTION_SUMMARY_END_MARKER}`
    expect(hasSectionSummaryMarkers(text)).toBe(false)
  })

  test('returns false when missing end marker', () => {
    const text = `some content\n${SECTION_SUMMARY_START_MARKER}`
    expect(hasSectionSummaryMarkers(text)).toBe(false)
  })

  test('returns false for empty string', () => {
    expect(hasSectionSummaryMarkers('')).toBe(false)
  })
})

describe('buildLoopPrompt marker warning', () => {
  test('warns when auditor-loop-addendum.md lacks markers', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const tmpDir = join(import.meta.dirname, '..', '..', '.forge', 'tmp', 'section-marker-test-' + Date.now())
    mkdirSync(join(tmpDir, 'agents'), { recursive: true })
    writeFileSync(join(tmpDir, 'agents', 'auditor-loop-addendum.md'), 'NO MARKERS HERE', 'utf-8')
    writeFileSync(join(tmpDir, 'agents', 'auditor.md'), 'BASE', 'utf-8')
    writeFileSync(join(tmpDir, 'agents', 'auditor-final-audit-addendum.md'), 'FINAL', 'utf-8')

    buildAuditorLoopAgent(tmpDir)

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(
      '[forge] auditor-loop-addendum.md is missing section-summary markers; loop section parsing may fail'
    )

    warnSpy.mockRestore()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('does not warn when markers are present', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const tmpDir = join(import.meta.dirname, '..', '..', '.forge', 'tmp', 'section-marker-ok-' + Date.now())
    mkdirSync(join(tmpDir, 'agents'), { recursive: true })
    writeFileSync(join(tmpDir, 'agents', 'auditor-loop-addendum.md'),
      `${SECTION_SUMMARY_START_MARKER}\ncontent\n${SECTION_SUMMARY_END_MARKER}`, 'utf-8')
    writeFileSync(join(tmpDir, 'agents', 'auditor.md'), 'BASE', 'utf-8')
    writeFileSync(join(tmpDir, 'agents', 'auditor-final-audit-addendum.md'), 'FINAL', 'utf-8')

    buildAuditorLoopAgent(tmpDir)

    expect(warnSpy).not.toHaveBeenCalled()

    warnSpy.mockRestore()
    rmSync(tmpDir, { recursive: true, force: true })
  })
})
