import BetterSqlite3 from 'better-sqlite3'

class Database extends BetterSqlite3 {
  constructor(pathOrHandle) {
    super(pathOrHandle)
  }

  run(sql, ...params) {
    return this.exec(sql)
  }
}

export { Database }
export default Database
