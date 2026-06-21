import { readFileSync, existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const BUNDLED_PROMPTS_DIR = dirname(fileURLToPath(import.meta.url))

export function loadPrompt(segments: string[], userPromptsDir?: string): string {
  if (userPromptsDir) {
    const userPath = join(userPromptsDir, ...segments)
    if (existsSync(userPath)) {
      return readFileSync(userPath, 'utf-8').trim()
    }
  }
  return readFileSync(join(BUNDLED_PROMPTS_DIR, ...segments), 'utf-8').trim()
}
