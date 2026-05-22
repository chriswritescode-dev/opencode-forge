import { createRequire } from 'module'
import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import type { Parser as ParserType, Node } from 'web-tree-sitter'

const req = createRequire(import.meta.url)

function resolveWasm(packageName: string, fileName: string): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const distCandidate = join(here, '..', '..', 'wasm', fileName)
  if (existsSync(distCandidate)) return distCandidate
  const pkgRoot = dirname(req.resolve(`${packageName}/package.json`))
  return join(pkgRoot, fileName)
}

let parserPromise: Promise<ParserType> | null = null

export async function getBashParser(): Promise<ParserType> {
  if (parserPromise) return parserPromise
  parserPromise = (async () => {
    const { Parser, Language } = await import('web-tree-sitter')
    const treePath = resolveWasm('web-tree-sitter', 'tree-sitter.wasm')
    const bashPath = resolveWasm('tree-sitter-bash', 'tree-sitter-bash.wasm')
    await Parser.init({ locateFile: () => treePath })
    const bashLang = await Language.load(bashPath)
    const parser = new Parser()
    parser.setLanguage(bashLang)
    return parser
  })()
  return parserPromise
}

export async function parseBash(command: string): Promise<Node> {
  const parser = await getBashParser()
  const tree = parser.parse(command)
  if (!tree) throw new Error(`Failed to parse bash command: ${command.slice(0, 60)}`)
  return tree.rootNode
}

export function parts(node: Node): { type: string; text: string }[] {
  const out: { type: string; text: string }[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (
      child.type !== 'command_name' &&
      child.type !== 'word' &&
      child.type !== 'string' &&
      child.type !== 'raw_string' &&
      child.type !== 'concatenation'
    ) continue
    out.push({ type: child.type, text: child.text })
  }
  return out
}

export function commands(root: Node): Node[] {
  return root.descendantsOfType('command').filter((n): n is Node => Boolean(n))
}

export function redirectedOnly(root: Node): Node[] {
  const result: Node[] = []
  const candidates = root.descendantsOfType('redirected_statement')
  for (const child of candidates) {
    if (!child) continue
    let hasCommand = false
    for (let j = 0; j < child.childCount; j++) {
      const grandchild = child.child(j)
      if (
        grandchild?.type === 'command' ||
        grandchild?.type === 'pipeline' ||
        grandchild?.type === 'compound_command'
      ) {
        hasCommand = true
        break
      }
    }
    if (!hasCommand) result.push(child)
  }
  return result
}

export function source(node: Node): string {
  return (node.parent?.type === 'redirected_statement' ? node.parent.text : node.text).trim()
}

export function unquote(text: string): string {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}
