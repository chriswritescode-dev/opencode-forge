import { tool } from '@opencode-ai/plugin'
import type { ToolContext } from './types'
import type { GraphService } from '../graph/service'

const z = tool.schema

interface GraphToolContext {
  graphService: GraphService | null
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
        if (!graphService) {
          return 'Graph service not available. Ensure the graph feature is enabled in config.'
        }

        try {
          switch (args.action) {
            case 'status': {
              if (!graphService.ready) {
                return 'Graph service is not ready. Worker may be unavailable or initialization failed.'
              }
              const stats = await graphService.getStats()
              return `Graph Status:
- Files: ${stats.files}
- Symbols: ${stats.symbols}
- Edges: ${stats.edges}
- Calls: ${stats.calls}
- Ready: ${graphService.ready}`
            }

            case 'scan': {
              if (!graphService.ready) {
                return 'Graph service is not ready. Cannot perform scan.'
              }
              logger.log('graph-status: starting scan')
              await graphService.scan()
              const stats = await graphService.getStats()
              return `Graph scan complete. Stats:
- Files: ${stats.files}
- Symbols: ${stats.symbols}
- Edges: ${stats.edges}`
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

    'graph-query': tool({
      description: 'Query file-level graph information (dependencies, dependents, co-changes, etc.)',
      args: {
        action: z
          .enum(['top_files', 'file_deps', 'file_dependents', 'cochanges', 'blast_radius', 'packages', 'file_symbols'])
          .describe('Query type'),
        file: z.string().optional().describe('File path (relative to project root)'),
        limit: z.number().optional().default(20).describe('Maximum results'),
      },
      execute: async (args) => {
        if (!graphService || !graphService.ready) {
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
      description: 'Query symbol-level graph information (find, search, callers, callees, etc.)',
      args: {
        action: z.enum(['find', 'search', 'signature', 'callers', 'callees']).describe('Query type'),
        name: z.string().optional().describe('Symbol name'),
        file: z.string().optional().describe('File path'),
        kind: z.string().optional().describe('Symbol kind filter'),
        limit: z.number().optional().default(20).describe('Maximum results'),
      },
      execute: async (args) => {
        if (!graphService || !graphService.ready) {
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
      description: 'Analyze code quality (unused exports, duplication, near-duplicates)',
      args: {
        action: z.enum(['unused_exports', 'duplication', 'near_duplicates']).describe('Analysis type'),
        file: z.string().optional().describe('File path (optional)'),
        limit: z.number().optional().default(20).describe('Maximum results'),
        threshold: z.number().optional().default(0.8).describe('Similarity threshold (for near_duplicates)'),
      },
      execute: async (args) => {
        if (!graphService || !graphService.ready) {
          return 'Graph not indexed yet. Run graph-status with action "scan" first.'
        }

        try {
          switch (args.action) {
            case 'unused_exports': {
              const results = await graphService.getUnusedExports(args.limit)
              if (results.length === 0) return 'No unused exports found.'
              return results
                .map((r) => `- **${r.name}** in ${r.path}:${r.line} (${r.kind})`)
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
