export interface JsonSchemaShape {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean'
  enum?: ReadonlyArray<unknown>
  properties?: Record<string, JsonSchemaShape>
  required?: ReadonlyArray<string>
  additionalProperties?: boolean | JsonSchemaShape
  items?: JsonSchemaShape
  minimum?: number
  minLength?: number
}

function fail(path: string, message: string): never {
  throw new Error(`JSON schema mismatch at ${path}: ${message}`)
}

function expectMatches(schema: JsonSchemaShape, value: unknown, path: string): void {
  if (schema.enum && !schema.enum.includes(value)) {
    fail(path, `expected one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(', ')}`)
  }

  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        fail(path, 'expected an object')
      }
      const record = value as Record<string, unknown>
      for (const key of schema.required ?? []) {
        if (!(key in record)) fail(`${path}.${key}`, 'required property is missing')
      }
      for (const [key, entry] of Object.entries(record)) {
        const childPath = `${path}.${key}`
        const child = schema.properties?.[key]
        if (child) {
          expectMatches(child, entry, childPath)
        } else if (schema.additionalProperties === false) {
          fail(childPath, 'additional property is not allowed')
        } else if (typeof schema.additionalProperties === 'object') {
          expectMatches(schema.additionalProperties, entry, childPath)
        }
      }
      return
    }
    case 'array': {
      if (!Array.isArray(value)) fail(path, 'expected an array')
      if (schema.items) {
        value.forEach((entry, index) => expectMatches(schema.items as JsonSchemaShape, entry, `${path}[${index}]`))
      }
      return
    }
    case 'string': {
      if (typeof value !== 'string') fail(path, 'expected a string')
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        fail(path, `expected at least ${schema.minLength} characters`)
      }
      return
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isInteger(value)) fail(path, 'expected an integer')
      if (schema.minimum !== undefined && value < schema.minimum) fail(path, `expected >= ${schema.minimum}`)
      return
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'expected a number')
      if (schema.minimum !== undefined && value < schema.minimum) fail(path, `expected >= ${schema.minimum}`)
      return
    }
    case 'boolean': {
      if (typeof value !== 'boolean') fail(path, 'expected a boolean')
      return
    }
    default:
      return
  }
}

/** Asserts that `value` satisfies the subset of JSON Schema Forge RPC contracts use. */
export function expectMatchesJsonSchema(schema: JsonSchemaShape, value: unknown): void {
  expectMatches(schema, value, '$')
}
