/** Languages supported by tree-sitter backend */
export type Language =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'c'
  | 'cpp'
  | 'csharp'
  | 'ruby'
  | 'php'
  | 'swift'
  | 'kotlin'
  | 'scala'
  | 'lua'
  | 'elixir'
  | 'dart'
  | 'zig'
  | 'bash'
  | 'ocaml'
  | 'objc'
  | 'css'
  | 'html'
  | 'json'
  | 'toml'
  | 'yaml'
  | 'dockerfile'
  | 'vue'
  | 'rescript'
  | 'solidity'
  | 'tlaplus'
  | 'elisp'
  | 'unknown'

/** Mapping from file extension to language */
export const EXT_TO_LANGUAGE: Record<string, Language> = {
  // TypeScript
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  // JavaScript
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  // Python
  '.py': 'python',
  '.pyw': 'python',
  // Go
  '.go': 'go',
  // Rust
  '.rs': 'rust',
  // Java
  '.java': 'java',
  // C
  '.c': 'c',
  '.h': 'c',
  // C++
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.hxx': 'cpp',
  // C#
  '.cs': 'csharp',
  // Ruby
  '.rb': 'ruby',
  '.erb': 'ruby',
  // PHP
  '.php': 'php',
  // Swift
  '.swift': 'swift',
  // Kotlin
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  // Scala
  '.scala': 'scala',
  '.sc': 'scala',
  // Lua
  '.lua': 'lua',
  // Elixir
  '.ex': 'elixir',
  '.exs': 'elixir',
  // Dart
  '.dart': 'dart',
  // Zig
  '.zig': 'zig',
  // Shell
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  // OCaml
  '.ml': 'ocaml',
  '.mli': 'ocaml',
  // Objective-C
  '.m': 'objc',
  // CSS
  '.css': 'css',
  '.scss': 'css',
  '.less': 'css',
  // HTML
  '.html': 'html',
  '.htm': 'html',
  // JSON
  '.json': 'json',
  '.jsonc': 'json',
  // TOML
  '.toml': 'toml',
  // YAML
  '.yaml': 'yaml',
  '.yml': 'yaml',
  // Dockerfile
  '.dockerfile': 'dockerfile',
  // Vue
  '.vue': 'vue',
  // ReScript
  '.res': 'rescript',
  '.resi': 'rescript',
  // Solidity
  '.sol': 'solidity',
  // TLA+
  '.tla': 'tlaplus',
  // Emacs Lisp
  '.el': 'elisp',
}

/** Detect language from a file path */
export function detectLanguageFromPath(file: string): Language {
  const dot = file.lastIndexOf('.')
  if (dot === -1) {
    const name = file.slice(file.lastIndexOf('/') + 1)
    if (name === 'Dockerfile' || name.startsWith('Dockerfile.')) return 'dockerfile'
    return 'unknown'
  }
  return EXT_TO_LANGUAGE[file.slice(dot).toLowerCase()] ?? 'unknown'
}

/** Symbol kinds for classification */
export type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'variable'
  | 'constant'
  | 'enum'
  | 'property'
  | 'module'
  | 'namespace'
  | 'unknown'

/** A location in source code */
export interface SourceLocation {
  file: string
  line: number
  column: number
  endLine?: number
  endColumn?: number
}

/** A symbol found in source code */
export interface SymbolInfo {
  name: string
  kind: SymbolKind
  location: SourceLocation
  containerName?: string
}

/** Import information */
export interface ImportInfo {
  source: string
  specifiers: string[]
  isDefault: boolean
  isNamespace: boolean
  location: SourceLocation
}

/** Export information */
export interface ExportInfo {
  name: string
  isDefault: boolean
  kind: SymbolKind
  location: SourceLocation
}

/** File outline — top-level structure */
export interface FileOutline {
  file: string
  language: Language
  symbols: SymbolInfo[]
  imports: ImportInfo[]
  exports: ExportInfo[]
}

/** Database file record */
export interface DbFile {
  id: number
  path: string
  mtime_ms: number
  language: string
  line_count: number
  symbol_count: number
  pagerank: number
  is_barrel: boolean
}

/** Database symbol record */
export interface DbSymbol {
  id: number
  file_id: number
  name: string
  kind: string
  line: number
  end_line: number
  is_exported: boolean
  signature?: string
  qualified_name?: string
}

/** Graph statistics */
export interface GraphStats {
  files: number
  symbols: number
  edges: number
  summaries: number
  calls: number
}

/** Top file result */
export interface TopFileResult {
  path: string
  pagerank: number
  lines: number
  symbols: number
  language: string
}

/** File dependents/dependencies result */
export interface FileDepResult {
  path: string
  weight: number
}

/** File co-changes result */
export interface FileCoChangeResult {
  path: string
  count: number
}

/** File symbols result */
export interface FileSymbolResult {
  name: string
  kind: string
  isExported: boolean
  line: number
  endLine: number
}

/** Symbol search result */
export interface SymbolSearchResult {
  name: string
  path: string
  kind: string
  line: number
  isExported: boolean
  pagerank: number
  id?: number
}

/** Symbol signature result */
export interface SymbolSignatureResult {
  path: string
  kind: string
  signature: string
  line: number
}

/** Caller result */
export interface CallerResult {
  callerName: string
  callerPath: string
  callerLine: number
  callLine: number
}

/** Callee result */
export interface CalleeResult {
  calleeName: string
  calleeFile: string
  calleeLine: number
  callLine: number
}

/** Unused export result */
export interface UnusedExportResult {
  name: string
  path: string
  kind: string
  line: number
  endLine: number
  lineCount: number
  usedInternally: boolean
}

/** Duplicate structure result */
export interface DuplicateStructureResult {
  shapeHash: string
  kind: string
  nodeCount: number
  members: Array<{ path: string; line: number }>
}

/** Near duplicate result */
export interface NearDuplicateResult {
  similarity: number
  a: { path: string; line: number; name: string }
  b: { path: string; line: number; name: string }
}

/** External package result */
export interface ExternalPackageResult {
  package: string
  fileCount: number
  specifiers: string[]
}

/** Scan preparation result */
export interface PrepareScanResult {
  totalFiles: number
  batchSize: number
}

/** Scan batch result */
export interface ScanBatchResult {
  processed: number
  completed: boolean
  nextOffset: number
  totalFiles: number
}
