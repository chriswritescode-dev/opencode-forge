import { z } from 'zod'
import type { MacosShare } from './macos-shares'
import type { SandboxState } from './runtime'

export const SPACESD_GUEST_PORT = 3211

const lumeVmDetailsSchema = z.looseObject({
  name: z.string().min(1),
  status: z.string().min(1),
  cpuCount: z.number().optional(),
  memorySize: z.number().optional(),
  forwards: z.record(z.string(), z.number()).optional(),
})

const lumeVmDetailsListSchema = z.array(lumeVmDetailsSchema)

const lumeErrorMessageSchema = z.looseObject({ message: z.string() })

const jsonValueSchema = z.json()

export interface LumeVmDetails {
  name: string
  status: string
  cpuCount?: number
  memorySize?: number
  forwards?: Record<string, number>
}

export interface LumeRunBody {
  noDisplay: true
  vnc: 'disabled'
  network: string
  forwards: number[]
  sharedDirectories: Array<{ hostPath: string; readOnly: boolean; tag: string }>
}

interface LumeCloneBody {
  name: string
  newName: string
}

type LumeJsonBody = LumeRunBody | LumeCloneBody

export class LumeRequestError extends Error {
  readonly status?: number

  constructor(message: string, options?: { status?: number; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'LumeRequestError'
    this.status = options?.status
  }
}

export function buildLumeRunBody(shares: MacosShare[], gatewaySocket: string): LumeRunBody {
  return {
    noDisplay: true,
    vnc: 'disabled',
    network: `gateway:${gatewaySocket}`,
    forwards: [SPACESD_GUEST_PORT],
    sharedDirectories: shares.map((share) => ({
      hostPath: share.hostDir,
      readOnly: share.readOnly,
      tag: share.tag,
    })),
  }
}

export function mapLumeVmState(details: LumeVmDetails | null): SandboxState {
  if (!details) return 'missing'
  const status = details.status.toLowerCase()
  if (status === 'running') {
    const port = details.forwards?.[String(SPACESD_GUEST_PORT)]
    if (port === undefined) return 'transient'
    return Number.isInteger(port) && port > 0 ? 'running' : 'transient'
  }
  if (status === 'stopped') return 'stopped'
  if (
    status === 'provisioning' ||
    status === 'provisioning (stale)' ||
    status === 'pulling' ||
    status === 'pending'
  ) {
    return 'transient'
  }
  return 'unknown'
}

export function spacesdUrlFromDetails(details: LumeVmDetails | null): string | null {
  const port = details?.forwards?.[String(SPACESD_GUEST_PORT)]
  if (port === undefined || !Number.isInteger(port) || port <= 0) return null
  return `http://127.0.0.1:${port}`
}

export function createLumeClient(input: {
  baseUrl: string
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}) {
  const baseUrl = input.baseUrl.replace(/\/+$/, '')
  const fetchImpl = input.fetch ?? globalThis.fetch
  const timeoutMs = input.timeoutMs ?? 10_000

  function isSuccess(status: number): boolean {
    return status >= 200 && status < 300
  }

  async function send(
    path: string,
    method: string,
    body: LumeJsonBody | undefined,
    isAccepted: (status: number) => boolean,
  ): Promise<Response> {
    const url = `${baseUrl}${path}`
    let response: Response
    try {
      response = await fetchImpl(url, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw new LumeRequestError(`Lume request failed: ${method} ${url}`, { cause: error })
    }
    if (!isAccepted(response.status)) {
      const detail = await readErrorMessage(response)
      const suffix = detail ? `: ${detail}` : ''
      throw new LumeRequestError(`Lume request failed: ${method} ${url} (${response.status})${suffix}`, {
        status: response.status,
      })
    }
    return response
  }

  async function readJson(response: Response, context: string) {
    try {
      return jsonValueSchema.parse(await response.json())
    } catch (error) {
      throw new LumeRequestError(`Lume returned invalid JSON for ${context}`, { cause: error })
    }
  }

  return {
    async getVm(name: string): Promise<LumeVmDetails | null> {
      const path = `/lume/vms/${encodeURIComponent(name)}`
      const response = await send(path, 'GET', undefined, (status) => isSuccess(status) || status === 404)
      if (response.status === 404) return null
      const result = lumeVmDetailsSchema.safeParse(await readJson(response, `GET ${path}`))
      if (!result.success) {
        throw new LumeRequestError(`Lume returned an invalid VM payload for GET ${path}`)
      }
      return result.data
    },

    async listVms(): Promise<LumeVmDetails[]> {
      const response = await send('/lume/vms', 'GET', undefined, isSuccess)
      const result = lumeVmDetailsListSchema.safeParse(await readJson(response, 'GET /lume/vms'))
      if (!result.success) {
        throw new LumeRequestError('Lume returned an invalid VM list payload')
      }
      return result.data
    },

    async cloneVm(source: string, target: string): Promise<void> {
      await send('/lume/vms/clone', 'POST', { name: source, newName: target }, isSuccess)
    },

    async runVm(name: string, body: LumeRunBody): Promise<void> {
      const path = `/lume/vms/${encodeURIComponent(name)}/run`
      await send(path, 'POST', body, (status) => status === 200 || status === 202)
    },

    async stopVm(name: string): Promise<void> {
      await send(`/lume/vms/${encodeURIComponent(name)}/stop`, 'POST', undefined, isSuccess)
    },
  }
}

async function readErrorMessage(response: Response): Promise<string | undefined> {
  try {
    const text = await response.text()
    if (!text.trim()) return undefined
    const result = lumeErrorMessageSchema.safeParse(JSON.parse(text))
    return result.success ? result.data.message : undefined
  } catch {
    return undefined
  }
}
