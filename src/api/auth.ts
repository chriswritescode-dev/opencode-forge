import { forbidden, unauthorized } from './errors'

export interface AuthConfig {
  password?: string // from OPENCODE_SERVER_PASSWORD
  localhostOnly: boolean // true if host is 127.0.0.1 or ::1
}

export function parseBasicAuth(header: string | null): { password: string } | null {
  if (!header) return null

  if (!header.startsWith('Basic ')) {
    return null
  }

  try {
    const decoded = atob(header.slice(6))
    const colonIndex = decoded.indexOf(':')
    if (colonIndex === -1) {
      return null
    }
    const password = decoded.slice(colonIndex + 1)
    return { password }
  } catch {
    return null
  }
}

export function authenticate(req: Request, cfg: AuthConfig): void | never {
  const authHeader = req.headers.get('Authorization')
  const parsed = parseBasicAuth(authHeader)

  // If password is configured, require it
  if (cfg.password) {
    if (!parsed) {
      throw unauthorized()
    }

    // Constant-time comparison where possible
    const expected = cfg.password
    const provided = parsed.password

    if (expected.length !== provided.length) {
      throw unauthorized()
    }

    // Simple constant-time comparison
    let diff = 0
    for (let i = 0; i < expected.length; i++) {
      diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i)
    }
    if (diff !== 0) {
      throw unauthorized()
    }
  } else {
    // No password configured
    if (!cfg.localhostOnly) {
      // Defensive: should be caught at server start
      throw forbidden('server requires password but none configured')
    }
    // localhost-only mode with no password: pass through
  }
}
