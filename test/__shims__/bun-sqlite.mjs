import BetterSqlite3 from 'better-sqlite3'

class Database extends BetterSqlite3 {
  /**
   * @param {string | Buffer} pathOrHandle  Database file path.
   * @param {{ readonly?: boolean, create?: boolean, readwrite?: boolean } | undefined} options
   *        Bun-compatible options object, translated to better-sqlite3 semantics.
   *
   * bun:sqlite derives SQLite open flags from these options, so an options object that implies
   * neither READONLY nor READWRITE (for example `{ create: false }`) is rejected at runtime.
   * better-sqlite3 has unrelated option semantics and would silently accept it, so the same
   * validation is reproduced here; otherwise a call that always throws under Bun passes in tests.
   */
  constructor(pathOrHandle, options) {
    if (options !== null && typeof options === 'object') {
      const readonly = options.readonly === true
      const readwrite = options.readwrite === true || options.create === true
      if (!readonly && !readwrite) {
        throw new Error('flags must include SQLITE_OPEN_READONLY or SQLITE_OPEN_READWRITE')
      }
      super(pathOrHandle, { readonly, fileMustExist: options.create !== true })
      return
    }
    super(pathOrHandle, options)
  }

  run(sql, ...params) {
    // If parameters are provided, use prepare for parameterized queries
    if (params.length > 0) {
      const stmt = this.prepare(sql)
      return stmt.run(...params)
    }
    // Otherwise use exec for multi-statement SQL (CREATE TABLE, etc.)
    return this.exec(sql)
  }
}

export { Database }
export default Database
