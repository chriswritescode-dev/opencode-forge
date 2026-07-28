import { networkInterfaces, type NetworkInterfaceInfo } from 'os'
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
  /**
   * Human-readable notes about candidates that were present but unusable.
   * Every launch surface renders these, so a silently-dropped `dashboard.port`
   * is reported identically by the CLI and the TUI.
   */
  warnings: string[]
}

/** `0` is allowed and means "let the OS pick an ephemeral port". */
function isValidDashboardPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 65535
}

function describeValue(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value)
}

interface BindCandidate<T> {
  /** How the value is named to the operator, e.g. `dashboard.port`. */
  label: string
  value: T | undefined
}

function pickHost(candidates: BindCandidate<string>[], warnings: string[]): string | undefined {
  for (const { label, value } of candidates) {
    if (value === undefined) continue
    if (typeof value !== 'string') {
      warnings.push(
        `Ignoring ${label} ${describeValue(value)}: expected a hostname or IP string.`
      )
      continue
    }
    const trimmed = value.trim()
    if (trimmed.length > 0) return trimmed
  }
  return undefined
}

function pickPort(candidates: BindCandidate<number>[], warnings: string[]): number | undefined {
  for (const { label, value } of candidates) {
    if (value === undefined) continue
    if (!isValidDashboardPort(value)) {
      warnings.push(
        `Ignoring ${label} ${describeValue(value)}: expected an integer between 0 and 65535.`
      )
      continue
    }
    return value
  }
  return undefined
}

/**
 * The single resolution point for the dashboard bind address. Every launch
 * surface (TUI command, `pnpm dashboard`) routes through here so a configured
 * host/port cannot be honoured by one entry point and ignored by another.
 * Precedence: explicit override > `dashboard.*` config > built-in default.
 * Blank/whitespace hosts fall through silently because a blank value is a
 * documented way to request the default; unusable values fall through with a
 * warning so they are never dropped without a trace.
 */
export function resolveDashboardConfig(
  config?: PluginConfig,
  overrides: DashboardBindOverrides = {},
): ResolvedDashboardConfig {
  const warnings: string[] = []
  const host =
    pickHost(
      [
        { label: 'host override', value: overrides.host },
        { label: 'dashboard.host', value: config?.dashboard?.host },
      ],
      warnings
    ) ?? DEFAULT_DASHBOARD_HOST
  const port =
    pickPort(
      [
        { label: 'port override', value: overrides.port },
        { label: 'dashboard.port', value: config?.dashboard?.port },
      ],
      warnings
    ) ?? DEFAULT_DASHBOARD_PORT
  return { host, port, warnings }
}

/**
 * Hosts that bind every interface. Verified against Bun: `''` binds loopback
 * only and `'*'` fails to bind at all, so neither belongs here.
 */
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::'])
const NAMED_LOOPBACK_HOSTS = new Set(['localhost', '::1'])

function isWildcardHost(host: string): boolean {
  return WILDCARD_HOSTS.has(host.trim().toLowerCase())
}

/** True when the host is only reachable from the machine itself. */
function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase()
  if (NAMED_LOOPBACK_HOSTS.has(normalized)) return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized)
}

/**
 * Interface-name prefixes for virtual, tunnel, and container adapters. These are
 * deprioritised rather than excluded: for a VPN-only setup the tunnel address is
 * the sole reachable one.
 */
const VIRTUAL_INTERFACE_PREFIXES = [
  'utun', 'tun', 'tap', 'docker', 'br-', 'bridge', 'veth', 'vmnet', 'vboxnet', 'awdl', 'llw',
]

function isRfc1918Ipv4(address: string): boolean {
  const [a, b] = address.split('.').map(Number)
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return a === 192 && b === 168
}

/**
 * Best-guess LAN IPv4 address of this machine, or `null` when it has none.
 * Used to advertise a reachable URL for a wildcard bind.
 *
 * Candidates are ranked physical-private > physical-public > virtual-private >
 * virtual-public and tie-broken by interface name, so a machine with several
 * addresses always advertises the same one instead of whichever the OS listed
 * first. Interface naming is a heuristic and cannot be authoritative: an
 * operator whose correct address is not chosen should set `dashboard.host`
 * explicitly.
 */
export function resolvePrimaryLanIpv4(
  interfaces: Record<string, NetworkInterfaceInfo[] | undefined> = networkInterfaces()
): string | null {
  let best: { score: number; name: string; address: string } | null = null
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const address of addresses ?? []) {
      const family = String(address.family)
      if (family !== 'IPv4' && family !== '4') continue
      if (address.internal) continue
      if (address.address.startsWith('169.254.')) continue
      const virtual = VIRTUAL_INTERFACE_PREFIXES.some((prefix) => name.startsWith(prefix))
      const score = (virtual ? 0 : 2) + (isRfc1918Ipv4(address.address) ? 1 : 0)
      if (!best || score > best.score || (score === best.score && name < best.name)) {
        best = { score, name, address: address.address }
      }
    }
  }
  return best?.address ?? null
}

function formatHostForUrl(host: string): string {
  return host.includes(':') ? `[${host}]` : host
}

export interface DashboardUrls {
  /** URL to advertise. The machine's LAN address when bound to a wildcard host. */
  url: string
  /** URL reachable from this machine's loopback. Equals `url` unless bound to a wildcard. */
  localUrl: string
  /** True when the bind is reachable beyond loopback. */
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
  // Always literal `localhost`: this is the loopback URL for display, not the
  // configured bind host, so it must not follow DEFAULT_DASHBOARD_HOST.
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
export function describeDashboardBinding(binding: DashboardUrls): DashboardBindingNotice {
  return {
    url: binding.url,
    ...(binding.localUrl !== binding.url ? { localUrl: binding.localUrl } : {}),
    ...(binding.exposed ? { warning: DASHBOARD_EXPOSED_WARNING } : {}),
  }
}
