import type { ForgeClient } from '../client/port'
import type { Logger } from '../types'

export type ToastVariant = 'info' | 'success' | 'warning' | 'error'

export interface PublishToastInput {
  client: ForgeClient
  directory: string
  logger: Logger | Console
  title: string
  message: string
  variant?: ToastVariant
  duration?: number
  /** Prefix used when logging a publish failure. Defaults to a generic Forge message. */
  logPrefix?: string
}

/**
 * Single publisher for `tui.toast.show` notifications. All toast call sites
 * route through this so the envelope shape and failure handling stay in one
 * place. Publishes with the given directory and logs (rather than swallowing)
 * any publish failure.
 */
export function publishToast(input: PublishToastInput): void {
  input.client.tui.publish({
    directory: input.directory,
    body: {
      type: 'tui.toast.show',
      properties: {
        title: input.title,
        message: input.message,
        variant: input.variant ?? 'warning',
        duration: input.duration ?? 5000,
      },
    },
  }).catch((err: unknown) => {
    input.logger.error(input.logPrefix ?? 'Forge: failed to publish toast', err)
  })
}
