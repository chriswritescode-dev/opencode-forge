import BetterSqlite3 from 'better-sqlite3'

class Database extends BetterSqlite3 {
  constructor(pathOrHandle) {
    super(pathOrHandle)
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
