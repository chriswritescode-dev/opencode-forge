import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import { createLoopService, type LoopService } from '../../src/loop/service'
import { parseSectionSummary, SECTION_SUMMARY_START_MARKER, SECTION_SUMMARY_END_MARKER } from '../../src/loop/section-summary'
import type { Logger } from '../../src/types'
import { setupLoopsTestDb } from '../helpers/loops-test-db'

const mockLogger: Logger = {
  log: () => {},
  error: () => {},
  debug: () => {},
}

const PROJECT_ID = 'test-project'

describe('parseSectionSummary', () => {
  let db: Database
  let loopService: LoopService

  beforeEach(() => {
    const tempDir = mkdtempSync(join(tmpdir(), 'parse-section-summary-test-'))
    db = new Database(join(tempDir, 'test.db'))

    setupLoopsTestDb(db)

    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const sectionPlansRepo = createSectionPlansRepo(db)
    loopService = createLoopService(
      loopsRepo,
      plansRepo,
      reviewFindingsRepo,
      PROJECT_ID,
      mockLogger,
      undefined,
      undefined,
      undefined,
      sectionPlansRepo,
    )
  })

  afterEach(() => {
    db.close()
    rmSync(db.name.replace('/test.db', ''), { recursive: true, force: true })
  })

  test('extracts Done, Deviations, and Follow-ups sections', () => {
    const text = `<!-- section-summary:start -->
### Done
- Implemented feature X
### Deviations
- None
### Follow-ups
- Handled in section 2
<!-- section-summary:end -->`

    const result = parseSectionSummary(text)
    expect(result).not.toBeNull()
    expect(result!.done).toContain('Implemented feature X')
    expect(result!.deviations).toContain('None')
    expect(result!.followUps).toContain('Handled in section 2')
  })

  test('returns null when no section summary marker', () => {
    const result = parseSectionSummary('No summary here')
    expect(result).toBeNull()
  })

  test('returns null when summary block is unterminated', () => {
    const text = `<!-- section-summary:start -->
### Done
- Completed work`

    const result = parseSectionSummary(text)
    expect(result).toBeNull()
  })

  test('returns null when start marker is missing', () => {
    const text = `### Done
- Completed work
<!-- section-summary:end -->`

    const result = parseSectionSummary(text)
    expect(result).toBeNull()
  })

  test('handles partial markers (only Done)', () => {
    const text = `<!-- section-summary:start -->
### Done
- Completed work
<!-- section-summary:end -->`

    const result = parseSectionSummary(text)
    expect(result).not.toBeNull()
    expect(result!.done).toContain('Completed work')
    expect(result!.deviations).toBeNull()
    expect(result!.followUps).toBeNull()
  })

  test('handles multiline content', () => {
    const text = `<!-- section-summary:start -->
### Done
- Implemented feature A
- Fixed bug B
### Deviations
- Skipped optional step C
- Reason: not required
### Follow-ups
- Defer to section 3
- Add test coverage
<!-- section-summary:end -->`

    const result = parseSectionSummary(text)
    expect(result).not.toBeNull()
    expect(result!.done).toContain('Implemented feature A')
    expect(result!.done).toContain('Fixed bug B')
    expect(result!.deviations).toContain('Skipped optional step C')
    expect(result!.followUps).toContain('Defer to section 3')
  })

  test('accepts \\r\\n line endings', () => {
    const text = `<!-- section-summary:start -->\r\n### Done\r\n- Feature X\r\n### Deviations\r\n- None\r\n### Follow-ups\r\n- Deferred\r\n<!-- section-summary:end -->`

    const result = parseSectionSummary(text)
    expect(result).not.toBeNull()
    expect(result!.done).toContain('Feature X')
    expect(result!.deviations).toContain('None')
    expect(result!.followUps).toContain('Deferred')
  })

  test('tolerates surrounding whitespace around marker lines', () => {
    const text = `  <!-- section-summary:start -->  
### Done
- Work done
  ### Deviations  
- No deviation
### Follow-ups
- Some follow-up
  <!-- section-summary:end -->  `

    const result = parseSectionSummary(text)
    expect(result).not.toBeNull()
    expect(result!.done).toContain('Work done')
    expect(result!.deviations).toContain('No deviation')
    expect(result!.followUps).toContain('Some follow-up')
  })

  test('stops subsection at next unknown ### heading', () => {
    const text = `<!-- section-summary:start -->
### Done
- Implemented feature X
### Notes
- Some extra notes
### Deviations
- None
<!-- section-summary:end -->`

    const result = parseSectionSummary(text)
    expect(result).not.toBeNull()
    expect(result!.done).toContain('Implemented feature X')
    expect(result!.deviations).toContain('None')
    expect(result!.followUps).toBeNull()
  })

  test('stops subsection at end of block', () => {
    const text = `<!-- section-summary:start -->
### Done
- Implemented feature X
<!-- section-summary:end -->`

    const result = parseSectionSummary(text)
    expect(result).not.toBeNull()
    expect(result!.done).toContain('Implemented feature X')
  })

  test('ignores end marker before start marker', () => {
    const text = `Some diagnostics text.
<!-- section-summary:end -->
More diagnostics.
<!-- section-summary:start -->
### Done
- Completed work
### Deviations
- None
### Follow-ups
- Deferred
<!-- section-summary:end -->`

    const result = parseSectionSummary(text)
    expect(result).not.toBeNull()
    expect(result!.done).toContain('Completed work')
    expect(result!.deviations).toContain('None')
    expect(result!.followUps).toContain('Deferred')
  })

  test('uses shared constants for markers', () => {
    expect(SECTION_SUMMARY_START_MARKER).toBe('<!-- section-summary:start -->')
    expect(SECTION_SUMMARY_END_MARKER).toBe('<!-- section-summary:end -->')
  })
})
