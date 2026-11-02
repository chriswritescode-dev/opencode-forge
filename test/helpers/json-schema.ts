import { findJsonSchemaMismatch, type JsonSchemaShape } from '../../src/utils/json-schema'

export type { JsonSchemaShape }

/** Asserts that `value` satisfies the subset of JSON Schema Forge RPC contracts use. */
export function expectMatchesJsonSchema(schema: JsonSchemaShape, value: unknown): void {
  const mismatch = findJsonSchemaMismatch(schema, value)
  if (mismatch) throw new Error(`JSON schema mismatch at ${mismatch.path}: ${mismatch.message}`)
}
