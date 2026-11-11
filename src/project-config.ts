import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { applyEdits, modify, parse } from 'jsonc-parser/lib/esm/main.js'
import type { ParseError, ParseOptions } from 'jsonc-parser/lib/esm/main.js'
import { resolveProjectsConfigPath } from './install/paths'
import { readSandboxEnvNames, readSandboxEnvValues } from './sandbox/env'
import type { ProjectConfig, ProjectSandboxConfig } from './types'
import { isRecord } from './utils/is-record'

const PARSE_OPTIONS: ParseOptions = { allowTrailingComma: true }
const MODIFY_OPTIONS = { formattingOptions: { insertSpaces: true, tabSize: 2 } }

function validateProjectConfig(entry: Record<string, unknown>): ProjectConfig {
  const config: ProjectConfig = {}
  const name = entry['name']
  if (typeof name === 'string' && name.length > 0) config.name = name
  const sandbox = isRecord(entry['sandbox']) ? entry['sandbox'] : {}
  const network = isRecord(sandbox['network']) ? sandbox['network'] : {}
  const env = readSandboxEnvValues(sandbox['env'])
  const networkEnv = readSandboxEnvNames(network['env'])
  const projectSandbox: ProjectSandboxConfig = {}
  if (Object.keys(env).length > 0) projectSandbox.env = env
  if (networkEnv.length > 0) projectSandbox.network = { env: networkEnv }
  if (Object.keys(projectSandbox).length > 0) config.sandbox = projectSandbox
  return config
}

export function readProjectConfig(projectId: string, path: string = resolveProjectsConfigPath()): ProjectConfig {
  let text: string
  try {
    text = readFileSync(path, 'utf-8')
  } catch {
    return {}
  }
  const errors: ParseError[] = []
  const root: unknown = parse(text, errors, PARSE_OPTIONS)
  if (errors.length > 0 || !isRecord(root)) return {}
  const projects = root['projects']
  if (!isRecord(projects)) return {}
  const entry = projects[projectId]
  if (!isRecord(entry)) return {}
  return validateProjectConfig(entry)
}

function nextSandbox(
  existingSandbox: Record<string, unknown>,
  env: Record<string, string>,
  names: string[],
): Record<string, unknown> {
  const sandbox: Record<string, unknown> = { ...existingSandbox }
  if (Object.keys(env).length > 0) sandbox['env'] = env
  else delete sandbox['env']
  const existingNetwork = isRecord(existingSandbox['network']) ? existingSandbox['network'] : {}
  const network: Record<string, unknown> = { ...existingNetwork }
  if (names.length > 0) network['env'] = names
  else delete network['env']
  if (Object.keys(network).length > 0) sandbox['network'] = network
  else delete sandbox['network']
  return sandbox
}

export function writeProjectSandboxEnv(
  projectId: string,
  update: { name?: string; env: Record<string, string>; passthrough: string[] },
  path: string = resolveProjectsConfigPath(),
): void {
  const text = existsSync(path) ? readFileSync(path, 'utf-8') : '{}\n'
  const errors: ParseError[] = []
  const root: unknown = parse(text, errors, PARSE_OPTIONS)
  if (errors.length > 0 || !isRecord(root)) {
    throw new Error(`Cannot update ${path}: the file is not valid JSONC`)
  }
  const env = readSandboxEnvValues(update.env)
  const names = readSandboxEnvNames(update.passthrough)
  const projects = isRecord(root['projects']) ? root['projects'] : {}
  const entry = isRecord(projects[projectId]) ? projects[projectId] : {}
  const existingSandbox = isRecord(entry['sandbox']) ? entry['sandbox'] : {}
  const sandbox = nextSandbox(existingSandbox, env, names)
  let next = text
  if (typeof update.name === 'string' && update.name.length > 0 && entry['name'] === undefined) {
    next = applyEdits(next, modify(next, ['projects', projectId, 'name'], update.name, MODIFY_OPTIONS))
  }
  next = applyEdits(
    next,
    modify(next, ['projects', projectId, 'sandbox'], Object.keys(sandbox).length > 0 ? sandbox : undefined, MODIFY_OPTIONS),
  )
  mkdirSync(dirname(path), { recursive: true })
  const tempPath = `${path}.${process.pid}.tmp`
  writeFileSync(tempPath, next, { encoding: 'utf-8', mode: 0o600 })
  renameSync(tempPath, path)
}
