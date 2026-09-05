import { tool } from '@opencode-ai/plugin'
import type { ToolContext } from './types'
import { formatFindingDetails } from '../utils/review-format'
import { auditScope } from '../loop/state'

const z = tool.schema

const ATTEMPT_PAGE_LIMIT_DEFAULT = 20

export function createReviewTools(ctx: ToolContext): Record<string, ReturnType<typeof tool>> {
  const { reviewFindingsRepo, projectId, logger } = ctx
  const loop = ctx.loop

  /**
   * Resolve the loop owning the current tool context using the single canonical
   * resolver (`resolveActiveLoopForSession`), which follows parent-session hops.
   * Read, write, and delete MUST share this so a finding written under a loop —
   * even from a descendant session such as an audit subagent — is always
   * visible and deletable from that loop. Returns null outside any active loop.
   */
  async function resolveLoopName(toolCtx?: { sessionID?: string }): Promise<string | null> {
    const sessionId = toolCtx?.sessionID
    if (!sessionId) return null
    const resolved = await ctx.resolveActiveLoopForSession(sessionId)
    const loopName = resolved?.loopName ?? null
    logger.log(`review-scope: session=${sessionId} resolved loop=${loopName ?? 'none'}`)
    return loopName
  }

  /**
   * Phases where current-section scoping must be bypassed: the final audit
   * reviews all sections, and the final-audit fix pass works on the
   * cross-section findings that audit produced.
   */
  function isFinalAuditScope(phase: string): boolean {
    return phase === 'final_auditing' || phase === 'final_audit_fix'
  }

  return {
    'review-write': tool({
      description: 'Store a code review finding with file location, severity, and description. Automatically injects loopName and sectionIndex from the current loop section (not during the final audit — pass sectionIndex explicitly there). Use crossSection: true to write a cross-section finding (sectionIndex null). Use sectionIndex to override the auto-injected value.',
      args: {
        file: z.string().describe('The file path where the finding is located'),
        line: z.number().describe('The line number of the finding'),
        severity: z.enum(['bug', 'warning']).describe('The severity of the finding'),
        description: z.string().describe('Clear description of the issue'),
        scenario: z.string().optional().describe('The specific conditions under which this issue manifests'),
        crossSection: z.boolean().optional().describe('Set true if the finding spans multiple sections. Defaults to false.'),
        sectionIndex: z.number().optional().describe('Explicitly set section index. Defaults to current section in a sectioned loop.'),
      },
      execute: async (args, toolCtx) => {
        const row = {
          projectId,
          file: args.file,
          line: args.line,
          severity: args.severity,
          description: args.description,
          scenario: args.scenario ?? null,
          loopName: null as string | null,
          sectionIndex: null as number | null,
        }

        row.loopName = await resolveLoopName(toolCtx)
        if (row.loopName) {
          const loopState = loop.service.getActiveState(row.loopName)
          // During the final audit the "current section" is just the last section;
          // auto-injecting it would misattribute cross-section findings, so the
          // final audit must pass sectionIndex explicitly (matching read/delete).
          if (loopState && loopState.totalSections > 0 && !isFinalAuditScope(loopState.phase)) {
            row.sectionIndex = loopState.currentSectionIndex
          }
        }

        // Apply explicit section index or crossSection override
        if (args.crossSection) {
          row.sectionIndex = null
        } else if (args.sectionIndex !== undefined && args.sectionIndex !== null) {
          if (!Number.isInteger(args.sectionIndex)) {
            return `Invalid sectionIndex ${args.sectionIndex}: must be an integer.`
          }
          const loopName = row.loopName
          if (loopName) {
            const loopState = loop.service.getActiveState(loopName)
            if (loopState && loopState.totalSections > 0) {
              if (args.sectionIndex < 0 || args.sectionIndex >= loopState.totalSections) {
                return `Invalid sectionIndex ${args.sectionIndex}: must be between 0 and ${loopState.totalSections - 1}.`
              }
            }
          }
          row.sectionIndex = args.sectionIndex
        }

        const result = reviewFindingsRepo.write(row)
        if (!result.ok && result.conflict) {
          logger.log(`review-write: finding already exists at ${args.file}:${args.line}`)
          return `Finding already exists at ${args.file}:${args.line}. Only review-delete (auditor only) can remove an existing finding.`
        }
        
        logger.log(`review-write: stored finding at ${args.file}:${args.line} (${args.severity}) loop=${row.loopName ?? 'none'}${row.sectionIndex !== null ? ` section ${row.sectionIndex}` : ''}`)
        return `Stored review finding at ${args.file}:${args.line} (${args.severity})${row.sectionIndex !== null ? ` for section ${row.sectionIndex}` : ''}`
      },
    }),

    'review-read': tool({
      description: 'Retrieve code review findings. No args lists findings for the current scope; outside a loop only non-loop findings are returned. Use loopName to target a specific loop (e.g. a completed loop you are reviewing from outside it), which returns all of that loop\'s findings across sections. Use file to filter by file path. Use pattern for regex search. Automatically scoped to current section when running in a sectioned loop. Use crossSection: true to read only cross-section findings (sectionIndex null). Use allSections: true to list findings from all sections. With attempts: true, return the durable audit-attempt history as JSON {attempts, nextBeforeId} instead of findings — paginate with beforeId (positive integer cursor) and limit (1-100); file/pattern/crossSection filtering is rejected in that mode. Attempt scope follows the same scoping rules as findings: default current scope, explicit loopName or allSections: true returns all scopes.',
      args: {
        loopName: z.string().optional().describe('Target findings from a specific loop by name, overriding the session-resolved scope. Returns all of that loop\'s sections.'),
        file: z.string().optional().describe('Filter findings by file path'),
        pattern: z.string().optional().describe('Regex pattern to search across findings'),
        crossSection: z.boolean().optional().describe('Return only cross-section findings (sectionIndex null) instead of current section.'),
        allSections: z.boolean().optional().describe('Return all findings across all sections, ignoring current section scoping.'),
        attempts: z.boolean().optional().describe('Return the loop attempt history as JSON {attempts, nextBeforeId} instead of findings.'),
        beforeId: z.number().optional().describe('Pagination cursor for attempts mode: return attempts with id < beforeId. Must be a positive integer.'),
        limit: z.number().optional().describe('Max attempts to return in attempts mode (1-100).'),
      },
      execute: async (args, toolCtx) => {
        if (args.attempts === true) {
          if (args.file !== undefined || args.pattern !== undefined || args.crossSection !== undefined) {
            return 'attempts: true cannot be combined with file, pattern, or crossSection filtering — read findings and attempt history in separate calls.'
          }
          if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100)) {
            return 'Invalid limit: must be an integer between 1 and 100.'
          }
          if (args.beforeId !== undefined && (!Number.isInteger(args.beforeId) || args.beforeId < 1)) {
            return 'Invalid beforeId: must be a positive integer.'
          }
          const trimmedLoop = typeof args.loopName === 'string' ? args.loopName.trim() : ''
          const explicitLoop = trimmedLoop !== ''
          const loopName = explicitLoop ? trimmedLoop : await resolveLoopName(toolCtx)
          if (!loopName) return JSON.stringify({ attempts: [], nextBeforeId: null })
          const state = loop.service.getAnyState(loopName)
          if (!state) return JSON.stringify({ attempts: [], nextBeforeId: null })
          const scope = explicitLoop || args.allSections ? undefined : auditScope(state)
          const limit = args.limit ?? ATTEMPT_PAGE_LIMIT_DEFAULT
          const attempts = loop.service.getAttemptHistory(loopName, scope, limit, args.beforeId)
          const nextBeforeId = attempts.length === limit && attempts.length > 0
            ? Math.min(...attempts.map((a) => a.id))
            : null
          logger.log(`review-read: attempts loop=${loopName} scope=${scope ?? 'all'} count=${String(attempts.length)} nextBeforeId=${String(nextBeforeId)}`)
          return JSON.stringify({ attempts, nextBeforeId })
        }

        const trimmedLoop = typeof args.loopName === 'string' ? args.loopName.trim() : ''
        const explicitLoop = trimmedLoop !== ''
        const loopName: string | null = explicitLoop
          ? trimmedLoop
          : await resolveLoopName(toolCtx)
        let findings = reviewFindingsRepo.listByLoopName(projectId, loopName)

        // Filter by section scope when in a sectioned loop
        // During final_auditing, return all sections so the auditor can see cross-section findings
        // An explicit loopName targets another loop, so its sections are all returned
        if (loopName && !explicitLoop && !args.allSections) {
          const loopState = loop.service.getActiveState(loopName)
          if (loopState && loopState.totalSections > 0 && !isFinalAuditScope(loopState.phase)) {
            if (args.crossSection) {
              // crossSection: return only cross-section findings (sectionIndex === null)
              findings = findings.filter((f) => f.sectionIndex === null)
            } else {
              // Default: return only current section findings (cross-section findings surface at final audit only)
              findings = findings.filter((f) => f.sectionIndex === loopState.currentSectionIndex)
            }
          }
        } else if (explicitLoop && args.crossSection) {
          findings = findings.filter((f) => f.sectionIndex === null)
        }

        if (args.file) {
          findings = findings.filter((f) => f.file === args.file)
        }

        if (args.pattern) {
          let regex: RegExp
          try {
            regex = new RegExp(args.pattern)
          } catch (e) {
            return `Invalid regex pattern: ${(e as Error).message}`
          }

          const matchedFindings = []
          for (const finding of findings) {
            const valueStr = `${finding.description} ${finding.scenario || ''}`
            if (regex.test(valueStr)) {
              matchedFindings.push(finding)
            }
          }
          findings = matchedFindings
        }

        if (findings.length === 0) {
          return 'No review findings found.'
        }

        logger.log(`review-read: found ${findings.length} findings`)
        return `${findings.length} review finding${findings.length === 1 ? '' : 's'}:\n\n${formatFindingDetails(findings, { includeScope: true })}`
      },
    }),

    'review-delete': tool({
      description: 'Delete a code review finding by file and line number. Automatically scoped to current section when running in a sectioned loop. Use crossSection=true to delete cross-section findings.',
      args: {
        file: z.string().describe('The file path of the finding to delete'),
        line: z.number().describe('The line number of the finding to delete'),
        sectionIndex: z.number().optional().describe('Explicitly set section index. Defaults to current section in a sectioned loop.'),
        crossSection: z.boolean().optional().describe('Set to true to delete cross-section findings (sectionIndex=null). Overrides sectionIndex.'),
      },
      execute: async (args, toolCtx) => {
        const loopName = await resolveLoopName(toolCtx)
        let sectionIndex: number | null | undefined = args.sectionIndex

        if (args.crossSection === true) {
          sectionIndex = null
        } else if (sectionIndex === undefined && loopName) {
          const loopState = loop.service.getActiveState(loopName)
          if (loopState && loopState.totalSections > 0 && !isFinalAuditScope(loopState.phase)) {
            sectionIndex = loopState.currentSectionIndex
          }
        }

        const sectionLabel = sectionIndex === undefined ? 'any' : sectionIndex === null ? 'cross-section' : String(sectionIndex)
        const deleted = reviewFindingsRepo.delete(projectId, args.file, args.line, { loopName, sectionIndex })
        if (!deleted) {
          logger.log(`review-delete: no finding at ${args.file}:${args.line} for loop=${loopName ?? 'none'} section=${sectionLabel}`)
          return `No review finding found at ${args.file}:${args.line}`
        }
        logger.log(`review-delete: deleted finding at ${args.file}:${args.line} loop=${loopName ?? 'none'} section=${sectionLabel}`)
        return `Deleted review finding at ${args.file}:${args.line}`
      },
    }),
  }
}
