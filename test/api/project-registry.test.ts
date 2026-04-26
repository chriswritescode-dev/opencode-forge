import { beforeEach, describe, expect, test } from 'bun:test'
import { getProjectRegistry } from '../../src/api/project-registry'
import type { ToolContext } from '../../src/tools/types'

function makeCtx(projectId: string, directory: string): ToolContext {
  return {
    projectId,
    directory,
  } as unknown as ToolContext
}

describe('project registry', () => {
  beforeEach(() => {
    const registry = getProjectRegistry()
    for (const ctx of registry.list()) {
      registry.unregister(ctx.projectId)
    }
  })

  test('empty registry returns nulls and empty list', () => {
    const registry = getProjectRegistry()
    expect(registry.get('missing')).toBeNull()
    expect(registry.findByDirectory('/missing')).toBeNull()
    expect(registry.list()).toEqual([])
    expect(registry.size()).toBe(0)
  })

  test('register one project and retrieve by id and directory', () => {
    const registry = getProjectRegistry()
    const ctx = makeCtx('project-a', '/work/a')
    registry.register(ctx)

    expect(registry.get('project-a')).toBe(ctx)
    expect(registry.findByDirectory('/work/a')).toBe(ctx)
    expect(registry.list()).toEqual([ctx])
    expect(registry.size()).toBe(1)
  })

  test('register two projects and retrieve both', () => {
    const registry = getProjectRegistry()
    const a = makeCtx('project-a', '/work/a')
    const b = makeCtx('project-b', '/work/b')
    registry.register(a)
    registry.register(b)

    expect(registry.get('project-a')).toBe(a)
    expect(registry.get('project-b')).toBe(b)
    expect(registry.findByDirectory('/work/a')).toBe(a)
    expect(registry.findByDirectory('/work/b')).toBe(b)
    expect(registry.size()).toBe(2)
  })

  test('re-register same projectId overwrites entry', () => {
    const registry = getProjectRegistry()
    const first = makeCtx('project-a', '/work/a')
    const second = makeCtx('project-a', '/work/a-2')
    registry.register(first)
    registry.register(second)

    expect(registry.get('project-a')).toBe(second)
    expect(registry.findByDirectory('/work/a')).toBeNull()
    expect(registry.findByDirectory('/work/a-2')).toBe(second)
    expect(registry.size()).toBe(1)
  })

  test('unregister removes entry', () => {
    const registry = getProjectRegistry()
    const ctx = makeCtx('project-a', '/work/a')
    registry.register(ctx)
    registry.unregister('project-a')

    expect(registry.get('project-a')).toBeNull()
    expect(registry.findByDirectory('/work/a')).toBeNull()
    expect(registry.size()).toBe(0)
  })

  test('getProjectRegistry returns same instance', () => {
    const first = getProjectRegistry()
    const second = getProjectRegistry()
    expect(first).toBe(second)
  })
})
