import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { FileCache } from "./cache";
import {
  type ExportInfo,
  type FileOutline,
  type ImportInfo,
  type Language,
  type SymbolInfo,
  type SymbolKind,
  detectLanguageFromPath,
} from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TSParser = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TSLanguage = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TSTree = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TSQuery = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TSQueryCapture = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TSNode = any;

// Tree-sitter query patterns per language
const QUERIES: Record<string, string> = {
  typescript: `
    (function_declaration name: (identifier) @name) @func
    (export_statement (function_declaration name: (identifier) @name)) @func
    (class_declaration name: (type_identifier) @name) @class
    (method_definition name: (property_identifier) @name) @method
    (interface_declaration name: (type_identifier) @name) @iface
    (type_alias_declaration name: (type_identifier) @name) @type
    (lexical_declaration (variable_declarator name: (identifier) @name)) @var
    (import_statement source: (string) @source) @import
    (export_statement) @export
  `,
  javascript: `
    (function_declaration name: (identifier) @name) @func
    (class_declaration name: (identifier) @name) @class
    (method_definition name: (property_identifier) @name) @method
    (lexical_declaration (variable_declarator name: (identifier) @name)) @var
    (import_statement source: (string) @source) @import
    (export_statement) @export
  `,
  python: `
    (function_definition name: (identifier) @name) @func
    (class_definition name: (identifier) @name) @class
    (class_definition body: (block (function_definition name: (identifier) @name) @method))
    (import_statement) @import
    (import_from_statement) @import
  `,
  go: `
    (function_declaration name: (identifier) @name) @func
    (method_declaration name: (field_identifier) @name) @func
    (type_declaration (type_spec name: (type_identifier) @name)) @type
    (import_declaration) @import
  `,
  rust: `
    (function_item name: (identifier) @name) @func
    (struct_item name: (type_identifier) @name) @struct
    (trait_item name: (type_identifier) @name) @trait
    (type_item name: (type_identifier) @name) @type
    (impl_item (declaration_list (function_item name: (identifier) @name) @method))
    (use_declaration) @import
    (impl_item) @impl
  `,
  java: `
    (method_declaration name: (identifier) @name) @func
    (class_declaration name: (identifier) @name) @class
    (interface_declaration name: (identifier) @name) @iface
    (enum_declaration name: (identifier) @name) @type
    (import_declaration) @import
  `,
  c: `
    (function_definition declarator: (function_declarator declarator: (identifier) @name)) @func
    (struct_specifier name: (type_identifier) @name) @struct
    (enum_specifier name: (type_identifier) @name) @type
    (type_definition declarator: (type_identifier) @name) @type
    (preproc_include) @import
  `,
  cpp: `
    (function_definition declarator: (function_declarator declarator: (identifier) @name)) @func
    (class_specifier name: (type_identifier) @name) @class
    (struct_specifier name: (type_identifier) @name) @struct
    (enum_specifier name: (type_identifier) @name) @type
    (namespace_definition name: (namespace_identifier) @name) @type
    (preproc_include) @import
  `,
  csharp: `
    (method_declaration name: (identifier) @name) @func
    (class_declaration name: (identifier) @name) @class
    (interface_declaration name: (identifier) @name) @iface
    (struct_declaration name: (identifier) @name) @struct
    (enum_declaration name: (identifier) @name) @type
    (namespace_declaration name: (identifier) @name) @type
    (using_directive) @import
  `,
  ruby: `
    (method name: (identifier) @name) @func
    (class name: (constant) @name) @class
    (module name: (constant) @name) @type
    (call method: (identifier) @name) @import
  `,
  php: `
    (function_definition name: (name) @name) @func
    (method_declaration name: (name) @name) @func
    (class_declaration name: (name) @name) @class
    (interface_declaration name: (name) @name) @iface
    (trait_declaration name: (name) @name) @trait
    (namespace_use_declaration) @import
  `,
  swift: `
    (function_declaration (simple_identifier) @name) @func
    (class_declaration name: (type_identifier) @name) @class
    (protocol_declaration name: (type_identifier) @name) @iface
    (import_declaration) @import
  `,
  kotlin: `
    (function_declaration (simple_identifier) @name) @func
    (class_declaration (type_identifier) @name) @class
    (object_declaration (type_identifier) @name) @class
    (import_header) @import
  `,
  scala: `
    (function_definition name: (identifier) @name) @func
    (class_definition name: (identifier) @name) @class
    (trait_definition name: (identifier) @name) @trait
    (object_definition name: (identifier) @name) @class
    (import_declaration) @import
  `,
  lua: `
    (function_definition_statement name: (identifier) @name) @func
    (local_function_definition_statement name: (identifier) @name) @func
  `,
  elixir: `
    (call target: (identifier) @name) @func
  `,
  dart: `
    (function_signature (identifier) @name) @func
    (class_definition name: (identifier) @name) @class
    (enum_declaration name: (identifier) @name) @type
    (mixin_declaration name: (identifier) @name) @class
    (import_or_export) @import
  `,
  zig: `
    (function_declaration name: (identifier) @name) @func
    (variable_declaration name: (identifier) @name) @var
  `,
  bash: `
    (function_definition name: (word) @name) @func
  `,
  ocaml: `
    (value_definition (let_binding pattern: (value_name) @name)) @func
    (type_definition (type_binding name: (type_constructor) @name)) @type
    (module_definition (module_binding name: (module_name) @name)) @type
    (open_module) @import
  `,
  objc: `
    (function_definition declarator: (function_declarator declarator: (identifier) @name)) @func
    (class_interface . (identifier) @name) @class
    (protocol_declaration . (identifier) @name) @iface
    (preproc_include) @import
  `,
  css: `
    (rule_set (selectors) @name) @var
    (keyframes_statement (keyframes_name) @name) @type
  `,
  html: `
    (element (start_tag (tag_name) @name)) @var
  `,
  vue: `
    (element (start_tag (tag_name) @name)) @var
  `,
  rescript: `
    (let_declaration (let_binding pattern: (value_identifier) @name)) @func
    (type_declaration (type_binding name: (type_identifier) @name)) @type
    (module_declaration (module_binding name: (module_identifier) @name)) @type
  `,
  solidity: `
    (contract_declaration name: (identifier) @name) @class
    (function_definition name: (identifier) @name) @func
    (event_definition name: (identifier) @name) @type
    (struct_declaration name: (identifier) @name) @struct
    (enum_declaration name: (identifier) @name) @type
    (import_directive) @import
  `,
  tlaplus: `
    (operator_definition name: (identifier) @name) @func
    (function_definition name: (identifier) @name) @func
  `,
  elisp: `
    (function_definition name: (symbol) @name) @func
    (special_form . (symbol) @name) @var
  `,
};

const GRAMMAR_FILES: Record<string, string> = {
  tsx: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
  python: "tree-sitter-python.wasm",
  go: "tree-sitter-go.wasm",
  rust: "tree-sitter-rust.wasm",
  java: "tree-sitter-java.wasm",
  c: "tree-sitter-c.wasm",
  cpp: "tree-sitter-cpp.wasm",
  csharp: "tree-sitter-c_sharp.wasm",
  ruby: "tree-sitter-ruby.wasm",
  php: "tree-sitter-php.wasm",
  swift: "tree-sitter-swift.wasm",
  kotlin: "tree-sitter-kotlin.wasm",
  scala: "tree-sitter-scala.wasm",
  lua: "tree-sitter-lua.wasm",
  elixir: "tree-sitter-elixir.wasm",
  dart: "tree-sitter-dart.wasm",
  zig: "tree-sitter-zig.wasm",
  bash: "tree-sitter-bash.wasm",
  ocaml: "tree-sitter-ocaml.wasm",
  objc: "tree-sitter-objc.wasm",
  css: "tree-sitter-css.wasm",
  html: "tree-sitter-html.wasm",
  json: "tree-sitter-json.wasm",
  toml: "tree-sitter-toml.wasm",
  vue: "tree-sitter-vue.wasm",
  rescript: "tree-sitter-rescript.wasm",
  solidity: "tree-sitter-solidity.wasm",
  tlaplus: "tree-sitter-tlaplus.wasm",
  elisp: "tree-sitter-elisp.wasm",
};

let TSQueryClass: (new (lang: TSLanguage, source: string) => TSQuery) | null = null;

function createQuery(lang: TSLanguage, source: string): TSQuery {
  if (!TSQueryClass) throw new Error("tree-sitter not initialized");
  return new TSQueryClass(lang, source);
}

interface TreeCacheEntry {
  tree: TSTree;
  content: string;
}

export class TreeSitterBackend {
  private parser: TSParser | null = null;
  private languages = new Map<string, TSLanguage>();
  private failedLanguages = new Set<string>();
  private initPromise: Promise<void> | null = null;
  private cache: FileCache | null = null;
  private treeCache = new Map<string, TreeCacheEntry>();
  private readonly treeCacheMaxSize = 50;

  supportsLanguage(language: Language): boolean {
    const key = language === "typescript" ? "tsx" : language;
    return key in GRAMMAR_FILES;
  }

  setCache(cache: FileCache): void {
    this.cache = cache;
  }

  async initialize(_cwd: string): Promise<void> {
    if (this.parser) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.doInit();
    return this.initPromise;
  }

  dispose(): void {
    for (const entry of this.treeCache.values()) {
      entry.tree.delete();
    }
    this.treeCache.clear();
    this.parser?.delete();
    this.parser = null;
    this.languages.clear();
    this.initPromise = null;
  }

  async getFileOutline(file: string): Promise<FileOutline | null> {
    const tree = await this.parseFile(file);
    if (!tree) return null;

    const language = this.detectLang(file);
    const tsLang = this.languages.get(this.grammarKeyForFile(file));
    if (!tsLang) {
      tree.delete();
      return null;
    }

    const symbols: SymbolInfo[] = [];
    const imports: ImportInfo[] = [];
    const exports: ExportInfo[] = [];
    const absFile = resolve(file);

    const mainQueryStr = QUERIES[language];
    if (mainQueryStr) {
      const mainQuery = createQuery(tsLang, mainQueryStr);
      try {
        const matches = mainQuery.matches(tree.rootNode);
        for (const match of matches) {
          const nameCapture = match.captures.find((c: TSQueryCapture) => c.name === "name");
          const sourceCapture = match.captures.find((c: TSQueryCapture) => c.name === "source");
          const patternCapture = match.captures.find(
            (c: TSQueryCapture) => c.name !== "name" && c.name !== "source",
          );

          if (patternCapture?.name === "import") {
            const node = patternCapture.node;
            const source = sourceCapture ? sourceCapture.node.text.replace(/['"]/g, "") : node.text;
            const specifiers = extractImportSpecifiers(node, language);
            const isDefault =
              specifiers.length > 0 &&
              node.text.includes("import ") &&
              !node.text.includes("{") &&
              !node.text.includes("*");
            const isNamespace = node.text.includes("* as ");
            imports.push({
              source,
              specifiers,
              isDefault,
              isNamespace,
              location: {
                file: absFile,
                line: node.startPosition.row + 1,
                column: node.startPosition.column + 1,
                endLine: node.endPosition.row + 1,
              },
            });
            continue;
          }

          if (patternCapture?.name === "export") {
            const node = patternCapture.node;
            const isDefault = node.text.includes("export default");
            const decl = node.namedChildren.find(
              (c: TSNode | null) =>
                c != null &&
                (c.type === "function_declaration" ||
                  c.type === "class_declaration" ||
                  c.type === "interface_declaration" ||
                  c.type === "type_alias_declaration" ||
                  c.type === "lexical_declaration"),
            );
            if (decl) {
              const expNameNode =
                decl.childForFieldName("name") ??
                decl.namedChildren
                  .find((c: TSNode | null) => c != null && c.type === "variable_declarator")
                  ?.childForFieldName("name");
              if (expNameNode) {
                let kind: SymbolKind = "variable";
                if (decl.type.includes("function")) kind = "function";
                else if (decl.type.includes("class")) kind = "class";
                else if (decl.type.includes("interface")) kind = "interface";
                else if (decl.type.includes("type")) kind = "type";
                exports.push({
                  name: expNameNode.text,
                  isDefault,
                  kind,
                  location: {
                    file: absFile,
                    line: node.startPosition.row + 1,
                    column: node.startPosition.column + 1,
                    endLine: node.endPosition.row + 1,
                  },
                });
              }
            }
            continue;
          }

          if (nameCapture) {
            const kind = this.captureToKind(patternCapture?.name ?? "unknown");
            const declNode = patternCapture?.node ?? nameCapture.node.parent ?? nameCapture.node;
            const symbol: SymbolInfo = {
              name: nameCapture.node.text,
              kind,
              location: {
                file: absFile,
                line: nameCapture.node.startPosition.row + 1,
                column: nameCapture.node.startPosition.column + 1,
                endLine: declNode.endPosition.row + 1,
              },
            };
            // Deduplicate symbols by file, name, kind, and location to prevent
            // overlapping query captures from creating duplicate entries.
            // Column is included to distinguish same-line declarations (e.g., getter/setter pairs).
            const isDuplicate = symbols.some(
              (s) =>
                s.name === symbol.name &&
                s.kind === symbol.kind &&
                s.location.line === symbol.location.line &&
                s.location.column === symbol.location.column &&
                s.location.endLine === symbol.location.endLine,
            );
            if (!isDuplicate) {
              symbols.push(symbol);
            }
          }
        }
      } finally {
        mainQuery.delete();
      }
    }

    tree.delete();

    if (exports.length === 0 && language !== "typescript" && language !== "javascript") {
      const content = await this.readFileContent(file);
      if (content) {
        const lines = content.split("\n");
        for (const sym of symbols) {
          const line = lines[sym.location.line - 1] ?? "";
          if (isPublicSymbol(sym.name, line, language, file)) {
            exports.push({
              name: sym.name,
              isDefault: false,
              kind: sym.kind,
              location: sym.location,
            });
          }
        }
      }
    }

    return {
      file: absFile,
      language,
      symbols,
      imports,
      exports,
    };
  }

  private static readonly MIN_HASH_LINES = 5;

  private static readonly HASHABLE_KEYWORDS = [
    "function",
    "method",
    "class",
    "impl",
    "struct",
    "trait",
    "module",
    "constructor",
  ];

  private static isHashableType(nodeType: string): boolean {
    return TreeSitterBackend.HASHABLE_KEYWORDS.some((kw) => nodeType.includes(kw));
  }

  private serializeShape(node: TSNode, depth: number): string {
    if (depth > 40) return node.type;
    const childCount = node.namedChildCount;
    if (childCount === 0) return node.type;
    const children: string[] = [];
    for (let i = 0; i < childCount; i++) {
      const child = node.namedChild(i);
      if (child) children.push(this.serializeShape(child, depth + 1));
    }
    return `${node.type}(${children.join(",")})`;
  }

  private countNodes(node: TSNode, depth: number): number {
    if (depth > 40) return 1;
    let count = 1;
    const childCount = node.namedChildCount;
    for (let i = 0; i < childCount; i++) {
      const child = node.namedChild(i);
      if (child) count += this.countNodes(child, depth + 1);
    }
    return count;
  }

  private extractNodeName(node: TSNode): string {
    const nameNode = node.childForFieldName("name");
    if (nameNode) return nameNode.text;

    if (node.type === "arrow_function" || node.type === "function_expression") {
      const parent = node.parent;
      if (parent?.type === "variable_declarator") {
        const varName = parent.childForFieldName("name");
        if (varName) return varName.text;
      }
      if (parent?.type === "pair" || parent?.type === "property") {
        const key = parent.childForFieldName("key");
        if (key) return key.text;
      }
    }

    if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
      const declarator = node.namedChildren.find(
        (c: TSNode | null) => c != null && c.type === "variable_declarator",
      );
      if (declarator) {
        const varName = declarator.childForFieldName("name");
        if (varName) return varName.text;
      }
    }

    return "(anonymous)";
  }

  private collectHashableNodes(
    node: TSNode,
    results: Array<{ node: TSNode; name: string; kind: string }>,
    depth: number,
  ): void {
    if (depth > 10) return;

    if (TreeSitterBackend.isHashableType(node.type)) {
      const lines = node.endPosition.row - node.startPosition.row + 1;
      if (lines >= TreeSitterBackend.MIN_HASH_LINES) {
        const name = this.extractNodeName(node);
        const kind = node.type
          .replace(/_declaration|_definition|_item|_statement|_specifier/, "")
          .replace(/^local_/, "");
        results.push({ node, name, kind });
      }
    }

    if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
      const lines = node.endPosition.row - node.startPosition.row + 1;
      if (lines >= TreeSitterBackend.MIN_HASH_LINES) {
        const hasArrow = node.namedChildren.some((c: TSNode | null) => {
          if (!c || c.type !== "variable_declarator") return false;
          return c.namedChildren.some(
            (gc: TSNode | null) =>
              gc != null && (gc.type === "arrow_function" || gc.type === "function_expression"),
          );
        });
        if (hasArrow) {
          const name = this.extractNodeName(node);
          results.push({ node, name, kind: "function" });
        }
      }
    }

    const childCount = node.namedChildCount;
    for (let i = 0; i < childCount; i++) {
      const child = node.namedChild(i);
      if (child) this.collectHashableNodes(child, results, depth + 1);
    }
  }

  async getShapeHashes(file: string): Promise<Array<{
    name: string;
    kind: string;
    line: number;
    endLine: number;
    shapeHash: string;
    nodeCount: number;
  }> | null> {
    const tree = await this.parseFile(file);
    if (!tree) return null;

    try {
      const nodes: Array<{ node: TSNode; name: string; kind: string }> = [];
      this.collectHashableNodes(tree.rootNode, nodes, 0);

      if (nodes.length === 0) return [];

      const results: Array<{
        name: string;
        kind: string;
        line: number;
        endLine: number;
        shapeHash: string;
        nodeCount: number;
      }> = [];

      for (const { node, name, kind } of nodes) {
        const serialized = this.serializeShape(node, 0);
        const hash = Bun.hash(serialized).toString(16);
        const nodeCount = this.countNodes(node, 0);
        results.push({
          name,
          kind,
          line: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          shapeHash: hash,
          nodeCount,
        });
      }

      return results;
    } finally {
      tree.delete();
    }
  }

  private async doInit(): Promise<void> {
    const wasmPath = this.resolveWasm("tree-sitter.wasm");
    if (!existsSync(wasmPath)) {
      throw new Error(`tree-sitter.wasm not found`);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import("web-tree-sitter");
    TSQueryClass = mod.Query;
    const ParserClass = mod.Parser;
    await ParserClass.init({
      locateFile: () => wasmPath,
    });
    this.parser = new ParserClass();
  }

  private resolveWasm(filename: string): string {
    const basename = filename.split("/").pop() ?? filename;
    let dir = import.meta.dir;
    for (let i = 0; i < 5; i++) {
      for (const sub of ["node_modules/web-tree-sitter", "node_modules/tree-sitter-wasms/out"]) {
        const p = join(dir, sub, basename);
        if (existsSync(p)) return p;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    throw new Error(`tree-sitter.wasm not found`);
  }

  private async loadLanguage(language: string): Promise<TSLanguage | null> {
    const cached = this.languages.get(language);
    if (cached) return cached;
    if (this.failedLanguages.has(language)) return null;

    const wasmFile = GRAMMAR_FILES[language];
    if (!wasmFile) return null;

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod: any = await import("web-tree-sitter");
      const wasmPath = this.resolveWasm(`tree-sitter-wasms/out/${wasmFile}`);
      const lang = await mod.Language.load(wasmPath);
      if (this.parser) {
        this.parser.setLanguage(lang);
        const tree = this.parser.parse("# validate");
        tree?.delete();
      }
      this.languages.set(language, lang);
      return lang;
    } catch {
      this.failedLanguages.add(language);
      return null;
    }
  }

  private async parseFile(file: string): Promise<TSTree | null> {
    if (!this.parser) return null;

    const absPath = resolve(file);
    const content = await this.readFileContent(absPath);
    if (!content) return null;

    const cached = this.treeCache.get(absPath);
    if (cached && cached.content === content) {
      return cached.tree.copy();
    }

    const grammarKey = this.grammarKeyForFile(file);
    const lang = await this.loadLanguage(grammarKey);
    if (!lang) return null;

    this.parser.setLanguage(lang);
    let tree: TSTree | null;
    try {
      tree = this.parser.parse(content);
    } catch {
      this.failedLanguages.add(grammarKey);
      this.languages.delete(grammarKey);
      return null;
    }
    if (!tree) return null;

    if (cached) cached.tree.delete();
    if (this.treeCache.size >= this.treeCacheMaxSize) {
      const firstKey = this.treeCache.keys().next().value;
      if (firstKey) {
        this.treeCache.get(firstKey)?.tree.delete();
        this.treeCache.delete(firstKey);
      }
    }
    this.treeCache.set(absPath, { tree: tree.copy(), content });

    return tree;
  }

  private async readFileContent(file: string): Promise<string | null> {
    const absPath = resolve(file);
    if (this.cache) {
      return this.cache.get(absPath);
    }
    try {
      return await readFile(absPath, "utf-8");
    } catch {
      return null;
    }
  }

  private detectLang(file: string): Language {
    return detectLanguageFromPath(file);
  }

  private grammarKeyForFile(file: string): string {
    const language = this.detectLang(file);
    if (language === "typescript") return "tsx";
    return language;
  }

  private captureToKind(captureName: string): SymbolKind {
    switch (captureName) {
      case "func":
        return "function";
      case "method":
        return "method";
      case "class":
      case "struct":
        return "class";
      case "iface":
      case "trait":
        return "interface";
      case "type":
        return "type";
      case "var":
        return "variable";
      case "impl":
        return "class";
      default:
        return "unknown";
    }
  }
}

function extractImportSpecifiers(node: TSNode, language: Language): string[] {
  const specifiers: string[] = [];
  collectSpecifiers(node, language, specifiers);
  return specifiers;
}

function collectSpecifiers(node: TSNode, language: Language, out: string[]): void {
  const type = node.type;

  if (language === "typescript" || language === "javascript") {
    if (type === "import_specifier") {
      const name = node.childForFieldName("name");
      if (name) out.push(name.text);
      return;
    }
    if (type === "identifier" && node.parent?.type === "import_clause") {
      out.push(node.text);
      return;
    }
    if (type === "namespace_import") {
      const name = node.namedChildren.find(
        (c: TSNode | null) => c != null && c.type === "identifier",
      );
      if (name) out.push(name.text);
      return;
    }
  } else if (language === "python") {
    if (type === "aliased_import") {
      const name = node.childForFieldName("name");
      if (name) {
        const text = name.text;
        const last = text.split(".").pop();
        if (last) out.push(last);
      }
      return;
    }
    if (type === "dotted_name" && node.parent?.type === "import_from_statement") {
      const field = node.parent.childForFieldName("module_name");
      if (node !== field) {
        const last = node.text.split(".").pop();
        if (last) out.push(last);
        return;
      }
    }
    if (type === "dotted_name" && node.parent?.type === "import_statement") {
      const last = node.text.split(".").pop();
      if (last) out.push(last);
      return;
    }
  } else if (language === "rust") {
    if (type === "use_as_clause") {
      const path = node.childForFieldName("path");
      if (path) {
        const name = path.childForFieldName("name");
        out.push(name ? name.text : path.text);
        return;
      }
    }
    if (
      type === "identifier" &&
      (node.parent?.type === "use_list" ||
        node.parent?.type === "scoped_use_list" ||
        node.parent?.type === "use_declaration")
    ) {
      out.push(node.text);
      return;
    }
    if (type === "scoped_identifier" && !node.parent?.type?.includes("use_list")) {
      const name = node.childForFieldName("name");
      if (name) out.push(name.text);
      return;
    }
  } else if (language === "go") {
    if (type === "import_spec") {
      const name = node.childForFieldName("name");
      const path = node.childForFieldName("path");
      if (name && name.text !== ".") {
        out.push(name.text);
      } else if (path) {
        const raw = path.text.replace(/['"]/g, "");
        const last = raw.split("/").pop();
        if (last) out.push(last);
      }
      return;
    }
    if (type === "interpreted_string_literal") {
      const raw = node.text.replace(/['"]/g, "");
      const last = raw.split("/").pop();
      if (last) out.push(last);
      return;
    }
  }

  const childCount = node.namedChildCount;
  for (let i = 0; i < childCount; i++) {
    const child = node.namedChild(i);
    if (child) collectSpecifiers(child, language, out);
  }
}

function isPublicSymbol(
  name: string,
  sourceLine: string,
  language: Language,
  _filePath: string,
): boolean {
  const trimmed = sourceLine.trimStart();
  switch (language) {
    case "go":
      return /^[A-Z]/.test(name);
    case "rust":
    case "zig":
      return trimmed.startsWith("pub ");
    case "python":
    case "dart":
      return !name.startsWith("_");
    case "java":
    case "kotlin":
    case "scala":
    case "swift":
    case "csharp":
      return !/\bprivate\b/.test(trimmed);
    case "php":
      return !/\b(?:private|protected)\b/.test(trimmed);
    case "ruby":
    case "lua":
    case "bash":
    case "tlaplus":
    case "rescript":
    case "ocaml":
      return true;
    case "elixir":
      return !trimmed.startsWith("defp ");
    case "elisp":
      return !name.startsWith("--");
    default:
      return true;
  }
}
