import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  resolve: {
    alias: {
      'bun:sqlite': resolve(__dirname, './test/__shims__/bun-sqlite.mjs'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    globals: true,
  },
})
