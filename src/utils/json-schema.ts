import { z } from 'zod'

export interface JsonObject {
  [key: string]: JsonValue
}

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject

export interface JsonSchemaDefinition {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean'
  enum?: ReadonlyArray<JsonValue>
  properties?: Record<string, JsonSchemaDefinition>
  required?: ReadonlyArray<string>
  additionalProperties?: boolean | JsonSchemaDefinition
  items?: JsonSchemaDefinition
  minimum?: number
  minLength?: number
}

export interface JsonSchemaMismatch {
  path: string
  message: string
}

export interface JsonSchemaValidationOptions {
  allowAdditionalProperties?: boolean
}

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
)

const jsonObjectSchema = z.record(z.string(), jsonValueSchema)

function findMismatch(
  schema: JsonSchemaDefinition,
  value: JsonValue,
  path: string,
  options: JsonSchemaValidationOptions,
): JsonSchemaMismatch | null {
  if (schema.enum && !schema.enum.includes(value)) {
    return { path, message: `expected one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(', ')}` }
  }

  switch (schema.type) {
    case 'object': {
      const record = jsonObjectSchema.safeParse(value)
      if (!record.success) {
        return { path, message: 'expected an object' }
      }
      for (const key of schema.required ?? []) {
        if (!(key in record.data)) return { path: `${path}.${key}`, message: 'required property is missing' }
      }
      for (const [key, entry] of Object.entries(record.data)) {
        const childPath = `${path}.${key}`
        const child = schema.properties?.[key]
        if (child) {
          const mismatch = findMismatch(child, entry, childPath, options)
          if (mismatch) return mismatch
        } else if (schema.additionalProperties === false) {
          if (options.allowAdditionalProperties !== true) {
            return { path: childPath, message: 'additional property is not allowed' }
          }
        } else if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
          const mismatch = findMismatch(schema.additionalProperties, entry, childPath, options)
          if (mismatch) return mismatch
        }
      }
      return null
    }
    case 'array': {
      const entries = z.array(jsonValueSchema).safeParse(value)
      if (!entries.success) return { path, message: 'expected an array' }
      if (!schema.items) return null
      for (const [index, entry] of entries.data.entries()) {
        const mismatch = findMismatch(schema.items, entry, `${path}[${index}]`, options)
        if (mismatch) return mismatch
      }
      return null
    }
    case 'string': {
      const text = z.string().safeParse(value)
      if (!text.success) return { path, message: 'expected a string' }
      if (schema.minLength !== undefined && text.data.length < schema.minLength) {
        return { path, message: `expected at least ${schema.minLength} characters` }
      }
      return null
    }
    case 'integer': {
      const integer = z.number().int().safeParse(value)
      if (!integer.success) return { path, message: 'expected an integer' }
      if (schema.minimum !== undefined && integer.data < schema.minimum) return { path, message: `expected >= ${schema.minimum}` }
      return null
    }
    case 'number': {
      const number = z.number().safeParse(value)
      if (!number.success) return { path, message: 'expected a number' }
      if (schema.minimum !== undefined && number.data < schema.minimum) return { path, message: `expected >= ${schema.minimum}` }
      return null
    }
    case 'boolean': {
      if (!z.boolean().safeParse(value).success) return { path, message: 'expected a boolean' }
      return null
    }
    default:
      return null
  }
}

export function findJsonSchemaMismatch(
  schema: JsonSchemaDefinition,
  value: JsonValue,
  options: JsonSchemaValidationOptions = {},
): JsonSchemaMismatch | null {
  return findMismatch(schema, value, '$', options)
}
