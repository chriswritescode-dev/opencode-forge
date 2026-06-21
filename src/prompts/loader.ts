import { readFileSync, existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

export const BUNDLED_PROMPTS_DIR = dirname(fileURLToPath(import.meta.url))

const promptCache = new Map<string, string>()

function resolvePromptPath(segments: string[], userPromptsDir?: string): string {
  if (userPromptsDir) {
    const userPath = join(userPromptsDir, ...segments)
    if (existsSync(userPath)) return userPath
  }
  return join(BUNDLED_PROMPTS_DIR, ...segments)
}

export function loadPrompt(segments: string[], userPromptsDir?: string): string {
  const resolved = resolvePromptPath(segments, userPromptsDir)
  const cached = promptCache.get(resolved)
  if (cached !== undefined) return cached
  const content = readFileSync(resolved, 'utf-8').trim()
  promptCache.set(resolved, content)
  return content
}
