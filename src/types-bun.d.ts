// Type declarations for Bun-specific modules

declare module 'bun:worker' {
  export class Worker {
    constructor(scriptURL: string | URL, options?: WorkerOptions)
    postMessage(data: unknown, transfer?: Transferable[]): void
    terminate(): void
    onmessage: ((event: MessageEvent) => void) | null
    onmessageerror: ((event: MessageEvent) => void) | null
    onerror: ((event: ErrorEvent) => void) | null
    addEventListener(type: string, listener: EventListenerOrEventListenerObject): void
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void
  }

  interface WorkerOptions {
    name?: string
    type?: 'classic' | 'module'
    credentials?: 'omit' | 'same-origin' | 'include'
    env?: Record<string, string>
  }
}

declare module 'bun:sqlite' {
  export class Database {
    constructor(path: string, options?: { create?: boolean; readonly?: boolean })
    run(sql: string, ...params: unknown[]): void
    prepare(sql: string): Statement
    close(): void
    transaction<T extends (...args: unknown[]) => void>(fn: T): T
  }

  export class Statement {
    run(...params: unknown[]): void
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
    iterate(...params: unknown[]): IterableIterator<unknown>
  }
}
