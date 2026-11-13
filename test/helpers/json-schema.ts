import { findJsonSchemaMismatch, type JsonSchemaDefinition } from '../../src/utils/json-schema'

export type { JsonSchemaDefinition }

/** Asserts that `value` satisfies the subset of JSON Schema Forge RPC contracts use. */
export function expectMatchesJsonSchema(schema: JsonSchemaDefinition, value: unknown): void {
  const mismatch = findJsonSchemaMismatch(schema, value)
  if (mismatch) throw new Error(`JSON schema mismatch at ${mismatch.path}: ${mismatch.message}`)
}
