import type { ForgeClient } from '../client/port'
import type { Logger } from '../types'

export const TOAST_VARIANTS = ['info', 'success', 'warning', 'error'] as const

export type ToastVariant = typeof TOAST_VARIANTS[number]

export function isToastVariant(value: unknown): value is ToastVariant {
  return TOAST_VARIANTS.some((variant) => variant === value)
}

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
 * Single publisher for host TUI toast notifications. All toast call sites route
 * through this so the payload shape and failure handling stay in one place.
 * Publishes with the given directory and logs (rather than swallowing) any
 * publish failure.
 */
export function publishToast(input: PublishToastInput): void {
  input.client.toast({
    directory: input.directory,
    title: input.title,
    message: input.message,
    variant: input.variant ?? 'warning',
    duration: input.duration ?? 5000,
  }).catch((err: unknown) => {
    input.logger.error(input.logPrefix ?? 'Forge: failed to publish toast', err)
  })
}
