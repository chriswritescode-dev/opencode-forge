import { networkInterfaces } from 'os'
import type { PluginConfig } from '../types'

/** Default dashboard bind host. Loopback-only, preserving pre-config behavior. */
export const DEFAULT_DASHBOARD_HOST = 'localhost'
/** Default dashboard base bind port. */
export const DEFAULT_DASHBOARD_PORT = 4747

/** Explicit per-invocation overrides (CLI flags). Win over `dashboard.*` config. */
export interface DashboardBindOverrides {
  host?: string
  port?: number
}

export interface ResolvedDashboardConfig {
  host: string
  port: number
}

/** `0` is allowed and means "let the OS pick an ephemeral port". */
export function isValidDashboardPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 65535
}

/**
 * The single resolution point for the dashboard bind address. Every launch
 * surface (TUI command, `pnpm dashboard`) routes through here so a configured
 * host/port cannot be honoured by one entry point and ignored by another.
 * Precedence: explicit override > `dashboard.*` config > built-in default.
 * Blank/whitespace hosts and invalid ports are skipped, falling through to the
 * next candidate.
 */
export function resolveDashboardConfig(
  config?: PluginConfig,
  overrides: DashboardBindOverrides = {},
): ResolvedDashboardConfig {
  const host =
    [overrides.host, config?.dashboard?.host]
      .map((candidate) => (typeof candidate === 'string' ? candidate.trim() : ''))
      .find((candidate) => candidate.length > 0) ?? DEFAULT_DASHBOARD_HOST
  const port =
    [overrides.port, config?.dashboard?.port].find(isValidDashboardPort) ?? DEFAULT_DASHBOARD_PORT
  return { host, port }
}

/** Hosts that mean "all interfaces" to `Bun.serve`. */
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '*', ''])
const NAMED_LOOPBACK_HOSTS = new Set(['localhost', '::1'])

export function isWildcardHost(host: string): boolean {
  return WILDCARD_HOSTS.has(host.trim().toLowerCase())
}

/** True when the host is only reachable from the machine itself. */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase()
  if (NAMED_LOOPBACK_HOSTS.has(normalized)) return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized)
}

/**
 * First non-internal, non-link-local IPv4 address of this machine, or `null`
 * when the machine has no LAN address. Used to advertise a reachable URL when
 * the dashboard binds a wildcard address.
 */
export function resolvePrimaryLanIpv4(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      const family = String(address.family)
      if (family !== 'IPv4' && family !== '4') continue
      if (address.internal) continue
      if (address.address.startsWith('169.254.')) continue
      return address.address
    }
  }
  return null
}

function formatHostForUrl(host: string): string {
  return host.includes(':') ? `[${host}]` : host
}

export interface DashboardUrls {
  url: string
  localUrl: string
  exposed: boolean
}

/**
 * Derives the advertised and loopback URLs from the actual bind host and bound
 * port. `lanIpResolver` is injectable so URL derivation is testable without
 * depending on the host's real network interfaces.
 */
export function buildDashboardUrls(
  host: string,
  port: number,
  lanIpResolver: () => string | null = resolvePrimaryLanIpv4,
): DashboardUrls {
  const localUrl = `http://localhost:${port}`
  if (isWildcardHost(host)) {
    const lanIp = lanIpResolver()
    return {
      url: lanIp ? `http://${formatHostForUrl(lanIp)}:${port}` : localUrl,
      localUrl,
      exposed: true,
    }
  }
  const trimmed = host.trim()
  const url = `http://${formatHostForUrl(trimmed)}:${port}`
  return { url, localUrl: url, exposed: !isLoopbackHost(trimmed) }
}

/**
 * Single source of truth for the no-auth exposure warning. Rendered by every
 * launch surface (CLI stderr, TUI toast) so the wording cannot drift.
 */
export const DASHBOARD_EXPOSED_WARNING =
  'Forge dashboard is bound to a non-loopback address and has no authentication. ' +
  'Anyone who can reach this port can read every loop plan, goal, audit result, finding, and cost. ' +
  'Restrict access with a firewall or VPN.'

export interface DashboardBindingNotice {
  url: string
  /** Set only when the loopback URL differs from the advertised URL. */
  localUrl?: string
  /** Set only when the bind is exposed beyond loopback. */
  warning?: string
}

/**
 * Decides what a launch surface should communicate about a bind. Surfaces only
 * format these fields; the decision of what to show lives here.
 */
export function describeDashboardBinding(
  binding: { url: string; localUrl: string; exposed: boolean },
): DashboardBindingNotice {
  return {
    url: binding.url,
    ...(binding.localUrl !== binding.url ? { localUrl: binding.localUrl } : {}),
    ...(binding.exposed ? { warning: DASHBOARD_EXPOSED_WARNING } : {}),
  }
}
