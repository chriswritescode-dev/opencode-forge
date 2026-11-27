import { z } from 'zod'
import { resolveConfigRelativePath } from '../install/paths'
import type { SandboxSecretConfig, SandboxSecretSubstitution } from '../types'
import { processShared } from '../utils/process-shared'

const sandboxSecretViolationActionSchema = z.enum(['block', 'block-and-log', 'block-and-terminate'])

const sandboxSecretSubstitutionSchema = z.object({
  headers: z.boolean().optional(),
  headerFields: z.array(z.string()).optional(),
  query: z.boolean().optional(),
  body: z.boolean().optional(),
})

const sandboxSecretSchema = z.object({
  env: z.string(),
  file: z.string().optional(),
  hosts: z.array(z.string()).optional(),
  vars: z.record(z.string(), z.string()).optional(),
  substitution: sandboxSecretSubstitutionSchema.optional(),
  passthrough: z.array(z.string()).optional(),
  violationAction: sandboxSecretViolationActionSchema.optional(),
  requireTlsIdentity: z.boolean().optional(),
})

const SECRET_ENTRY_RE = /^[^\s,@[\]]+$/

const SECRET_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

const secretEnvProbeSchema = z.looseObject({ env: z.string() })

const secretFileProbeSchema = z.looseObject({ env: z.string().optional(), file: z.unknown() })

const secretVarsProbeSchema = z.looseObject({ env: z.string().optional(), vars: z.unknown() })

const emptyVarsSchema = z.record(z.string(), z.unknown()).refine((vars) => Object.keys(vars).length === 0)

function trimmedEntries(entries: string[] | undefined): string[] {
  return (entries ?? []).map((entry) => entry.trim()).filter(Boolean)
}

export function resolveSandboxSecret(
  cause: unknown,
): { secret: SandboxSecretConfig } | { env: string; reason: string } {
  const envProbe = secretEnvProbeSchema.safeParse(cause)
  const rawEnv = envProbe.success ? envProbe.data.env.trim() : ''
  const parsed = sandboxSecretSchema.safeParse(cause)
  if (!parsed.success) return { env: rawEnv, reason: 'invalid definition' }
  const env = parsed.data.env.trim()
  if (!env) return { env, reason: 'missing env name' }
  if (env.includes('=')) return { env, reason: 'env name must not contain =' }
  if (env.includes(':') || !SECRET_ENTRY_RE.test(env)) {
    return { env, reason: 'env name must not contain whitespace, commas, colons, @, or brackets' }
  }
  const hosts = trimmedEntries(parsed.data.hosts)
  if (hosts.length === 0) return { env, reason: 'no allowed hosts' }
  if (hosts.some((host) => !SECRET_ENTRY_RE.test(host))) {
    return { env, reason: 'hosts entries must not contain whitespace, commas, @, or brackets' }
  }
  const substitution = parsed.data.substitution
  const headerFields = trimmedEntries(substitution?.headerFields)
  if (headerFields.length > 0 && substitution?.headers === false) {
    return { env, reason: 'substitution.headerFields requires substitution.headers' }
  }
  const passthrough = trimmedEntries(parsed.data.passthrough)
  for (const entry of [...headerFields, ...passthrough]) {
    if (!SECRET_ENTRY_RE.test(entry)) {
      return {
        env,
        reason: 'substitution.headerFields and passthrough entries must not contain whitespace, commas, @, or brackets',
      }
    }
  }
  const file = parsed.data.file?.trim()
  if (parsed.data.file !== undefined && !file) return { env, reason: 'file must not be empty' }
  const vars = parsed.data.vars
  if (vars !== undefined) {
    for (const name of Object.keys(vars)) {
      if (!SECRET_VAR_NAME_RE.test(name)) return { env, reason: 'vars names must be valid environment variable names' }
      if (name === env) return { env, reason: "vars must not redefine the secret's env" }
    }
  }
  const secret: SandboxSecretConfig = { env, hosts }
  if (file !== undefined) secret.file = file
  if (vars !== undefined && Object.keys(vars).length > 0) secret.vars = { ...vars }
  if (substitution !== undefined) {
    const resolvedSubstitution: SandboxSecretSubstitution = {}
    if (substitution.headers !== undefined) resolvedSubstitution.headers = substitution.headers
    if (headerFields.length > 0) resolvedSubstitution.headerFields = headerFields
    if (substitution.query !== undefined) resolvedSubstitution.query = substitution.query
    if (substitution.body !== undefined) resolvedSubstitution.body = substitution.body
    secret.substitution = resolvedSubstitution
  }
  if (passthrough.length > 0) secret.passthrough = passthrough
  if (parsed.data.violationAction !== undefined) secret.violationAction = parsed.data.violationAction
  if (parsed.data.requireTlsIdentity !== undefined) secret.requireTlsIdentity = parsed.data.requireTlsIdentity
  return { secret }
}

export function resolveSandboxSecretFilePath(file: string): string {
  return resolveConfigRelativePath(file)
}

export interface SandboxSecretValuesRequest {
  projectId: string
  sandbox: string
  directory: string
  names: string[]
}

export type SandboxSecretProvider = (
  request: SandboxSecretValuesRequest,
) => Promise<Record<string, string>> | Record<string, string>

export function sandboxSecretProviders(): Map<string, SandboxSecretProvider> {
  return processShared('sandbox-secret-providers.v1', () => new Map())
}

const SANDBOX_SECRET_PROVIDER_TIMEOUT_MS = 30000

const secretValuesSchema = z.record(z.string(), z.string())

export async function fetchSandboxSecretValues(
  providerId: string,
  request: SandboxSecretValuesRequest,
  timeoutMs: number = SANDBOX_SECRET_PROVIDER_TIMEOUT_MS,
): Promise<Record<string, string>> {
  const provider = sandboxSecretProviders().get(providerId)
  if (!provider) {
    throw new Error(
      `Sandbox secret provider "${providerId}" is not registered; the plugin that supplies these secrets must be loaded in this OpenCode process`,
    )
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      reject(new Error(`Sandbox secret provider "${providerId}" did not answer within ${timeoutMs}ms`))
    }, timeoutMs)
  })
  let result: unknown
  try {
    result = await Promise.race([Promise.resolve().then(() => provider(request)), timeout])
  } catch (err) {
    if (timedOut) {
      throw new Error(`Sandbox secret provider "${providerId}" did not answer within ${timeoutMs}ms`, { cause: err })
    }
    throw new Error(
      `Sandbox secret provider "${providerId}" failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  } finally {
    if (timer) clearTimeout(timer)
  }
  const parsed = secretValuesSchema.safeParse(result)
  if (!parsed.success) {
    throw new Error(`Sandbox secret provider "${providerId}" returned an invalid result`)
  }
  const missing = request.names.filter((name) => {
    const value = parsed.data[name]
    return value === undefined || value === ''
  })
  if (missing.length > 0) {
    throw new Error(`Sandbox secret provider "${providerId}" returned no value for ${missing.join(', ')}`)
  }
  const values: Record<string, string> = {}
  for (const name of request.names) values[name] = parsed.data[name]!
  return values
}

export function describeInvalidLoopSecrets(
  settings: { secrets?: unknown[]; secretProvider?: string } | undefined,
): string | undefined {
  const rawSecrets = settings?.secrets ?? []
  const seen = new Set<string>()
  for (const raw of rawSecrets) {
    const fileProbe = secretFileProbeSchema.safeParse(raw)
    if (fileProbe.success && fileProbe.data.file !== undefined) {
      const env = (fileProbe.data.env ?? '').trim()
      return `Invalid sandbox secret${env ? ` ${env}` : ''}: file is only supported in sandbox.network.secrets`
    }
    const varsProbe = secretVarsProbeSchema.safeParse(raw)
    if (varsProbe.success && varsProbe.data.vars !== undefined && !emptyVarsSchema.safeParse(varsProbe.data.vars).success) {
      const env = (varsProbe.data.env ?? '').trim()
      return `Invalid sandbox secret${env ? ` ${env}` : ''}: vars is only supported in sandbox.network.secrets`
    }
    const resolved = resolveSandboxSecret(raw)
    if ('reason' in resolved) {
      return `Invalid sandbox secret${resolved.env ? ` ${resolved.env}` : ''}: ${resolved.reason}`
    }
    const env = resolved.secret.env
    if (seen.has(env)) return `Duplicate sandbox secret ${env}`
    seen.add(env)
  }
  if (rawSecrets.length === 0) return undefined
  const providerId = settings?.secretProvider?.trim()
  if (providerId && !sandboxSecretProviders().has(providerId)) {
    return `Sandbox secret provider "${providerId}" is not registered`
  }
  return undefined
}
