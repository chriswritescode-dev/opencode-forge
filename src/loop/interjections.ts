export interface UserInterjection {
  id: number
  text: string
  at: number
}

export const MAX_QUEUED_INTERJECTIONS = 20

export interface InterjectionStore {
  enqueue(loopName: string, text: string): UserInterjection | null
  peek(loopName: string): UserInterjection[]
  remove(loopName: string, ids: number[]): void
  clear(loopName: string): void
}

export function createInterjectionStore(): InterjectionStore {
  const queues = new Map<string, UserInterjection[]>()
  let nextId = 1

  function enqueue(loopName: string, text: string): UserInterjection | null {
    const trimmed = text.trim()
    if (trimmed.length === 0) return null

    let queue = queues.get(loopName)
    if (!queue) {
      queue = []
      queues.set(loopName, queue)
    }

    const entry: UserInterjection = {
      id: nextId++,
      text: trimmed,
      at: Date.now(),
    }
    queue.push(entry)

    if (queue.length > MAX_QUEUED_INTERJECTIONS) {
      queue.shift()
    }

    return entry
  }

  function peek(loopName: string): UserInterjection[] {
    const queue = queues.get(loopName)
    return queue ? [...queue] : []
  }

  function remove(loopName: string, ids: number[]): void {
    const queue = queues.get(loopName)
    if (!queue) return
    const idSet = new Set(ids)
    const remaining = queue.filter(e => !idSet.has(e.id))
    if (remaining.length === 0) {
      queues.delete(loopName)
    } else {
      queues.set(loopName, remaining)
    }
  }

  function clear(loopName: string): void {
    queues.delete(loopName)
  }

  return { enqueue, peek, remove, clear }
}

export function formatInterjections(entries: UserInterjection[]): string {
  if (entries.length === 0) return ''

  const lines = entries.map((e, i) => `${i + 1}. ${e.text}`)

  return (
    '\n\n---\n' +
    '## User interjection (live)\n' +
    'The human supervising this loop sent the following message(s) while it was running. ' +
    'Treat them as high-priority guidance and incorporate them into your current work:\n\n' +
    lines.join('\n')
  )
}

export function extractInterjectionText(
  parts: Array<{ type: string; text?: string }>,
): string {
  return parts
    .filter(p => p.type === 'text' && typeof p.text === 'string')
    .map(p => p.text as string)
    .join('\n')
    .trim()
}

export const LOOP_PROMPT_PREFIXES = ['[Loop', '[Final', 'Post-iteration'] as const

export function isLoopGeneratedPrompt(text: string): boolean {
  const t = text.trimStart()
  return LOOP_PROMPT_PREFIXES.some(p => t.startsWith(p))
}
