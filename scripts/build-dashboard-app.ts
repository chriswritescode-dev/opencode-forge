#!/usr/bin/env bun
import { writeFileSync } from 'fs'
import { join } from 'path'
import { computeDashboardAppSourceHash } from './dashboard-source-hash'

export async function buildDashboardApp(): Promise<void> {
  const entry = join(__dirname, '..', 'src', 'dashboard', 'app', 'index.ts')
  const out = join(__dirname, '..', 'src', 'dashboard', 'app-bundle.ts')

  const result = await Bun.build({
    entrypoints: [entry],
    target: 'browser',
    minify: true,
  })

  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error('Dashboard app bundle build failed')
  }

  const code = await result.outputs[0].text()
  const sourceHash = computeDashboardAppSourceHash()
  writeFileSync(
    out,
    `// Auto-generated from src/dashboard/app. Do not edit.\nexport const DASHBOARD_APP_BUNDLE: string = ${JSON.stringify(code)};\nexport const DASHBOARD_APP_SOURCE_HASH: string = ${JSON.stringify(sourceHash)};\n`,
    'utf-8',
  )
}

if (import.meta.main) {
  buildDashboardApp().then(
    () => console.log('Dashboard app bundle generated.'),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    },
  )
}
