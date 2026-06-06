import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')

class Database {
  #db
  #path
  constructor(pathOrHandle, options) {
    this.#path = pathOrHandle == null ? ':memory:' : pathOrHandle
    this.#db = new DatabaseSync(this.#path, {
      open: true,
      readOnly: options?.readonly ?? false,
    })
  }

  get name() { return this.#path }

  run(sql, ...params) {
    if (params.length > 0) {
      const stmt = this.#db.prepare(sql)
      if (params.length === 1 && Array.isArray(params[0])) {
        return stmt.run(...params[0])
      }
      return stmt.run(...params)
    }
    return this.#db.exec(sql)
  }

  exec(sql) {
    return this.#db.exec(sql)
  }

  prepare(sql) {
    return this.#db.prepare(sql)
  }

  transaction(fn) {
    return (...args) => {
      this.#db.exec('BEGIN')
      try {
        const result = fn(...args)
        this.#db.exec('COMMIT')
        return result
      } catch (err) {
        this.#db.exec('ROLLBACK')
        throw err
      }
    }
  }

  close() {
    return this.#db.close()
  }
}

export { Database }
export default Database
