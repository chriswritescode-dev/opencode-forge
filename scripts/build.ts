import { readFileSync, writeFileSync, cpSync, mkdirSync, existsSync, chmodSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
import solidPlugin from '@opentui/solid/bun-plugin'
import { buildDashboardApp } from './build-dashboard-app'

const packageJsonPath = join(__dirname, '..', 'package.json')
const versionPath = join(__dirname, '..', 'src', 'version.ts')

const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'))
const version = packageJson.version as string

const versionContent = `export const VERSION = '${version}'\n`
writeFileSync(versionPath, versionContent, 'utf-8')

console.log(`Version ${version} written to src/version.ts`)

console.log('Generating dashboard marked-source...')
const markedMinPath = join(__dirname, '..', 'src', 'dashboard', 'marked.min.js')
const markedSourcePath = join(__dirname, '..', 'src', 'dashboard', 'marked-source.ts')
const markedRaw = readFileSync(markedMinPath, 'utf-8')
// Use JSON.stringify for proper JS string escaping (handles backticks, $, quotes, etc.)
const markedEscaped = JSON.stringify(markedRaw)
const markedSourceContent = `// Auto-generated from marked.min.js. Do not edit.
export const MARKED_SOURCE: string = ${markedEscaped};
`
writeFileSync(markedSourcePath, markedSourceContent, 'utf-8')
console.log('Dashboard marked-source generated.')

console.log('Generating dashboard app bundle...')
await buildDashboardApp()
console.log('Dashboard app bundle generated.')

console.log('Compiling main code...')
execSync('tsc -p tsconfig.build.json', {
  cwd: join(__dirname, '..'),
  stdio: 'inherit'
})

console.log('Compiling TUI plugin...')
const result = await Bun.build({
  entrypoints: [join(__dirname, '..', 'src', 'tui.tsx')],
  outdir: join(__dirname, '..', 'dist'),
  target: 'node',
  plugins: [solidPlugin],
  external: ['@opentui/solid', '@opentui/core', '@opencode-ai/plugin/tui', 'solid-js'],
})

if (!result.success) {
  for (const log of result.logs) {
    console.error(log)
  }
  process.exit(1)
}

console.log('Generating TUI type declarations...')
const tuiDtsContent = `import type { TuiPluginModule } from '@opencode-ai/plugin/tui';
declare const plugin: TuiPluginModule & { id: string };
export default plugin;
`
writeFileSync(join(__dirname, '..', 'dist', 'tui.d.ts'), tuiDtsContent, 'utf-8')

console.log('Copying migration SQL files...')
const srcMigrationsDir = join(__dirname, '..', 'src', 'storage', 'migrations')
const distMigrationsDir = join(__dirname, '..', 'dist', 'storage', 'migrations')
mkdirSync(distMigrationsDir, { recursive: true })
cpSync(srcMigrationsDir, distMigrationsDir, {
  recursive: true,
  filter: (src) => !src.endsWith('.ts') && !src.endsWith('.md')
})
console.log('Copying bundled skills...')
const srcSkillsDir = join(__dirname, '..', 'skills')
const distSkillsDir = join(__dirname, '..', 'dist', 'skills')
if (existsSync(srcSkillsDir)) {
  mkdirSync(distSkillsDir, { recursive: true })
  cpSync(srcSkillsDir, distSkillsDir, { recursive: true })
}

console.log('Copying bundled prompts...')
const srcPromptsDir = join(__dirname, '..', 'src', 'prompts')
const distPromptsDir = join(__dirname, '..', 'dist', 'prompts')
if (existsSync(srcPromptsDir)) {
  mkdirSync(distPromptsDir, { recursive: true })
  cpSync(srcPromptsDir, distPromptsDir, { recursive: true, force: true, filter: (src) => !src.endsWith('.ts') })
}

console.log('Bundling installer CLI...')
const installerResult = await Bun.build({
  entrypoints: [join(__dirname, '..', 'src', 'install', 'cli.ts')],
  outdir: join(__dirname, '..', 'dist', 'install'),
  target: 'node',
  format: 'esm',
})
if (!installerResult.success) {
  for (const log of installerResult.logs) {
    console.error(log)
  }
  process.exit(1)
}
// Bundle into a single self-contained file so the `bin` runs under both node
// (npx) and bun (bunx); prepend a node shebang and mark it executable.
const installerCliPath = join(__dirname, '..', 'dist', 'install', 'cli.js')
const bundledCli = readFileSync(installerCliPath, 'utf-8')
if (!bundledCli.startsWith('#!')) {
  writeFileSync(installerCliPath, `#!/usr/bin/env node\n${bundledCli}`)
}
chmodSync(installerCliPath, 0o755)

console.log('Build complete!')
