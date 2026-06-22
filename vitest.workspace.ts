import { defineWorkspace } from 'vitest/config'
import { resolve } from 'path'

// Shim Bun's sqlite import for the Node-based suite.
const alias = {
  'bun:sqlite': resolve(__dirname, './test/__shims__/bun-sqlite.mjs'),
}

export default defineWorkspace([
  // Default Node suite: everything except the browser-DOM dashboard tests.
  {
    resolve: { alias },
    test: {
      name: 'node',
      globals: true,
      environment: 'node',
      include: ['test/**/*.test.ts'],
      exclude: ['test/dashboard/app-dom.test.ts', '**/node_modules/**'],
    },
  },
  // Browser-DOM suite for the SolidJS dashboard app: needs the client build of
  // solid-js (browser export conditions) and a DOM environment.
  {
    resolve: { alias, conditions: ['browser', 'development'] },
    test: {
      name: 'dom',
      globals: true,
      environment: 'happy-dom',
      include: ['test/dashboard/app-dom.test.ts'],
      server: { deps: { inline: [/solid-js/] } },
    },
  },
])
