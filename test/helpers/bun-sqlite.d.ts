declare module 'bun:sqlite' {
  interface Statement {
    run(...params: unknown[]): unknown
  }
}
