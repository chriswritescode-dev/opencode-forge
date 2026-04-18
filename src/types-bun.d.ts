// Type declarations for Bun-specific modules

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
