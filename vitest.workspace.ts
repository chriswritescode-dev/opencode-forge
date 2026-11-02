import { defineWorkspace } from 'vitest/config'
import { resolve } from 'path'

// Shim Bun's sqlite import for the Node-based suite.
const alias = {
  'bun:sqlite': resolve(__dirname, './test/__shims__/bun-sqlite.mjs'),
}

export default defineWorkspace([
  {
    resolve: { alias },
    test: {
      name: 'node',
      globals: true,
      environment: 'node',
      include: ['test/**/*.test.ts'],
      exclude: ['**/node_modules/**'],
    },
  },
])
