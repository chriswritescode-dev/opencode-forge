import type { ForgeClient } from '../client/port'
import { ForgeClientError } from '../client/port'
import type { Logger } from '../types'

/**
 * Best-effort TUI navigation: try `selectSession` (with retries), fall back to
 * `tui.publish` with a `tui.session.select` event. There is no legacy/fallback
 * path — the port client is the only client.
 *
 * Used for both warp-in (navigating to a worktree session, with `workspace`)
 * and unwarp (navigating back to the host session, omitting `workspace`).
 */
export async function selectSessionBestEffort(
  client: ForgeClient,
  directory: string,
  logger: Logger | Console,
  selection: { sessionID: string; workspace?: string },
): Promise<void> {
  const maxAttempts = 3
  const backoffMs = 250

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await client.tui.selectSession({
        sessionID: selection.sessionID,
        ...(selection.workspace ? { workspace: selection.workspace } : {}),
      })
      logger.log(`[warp] select.session ok attempt=${attempt}`)
      return
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      logger.log(`[warp] select.session failed attempt=${attempt} error="${errorMsg}"`)
      if (err instanceof ForgeClientError && err.kind === 'connection') {
        logger.log(`selectSessionBestEffort: TUI connection error, will retry then fall back to publish`)
        if (attempt < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, backoffMs))
        }
      } else if (err instanceof ForgeClientError && err.kind === 'unavailable') {
        logger.log(`selectSessionBestEffort: TUI unavailable, skipping retry and falling back to publish`)
        break // Exit loop immediately to reach publish fallback
      } else {
        logger.error('selectSessionBestEffort: TUI error', err)
        break
      }
    }
  }

  // Fall back to publish-based TUI navigation
  try {
    await client.tui.publish({
      directory,
      body: {
        type: 'tui.session.select',
        properties: {
          sessionID: selection.sessionID,
          ...(selection.workspace ? { workspace: selection.workspace } : {}),
        },
      },
    })
    logger.log('[warp] select.publish ok')
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    logger.log(`[warp] select.publish failed error="${errorMsg}"`)
    if (err instanceof ForgeClientError && err.kind === 'unavailable') {
      logger.log('selectSessionBestEffort: TUI publish unavailable')
    } else {
      logger.error('selectSessionBestEffort: TUI publish error', err)
    }
  }
}
