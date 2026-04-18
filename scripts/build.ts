import { readFileSync, writeFileSync, cpSync, mkdirSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
import solidPlugin from '@opentui/solid/bun-plugin'

const packageJsonPath = join(__dirname, '..', 'package.json')
const versionPath = join(__dirname, '..', 'src', 'version.ts')

const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'))
const version = packageJson.version as string

const versionContent = `export const VERSION = '${version}'\n`
writeFileSync(versionPath, versionContent, 'utf-8')

console.log(`Version ${version} written to src/version.ts`)

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

console.log('Bundling graph worker...')
const workerResult = await Bun.build({
  entrypoints: [join(__dirname, '..', 'src', 'graph', 'worker.ts')],
  outdir: join(__dirname, '..', 'dist', 'graph'),
  target: 'node',
  format: 'esm',
})

if (!workerResult.success) {
  for (const log of workerResult.logs) {
    console.error(log)
  }
  process.exit(1)
}

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

console.log('Copying template files...')
const srcTemplateDir = join(__dirname, '..', 'src', 'command', 'template')
const distTemplateDir = join(__dirname, '..', 'dist', 'command', 'template')
mkdirSync(distTemplateDir, { recursive: true })
cpSync(srcTemplateDir, distTemplateDir, { recursive: true })

console.log('Copying migration SQL files...')
const srcMigrationsDir = join(__dirname, '..', 'src', 'storage', 'migrations')
const distMigrationsDir = join(__dirname, '..', 'dist', 'storage', 'migrations')
mkdirSync(distMigrationsDir, { recursive: true })
cpSync(srcMigrationsDir, distMigrationsDir, {
  recursive: true,
  filter: (src) => !src.endsWith('.ts') && !src.endsWith('.md')
})

console.log('Build complete!')
