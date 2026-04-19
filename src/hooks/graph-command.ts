/**
 * Graph command event hook for handling TUI command events.
 * 
 * This module provides an event hook that listens for `tui.command.execute`
 * events and routes graph-related commands to the graph service.
 * This replaces the invalid shared-module bridge approach.
 */

import type { GraphService } from '../graph'
import type { Logger } from '../types'

export interface GraphCommandHookInput {
  event: {
    type: string
    properties?: Record<string, unknown>
  }
}

/**
 * Creates an event hook that handles TUI command execute events.
 * 
 * When a `tui.command.execute` event is received with the `graph.scan` command,
 * this hook calls the graph service's scan method.
 * 
 * @param graphService - The graph service instance (may be null if disabled)
 * @param logger - Logger for diagnostic output
 * @returns An async event handler function
 */
export function createGraphCommandEventHook(
  graphService: GraphService | null,
  logger: Logger
): (input: GraphCommandHookInput) => Promise<void> {
  const GRAPH_SCAN_COMMAND = 'graph.scan'
  
  return async (input: GraphCommandHookInput): Promise<void> => {
    const { event } = input
    
    // Only handle tui.command.execute events
    if (event.type !== 'tui.command.execute') {
      return
    }
    
    const properties = event.properties
    if (!properties || typeof properties !== 'object') {
      return
    }
    
    const command = properties.command as string | undefined
    if (!command) {
      return
    }
    
    // Only handle graph.scan commands
    if (command !== GRAPH_SCAN_COMMAND) {
      return
    }
    
    // Check if graph service is available
    if (!graphService) {
      logger.log('Graph scan command received but graph service is not available')
      return
    }
    
    try {
      logger.debug('Graph scan command received, initiating scan')
      await graphService.scan()
      logger.log('Graph scan completed successfully')
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      logger.error('Graph scan command failed', err)
      const error = new Error(`Graph scan failed: ${errorMessage}`)
      error.cause = err
      throw error
    }
  }
}
