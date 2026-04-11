import { describe, test, expect, mock } from 'bun:test'
import { createGraphCommandEventHook } from '../src/hooks/graph-command'
import type { GraphService } from '../src/graph/service'

describe('Graph command event hook', () => {
  const mockLogger = {
    log: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  }

  const createMockGraphService = (): GraphService => {
    const scanMock = mock(async () => {})
    return {
      scan: scanMock,
      ready: true,
      close: mock(async () => {}),
      getStats: mock(async () => ({ files: 0, symbols: 0, edges: 0, calls: 0 })),
      getTopFiles: mock(async () => []),
      getFileDependents: mock(async () => []),
      getFileDependencies: mock(async () => []),
      getFileCoChanges: mock(async () => []),
      getFileBlastRadius: mock(async () => 0),
      getFileSymbols: mock(async () => []),
      findSymbols: mock(async () => []),
      searchSymbolsFts: mock(async () => []),
      getSymbolSignature: mock(async () => null),
      getCallers: mock(async () => []),
      getCallees: mock(async () => []),
      getUnusedExports: mock(async () => []),
      getDuplicateStructures: mock(async () => []),
      getNearDuplicates: mock(async () => []),
      getExternalPackages: mock(async () => []),
      render: mock(async () => ({ content: '', paths: [] })),
      onFileChanged: mock(() => {}),
    } as unknown as GraphService
  }

  describe('tui.command.execute event handling', () => {
    test('should call graphService.scan() when receiving graph.scan command', async () => {
      const mockService = createMockGraphService()
      const hook = createGraphCommandEventHook(mockService, mockLogger)
      
      await hook({
        event: {
          type: 'tui.command.execute',
          properties: {
            command: 'graph.scan',
          },
        },
      })
      
      expect(mockService.scan).toHaveBeenCalledTimes(1)
    })

    test('should not call graphService.scan() for unrelated commands', async () => {
      const mockService = createMockGraphService()
      const hook = createGraphCommandEventHook(mockService, mockLogger)
      
      await hook({
        event: {
          type: 'tui.command.execute',
          properties: {
            command: 'session.list',
          },
        },
      })
      
      expect(mockService.scan).not.toHaveBeenCalled()
    })

    test('should not call graphService.scan() when graph service is null', async () => {
      const localMockLogger = {
        log: mock(() => {}),
        error: mock(() => {}),
        debug: mock(() => {}),
      }
      const hook = createGraphCommandEventHook(null, localMockLogger)
      
      await hook({
        event: {
          type: 'tui.command.execute',
          properties: {
            command: 'graph.scan',
          },
        },
      })
      
      expect(localMockLogger.log).toHaveBeenCalledWith(
        'Graph scan command received but graph service is not available'
      )
    })

    test('should ignore non-tui.command.execute events', async () => {
      const mockService = createMockGraphService()
      const hook = createGraphCommandEventHook(mockService, mockLogger)
      
      await hook({
        event: {
          type: 'server.instance.disposed',
          properties: {},
        },
      })
      
      expect(mockService.scan).not.toHaveBeenCalled()
    })

    test('should throw error when graph.scan command fails', async () => {
      const mockService = createMockGraphService()
      mockService.scan = mock(async () => {
        throw new Error('Scan failed')
      })
      const hook = createGraphCommandEventHook(mockService, mockLogger)
      
      const promise = hook({
        event: {
          type: 'tui.command.execute',
          properties: {
            command: 'graph.scan',
          },
        },
      })
      
      await expect(promise).rejects.toThrow('Graph scan failed: Scan failed')
      expect(mockLogger.error).toHaveBeenCalled()
    })

    test('should handle missing properties gracefully', async () => {
      const mockService = createMockGraphService()
      const hook = createGraphCommandEventHook(mockService, mockLogger)
      
      await hook({
        event: {
          type: 'tui.command.execute',
          properties: undefined,
        },
      })
      
      expect(mockService.scan).not.toHaveBeenCalled()
    })

    test('should handle missing command property gracefully', async () => {
      const mockService = createMockGraphService()
      const hook = createGraphCommandEventHook(mockService, mockLogger)
      
      await hook({
        event: {
          type: 'tui.command.execute',
          properties: {},
        },
      })
      
      expect(mockService.scan).not.toHaveBeenCalled()
    })
  })
})
