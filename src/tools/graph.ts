import { tool } from '@opencode-ai/plugin'
import type { ToolContext } from './types'
import type { GraphService } from '../graph/service'

const z = tool.schema

interface GraphToolContext {
  graphService: GraphService | null
  graphStatusRepo: ToolContext['graphStatusRepo']
}

export function createGraphTools(ctx: ToolContext & GraphToolContext): Record<string, ReturnType<typeof tool>> {
  const { graphService, logger } = ctx

  return {
    'graph-status': tool({
      description: 'Check graph indexing status or trigger re-scan',
      args: {
        action: z.enum(['status', 'scan']).describe('Action to perform'),
      },
      execute: async (args) => {
        // Always allow scan action even when not ready - it's the recovery path
        if (args.action === 'scan') {
          if (!graphService) {
            return 'Graph service not available. Ensure the graph feature is enabled in config.'
          }
          logger.log('graph-status: starting scan')
          await graphService.scan()
          const stats = await graphService.getStats()
          return `Graph scan completed:
- Files: ${stats.files}
- Symbols: ${stats.symbols}
- Edges: ${stats.edges}
- Calls: ${stats.calls}
- Ready: ${graphService.ready}`
        }

        // For status action, check graph_status table when not ready
        if (!graphService || !graphService.ready) {
          const status = ctx.graphStatusRepo.read(ctx.projectId, ctx.directory)
          if (status) {
            if (status.state === 'error' && status.message) {
              const statsMsg = status.stats
                ? `\nStats:\n- Files: ${status.stats.files}\n- Symbols: ${status.stats.symbols}\n- Edges: ${status.stats.edges}\n- Calls: ${status.stats.calls}`
                : ''
              return `Graph Status: State: error\nError: ${status.message}${statsMsg}\nReady: false\n\nRun graph-status with action "scan" to rebuild the index.`
            }
            const stateMsg = status.state === 'indexing' && status.message
              ? status.message
              : `State: ${status.state}`
            const statsMsg = status.stats
              ? `\nStats so far:\n- Files: ${status.stats.files}\n- Symbols: ${status.stats.symbols}`
              : ''
            return `Graph Status: ${stateMsg}${statsMsg}\nReady: false`
          }
          return 'Graph service is not ready. Worker may be unavailable or initialization failed.'
        }

        // Service is ready - handle status action
        try {
          const stats = await graphService.getStats()
          return `Graph Status:
- Files: ${stats.files}
- Symbols: ${stats.symbols}
- Edges: ${stats.edges}
- Calls: ${stats.calls}
- Ready: ${graphService.ready}`
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          return `Error: ${msg}`
        }
      },
    }),

    'graph-query': tool({
      description: 'Query file-level graph information (dependencies, dependents, co-changes, change impact, etc.)',
      args: {
        action: z
          .enum(['top_files', 'file_deps', 'file_dependents', 'cochanges', 'blast_radius', 'packages', 'file_symbols', 'change_impact'])
          .describe('Query type'),
        file: z.string().optional().describe('File path (relative to project root)'),
        files: z.string().optional().describe('Comma-separated file paths (for change_impact)'),
        limit: z.number().optional().default(20).describe('Maximum results'),
      },
      execute: async (args) => {
        if (!graphService || !graphService.ready) {
          // Check for error state in graph_status table
          const status = ctx.graphStatusRepo.read(ctx.projectId, ctx.directory)
          if (status?.state === 'error' && status.message) {
            return `Graph index unavailable: ${status.message}`
          }
          return 'Graph not indexed yet. Run graph-status with action "scan" first.'
        }

        try {
          switch (args.action) {
            case 'top_files': {
              const results = await graphService.getTopFiles(args.limit)
              if (results.length === 0) return 'No files found in graph.'
              return results
                .map((r) => `**${r.path}** (PageRank: ${r.pagerank.toFixed(4)}, ${r.lines} lines, ${r.symbols} symbols)`)
                .join('\n')
            }

            case 'file_deps': {
              if (!args.file) return 'file parameter required'
              const results = await graphService.getFileDependencies(args.file)
              if (results.length === 0) return `No dependencies found for ${args.file}`
              return results.map((r) => `- ${r.path} (weight: ${r.weight})`).join('\n')
            }

            case 'file_dependents': {
              if (!args.file) return 'file parameter required'
              const results = await graphService.getFileDependents(args.file)
              if (results.length === 0) return `No dependents found for ${args.file}`
              return results.map((r) => `- ${r.path} (weight: ${r.weight})`).join('\n')
            }

            case 'cochanges': {
              if (!args.file) return 'file parameter required'
              const results = await graphService.getFileCoChanges(args.file)
              if (results.length === 0) return `No co-changes found for ${args.file}`
              return results.map((r) => `- ${r.path} (count: ${r.count})`).join('\n')
            }

            case 'blast_radius': {
              if (!args.file) return 'file parameter required'
              const radius = await graphService.getFileBlastRadius(args.file)
              return `Blast radius for ${args.file}: ${radius} files`
            }

            case 'packages': {
              const limit = args.limit ?? 20
              const results = await graphService.getExternalPackages(limit)
              if (results.length === 0) return 'No external packages found.'
              return results
                .map((r) => `**${r.package}** (${r.fileCount} files, ${r.specifiers.length} specifiers)`)
                .join('\n')
            }

            case 'file_symbols': {
              if (!args.file) return 'file parameter required'
              const results = await graphService.getFileSymbols(args.file)
              if (results.length === 0) return `No symbols found in ${args.file}`
              return results
                .map((r) => `- ${r.name} (${r.kind})${r.isExported ? ' [exported]' : ''} [line ${r.line}]`)
                .join('\n')
            }

            case 'change_impact': {
              const filePaths = args.files?.split(',').map(f => f.trim()).filter(Boolean) || []
              if (filePaths.length === 0) return 'files parameter required (comma-separated paths)'
              const result = await graphService.getChangeImpact(filePaths)
              if (result.impactedFiles.length === 0) return `No impacted files found for: ${result.changedFiles.join(', ')}`
              const header = `**${result.totalAffected} files affected** by changes to ${result.changedFiles.length} file(s):\n`
              const body = result.impactedFiles
                .map(f => `- ${'  '.repeat(f.depth - 1)}${f.path} (depth: ${f.depth})`)
                .join('\n')
              return header + body
            }

            default:
              return 'Unknown action'
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          return `Error: ${msg}`
        }
      },
    }),

    'graph-symbols': tool({
      description: 'Query symbol-level graph information (find, search, signature, callers, callees, etc.)',
      args: {
        action: z
          .enum(['find', 'search', 'signature', 'callers', 'callees', 'references'])
          .describe('Query type'),
        name: z.string().optional().describe('Symbol name'),
        file: z.string().optional().describe('File path'),
        kind: z.string().optional().describe('Symbol kind filter'),
        limit: z.number().optional().default(20).describe('Maximum results'),
      },
      execute: async (args) => {
        if (!graphService || !graphService.ready) {
          // Check for error state in graph_status table
          const status = ctx.graphStatusRepo.read(ctx.projectId, ctx.directory)
          if (status?.state === 'error' && status.message) {
            return `Graph index unavailable: ${status.message}`
          }
          return 'Graph not indexed yet. Run graph-status with action "scan" first.'
        }

        try {
          switch (args.action) {
            case 'find': {
              if (!args.name) return 'name parameter required'
              const results = await graphService.findSymbols(args.name, args.limit)
              const filtered = args.kind ? results.filter(r => r.kind === args.kind) : results
              if (filtered.length === 0) return `No symbols found matching "${args.name}"`
              return filtered
                .map((r) => `**${r.name}** in ${r.path} (${r.kind})${r.isExported ? ' [exported]' : ''}`)
                .join('\n')
            }

            case 'search': {
              if (!args.name) return 'name parameter required (search query)'
              const results = await graphService.searchSymbolsFts(args.name, args.limit)
              const filtered = args.kind ? results.filter(r => r.kind === args.kind) : results
              if (filtered.length === 0) return `No symbols found matching "${args.name}"`
              return filtered
                .map((r) => `**${r.name}** in ${r.path}:${r.line} (${r.kind})${r.isExported ? ' [exported]' : ''}`)
                .join('\n')
            }

            case 'signature': {
              if (!args.name) return 'name parameter required'
              // Need path and line - for now search by name first
              const symbols = await graphService.findSymbols(args.name, 1)
              if (symbols.length === 0) return `No signature found for "${args.name}"`
              const result = await graphService.getSymbolSignature(symbols[0].path, symbols[0].line)
              if (!result) return `No signature found for "${args.name}"`
              return `**${result.path}**:${result.line}\n\`\`\`\n${result.signature}\n\`\`\``
            }

            case 'callers': {
              if (!args.name) return 'name parameter required'
              // Need path and line - for now search by name first
              const symbols = await graphService.findSymbols(args.name, 1)
              if (symbols.length === 0) return `No callers found for "${args.name}"`
              const results = await graphService.getCallers(symbols[0].path, symbols[0].line)
              if (results.length === 0) return `No callers found for "${args.name}"`
              return results
                .map((r) => `- ${r.callerName} in ${r.callerPath}:${r.callerLine} (calls at line ${r.callLine})`)
                .join('\n')
            }

            case 'callees': {
              if (!args.name) return 'name parameter required (symbol name)'
              // Need path and line - for now search by name first
              const symbols = await graphService.findSymbols(args.name, 1)
              if (symbols.length === 0) return `No symbol found matching "${args.name}"`
              const results = await graphService.getCallees(symbols[0].path, symbols[0].line)
              if (results.length === 0) return `No callees found for "${args.name}"`
              return results
                .map((r) => `- ${r.calleeName} in ${r.calleeFile}:${r.calleeLine}`)
                .join('\n')
            }

            case 'references': {
              if (!args.name) return 'name parameter required'
              const results = await graphService.getSymbolReferences(args.name, args.limit)
              if (results.length === 0) return `No references found for "${args.name}"`
              return results
                .map(r => {
                  const loc = r.line > 0 ? `:${r.line}` : ''
                  const ctx = r.context ? ` (${r.context})` : ''
                  return `- [${r.kind}] **${r.path}**${loc}${ctx}`
                })
                .join('\n')
            }

            default:
              return 'Unknown action'
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          return `Error: ${msg}`
        }
      },
    }),

    'graph-analyze': tool({
      description: 'Analyze code quality (unused exports, duplication, near-duplicates, orphan files, circular dependencies)',
      args: {
        action: z.enum(['unused_exports', 'duplication', 'near_duplicates', 'orphan_files', 'circular_deps']).describe('Analysis type'),
        file: z.string().optional().describe('File path (optional)'),
        limit: z.number().optional().default(20).describe('Maximum results'),
        threshold: z.number().optional().default(0.8).describe('Similarity threshold (for near_duplicates)'),
        includeInternalOnly: z.boolean().optional().default(false).describe('Include exports used only internally (default: false)'),
      },
      execute: async (args) => {
        if (!graphService || !graphService.ready) {
          // Check for error state in graph_status table
          const status = ctx.graphStatusRepo.read(ctx.projectId, ctx.directory)
          if (status?.state === 'error' && status.message) {
            return `Graph index unavailable: ${status.message}`
          }
          return 'Graph not indexed yet. Run graph-status with action "scan" first.'
        }

        try {
          switch (args.action) {
            case 'unused_exports': {
              const results = await graphService.getUnusedExports(args.limit, args.includeInternalOnly)
              if (results.length === 0) return 'No unused exports found.'
              return results
                .map((r) => {
                  const suffix = r.usedInternally ? ' (used internally only)' : ''
                  return `- **${r.name}** in ${r.path}:${r.line} (${r.kind})${suffix}`
                })
                .join('\n')
            }

            case 'duplication': {
              const results = await graphService.getDuplicateStructures(args.limit)
              if (results.length === 0) return 'No duplicate structures found.'
              return results
                .map(
                  (r) =>
                    `**Shape Hash**: ${r.shapeHash}\n- Kind: ${r.kind}\n- Nodes: ${r.nodeCount}\n- Members:\n${r.members
                      .map((m) => `  - ${m.path}:${m.line}`)
                      .join('\n')}`
                )
                .join('\n\n')
            }

            case 'near_duplicates': {
              const results = await graphService.getNearDuplicates(args.threshold ?? 0.8, args.limit)
              if (results.length === 0) return 'No near-duplicate code found.'
              return results
                .map(
                  (r) =>
                    `**Similarity**: ${(r.similarity * 100).toFixed(1)}%\n- A: ${r.a.path}:${r.a.line} (${r.a.name})\n- B: ${r.b.path}:${r.b.line} (${r.b.name})`
                )
                .join('\n\n')
            }

            case 'orphan_files': {
              const results = await graphService.getOrphanFiles(args.limit)
              if (results.length === 0) return 'No orphan files found.'
              return results
                .map(r => `- **${r.path}** (${r.language}, ${r.lineCount} lines, ${r.symbolCount} symbols)`)
                .join('\n')
            }

            case 'circular_deps': {
              const results = await graphService.getCircularDependencies(args.limit)
              if (results.length === 0) return 'No circular dependencies found.'
              return results
                .map((r, i) => `**Cycle ${i + 1}** (${r.length} files):\n${r.cycle.map(p => `  - ${p}`).join('\n')}`)
                .join('\n\n')
            }

            default:
              return 'Unknown action'
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          return `Error: ${msg}`
        }
      },
    }),
  }
}
