import type { ToolContext } from '../tools/types'

export interface ProjectRegistryEntry {
  ctx: ToolContext
}

export interface ProjectRegistry {
  register(ctx: ToolContext): void
  unregister(projectId: string): void
  get(projectId: string): ToolContext | null
  findByDirectory(directory: string): ToolContext | null
  list(): ToolContext[]
  size(): number
}

const REGISTRY_KEY = Symbol.for('forge.project-registry')

let registrySingleton: ProjectRegistry | null = null

function createProjectRegistry(): ProjectRegistry {
  const entries = new Map<string, ProjectRegistryEntry>()

  return {
    register(ctx: ToolContext): void {
      entries.set(ctx.projectId, { ctx })
    },
    unregister(projectId: string): void {
      entries.delete(projectId)
    },
    get(projectId: string): ToolContext | null {
      return entries.get(projectId)?.ctx ?? null
    },
    findByDirectory(directory: string): ToolContext | null {
      for (const entry of entries.values()) {
        if (entry.ctx.directory === directory) {
          return entry.ctx
        }
      }
      return null
    },
    list(): ToolContext[] {
      return Array.from(entries.values(), (entry) => entry.ctx)
    },
    size(): number {
      return entries.size
    },
  }
}

export function getProjectRegistry(): ProjectRegistry {
  if (registrySingleton) {
    return registrySingleton
  }

  const globalRegistry = globalThis as typeof globalThis & {
    [REGISTRY_KEY]?: ProjectRegistry
  }

  if (!globalRegistry[REGISTRY_KEY]) {
    globalRegistry[REGISTRY_KEY] = createProjectRegistry()
  }

  registrySingleton = globalRegistry[REGISTRY_KEY]!
  return registrySingleton
}
