import { createOpencodeClient } from '@opencode-ai/sdk/v2'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'

export interface CreateOpencodeClientFromServerOptions {
  serverUrl: string
  directory: string
  passwordEnv?: string
}

/**
 * Builds a Basic Auth header value for OpenCode server authentication.
 */
export function buildOpencodeBasicAuthHeader(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
}

/**
 * Sanitizes a server URL by extracting credentials and returning a clean base URL.
 */
export function sanitizeServerUrl(serverUrl: string): { baseUrl: string; password?: string } {
  const url = new URL(serverUrl)
  const password = url.password || undefined
  const cleanUrl = new URL(url.toString())
  cleanUrl.username = ''
  cleanUrl.password = ''
  return { baseUrl: cleanUrl.toString(), password }
}

/**
 * Creates an OpencodeClient from a server URL, extracting Basic Auth credentials
 * from the URL or falling back to the provided passwordEnv or OPENCODE_SERVER_PASSWORD.
 */
export function createOpencodeClientFromServer(options: CreateOpencodeClientFromServerOptions): OpencodeClient {
  const { serverUrl, directory, passwordEnv } = options
  const { baseUrl, password: urlPassword } = sanitizeServerUrl(serverUrl)
  const password = urlPassword || passwordEnv || process.env['OPENCODE_SERVER_PASSWORD']

  const clientConfig: Parameters<typeof createOpencodeClient>[0] = {
    baseUrl,
    directory,
  }

  if (password) {
    clientConfig.headers = {
      Authorization: buildOpencodeBasicAuthHeader(password),
    }
  }

  return createOpencodeClient(clientConfig)
}
