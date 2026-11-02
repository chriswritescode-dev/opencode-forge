/**
 * Shape of the JSON Schema subset Forge's RPC contracts are written in:
 * `type`, `enum`, `properties`, `required`, `additionalProperties`, `items`,
 * `minimum`, and `minLength`.
 */
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

/** The first place a value departs from its schema: where it is and what was expected. */
export interface JsonSchemaMismatch {
  path: string
  message: string
}

/** Options for {@link findJsonSchemaMismatch}. */
export interface JsonSchemaValidationOptions {
  /**
   * Ignore `additionalProperties: false` so a payload from a newer peer that adds
   * fields still validates. Defaults to `false`, which enforces the schema strictly.
   */
  allowAdditionalProperties?: boolean
}

function findMismatch(
  schema: JsonSchemaShape,
  value: unknown,
  path: string,
  options: JsonSchemaValidationOptions,
): JsonSchemaMismatch | null {
  if (schema.enum && !schema.enum.includes(value)) {
    return { path, message: `expected one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(', ')}` }
  }

  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { path, message: 'expected an object' }
      }
      const record = value as Record<string, unknown>
      for (const key of schema.required ?? []) {
        if (!(key in record)) return { path: `${path}.${key}`, message: 'required property is missing' }
      }
      for (const [key, entry] of Object.entries(record)) {
        const childPath = `${path}.${key}`
        const child = schema.properties?.[key]
        if (child) {
          const mismatch = findMismatch(child, entry, childPath, options)
          if (mismatch) return mismatch
        } else if (schema.additionalProperties === false) {
          if (options.allowAdditionalProperties !== true) {
            return { path: childPath, message: 'additional property is not allowed' }
          }
        } else if (typeof schema.additionalProperties === 'object') {
          const mismatch = findMismatch(schema.additionalProperties, entry, childPath, options)
          if (mismatch) return mismatch
        }
      }
      return null
    }
    case 'array': {
      if (!Array.isArray(value)) return { path, message: 'expected an array' }
      if (!schema.items) return null
      for (const [index, entry] of value.entries()) {
        const mismatch = findMismatch(schema.items, entry, `${path}[${index}]`, options)
        if (mismatch) return mismatch
      }
      return null
    }
    case 'string': {
      if (typeof value !== 'string') return { path, message: 'expected a string' }
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        return { path, message: `expected at least ${schema.minLength} characters` }
      }
      return null
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isInteger(value)) return { path, message: 'expected an integer' }
      if (schema.minimum !== undefined && value < schema.minimum) return { path, message: `expected >= ${schema.minimum}` }
      return null
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return { path, message: 'expected a number' }
      if (schema.minimum !== undefined && value < schema.minimum) return { path, message: `expected >= ${schema.minimum}` }
      return null
    }
    case 'boolean': {
      if (typeof value !== 'boolean') return { path, message: 'expected a boolean' }
      return null
    }
    default:
      return null
  }
}

/**
 * Validates `value` against the JSON Schema subset Forge's RPC contracts use and
 * returns the first mismatch (its path from `$` and what was expected), or `null`
 * when the value conforms. Never throws, so callers can turn a mismatch into their
 * own error envelope.
 */
export function findJsonSchemaMismatch(
  schema: JsonSchemaShape,
  value: unknown,
  options: JsonSchemaValidationOptions = {},
): JsonSchemaMismatch | null {
  return findMismatch(schema, value, '$', options)
}
