import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import Parser from "tree-sitter";
import treeSitterJavaScript from "tree-sitter-javascript";
import treeSitterTypeScript from "tree-sitter-typescript";
import type { ReferenceNode } from "./reference-graph";
import { replaceReferenceNodes } from "./reference-graph";
import {
  SOURCE_EXTENSIONS,
  collectSourceFiles,
} from "./source-discovery";

const { tsx, typescript } = treeSitterTypeScript as {
  tsx: Parser.Language;
  typescript: Parser.Language;
};

const { javascript, jsx } = treeSitterJavaScript as {
  javascript: Parser.Language;
  jsx: Parser.Language;
};

const require = createRequire(import.meta.url);

function loadOptionalLanguage(moduleName: string): Parser.Language | null {
  try {
    const loaded = require(moduleName) as { default?: Parser.Language } | Parser.Language;
    if (loaded && typeof loaded === "object" && "default" in loaded && loaded.default) {
      return loaded.default;
    }
    return loaded as Parser.Language;
  } catch {
    return null;
  }
}

const python = loadOptionalLanguage("tree-sitter-python");

const MAX_AST_DEPTH = 40;
const MAX_CHILDREN_PER_NODE = 200;

interface AstPosition {
  row: number;
  column: number;
}

interface SerializedAstNode {
  type: string;
  startIndex: number;
  endIndex: number;
  startPosition: AstPosition;
  endPosition: AstPosition;
  children: SerializedAstNode[];
  truncated?: boolean;
}

interface AstIndexError {
  filePath: string;
  error: string;
}

export interface AstIndexResult {
  repoAddress: string;
  scannedFiles: number;
  parsedFiles: number;
  storedNodes: number;
  errors: AstIndexError[];
  files_with_ast: number;
  files_without_ast: number;
  language_counts: Record<string, number>;
  supported_extensions: string[];
  status_message: string | null;
}

function serializeAstNode(
  node: Parser.SyntaxNode,
  depth = 0,
): SerializedAstNode {
  const shouldTruncateByDepth = depth >= MAX_AST_DEPTH;
  const childCount = node.childCount;
  const maxChildren = Math.min(childCount, MAX_CHILDREN_PER_NODE);
  const shouldTruncateByChildren = childCount > MAX_CHILDREN_PER_NODE;

  const children: SerializedAstNode[] = [];
  if (!shouldTruncateByDepth) {
    for (let i = 0; i < maxChildren; i += 1) {
      const child = node.child(i);
      if (child) {
        children.push(serializeAstNode(child, depth + 1));
      }
    }
  }

  return {
    type: node.type,
    startIndex: node.startIndex,
    endIndex: node.endIndex,
    startPosition: {
      row: node.startPosition.row,
      column: node.startPosition.column,
    },
    endPosition: {
      row: node.endPosition.row,
      column: node.endPosition.column,
    },
    children,
    truncated: shouldTruncateByDepth || shouldTruncateByChildren || undefined,
  };
}

function extractJavaScriptReferences(sourceCode: string): string[] {
  const references = new Set<string>();

  const fromRegex = /\bfrom\s+["']([^"']+)["']/g;
  let fromMatch = fromRegex.exec(sourceCode);
  while (fromMatch) {
    references.add(fromMatch[1]);
    fromMatch = fromRegex.exec(sourceCode);
  }

  const importRegex = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  let importMatch = importRegex.exec(sourceCode);
  while (importMatch) {
    references.add(importMatch[1]);
    importMatch = importRegex.exec(sourceCode);
  }

  const requireRegex = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
  let requireMatch = requireRegex.exec(sourceCode);
  while (requireMatch) {
    references.add(requireMatch[1]);
    requireMatch = requireRegex.exec(sourceCode);
  }

  return Array.from(references);
}

function extractPythonReferences(sourceCode: string): string[] {
  const references = new Set<string>();

  const importRegex = /^\s*import\s+([a-zA-Z0-9_.,\s]+)\s*$/gm;
  let importMatch = importRegex.exec(sourceCode);
  while (importMatch) {
    const modules = importMatch[1]
      .split(",")
      .map((moduleName) => moduleName.trim().split(/\s+as\s+/)[0]?.trim())
      .filter((moduleName): moduleName is string => Boolean(moduleName));
    for (const moduleName of modules) {
      references.add(moduleName);
    }
    importMatch = importRegex.exec(sourceCode);
  }

  const fromImportRegex = /^\s*from\s+([a-zA-Z0-9_.]+)\s+import\s+/gm;
  let fromImportMatch = fromImportRegex.exec(sourceCode);
  while (fromImportMatch) {
    references.add(fromImportMatch[1]);
    fromImportMatch = fromImportRegex.exec(sourceCode);
  }

  return Array.from(references);
}

function extractReferences(sourceCode: string, extension: string): string[] {
  if (extension === ".py") {
    return extractPythonReferences(sourceCode);
  }

  if (
    extension === ".ts" ||
    extension === ".tsx" ||
    extension === ".js" ||
    extension === ".jsx" ||
    extension === ".mjs" ||
    extension === ".cjs"
  ) {
    return extractJavaScriptReferences(sourceCode);
  }

  return [];
}

function getParserLanguage(extension: string): Parser.Language | null {
  if (extension === ".ts") {
    return typescript;
  }
  if (extension === ".tsx") {
    return tsx;
  }
  if (
    extension === ".js" ||
    extension === ".mjs" ||
    extension === ".cjs"
  ) {
    return javascript;
  }
  if (extension === ".jsx") {
    return jsx;
  }
  if (extension === ".py") {
    return python;
  }

  return null;
}

export async function indexRepositoryAst(repoAddress: string): Promise<AstIndexResult> {
  const parser = new Parser();
  const absoluteRepoPath = path.resolve(repoAddress);
  const sourceFiles = await collectSourceFiles(absoluteRepoPath);

  const nodesToUpsert: ReferenceNode[] = [];
  const errors: AstIndexError[] = [];
  const languageCounts: Record<string, number> = {};

  for (const file of sourceFiles) {
    languageCounts[file.language] = (languageCounts[file.language] ?? 0) + 1;
  }

  let filesWithAst = 0;
  let filesWithoutAst = 0;
  let pythonParserMissingReported = false;

  for (const sourceFile of sourceFiles) {
    let sourceCode: string | null = null;
    try {
      sourceCode = await readFile(sourceFile.absolutePath, "utf-8");
    } catch (error) {
      errors.push({
        filePath: sourceFile.relativePath,
        error: `Failed to read source file: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }

    let ast: SerializedAstNode | null = null;
    const parserLanguage = getParserLanguage(sourceFile.extension);
    if (sourceFile.extension === ".py" && !parserLanguage && !pythonParserMissingReported) {
      pythonParserMissingReported = true;
      errors.push({
        filePath: sourceFile.relativePath,
        error: "Python parser unavailable. Install tree-sitter-python for Python AST support.",
      });
    }

    if (sourceCode && parserLanguage) {
      try {
        parser.setLanguage(parserLanguage);
        const tree = parser.parse(sourceCode);
        ast = serializeAstNode(tree.rootNode);
      } catch (error) {
        errors.push({
          filePath: sourceFile.relativePath,
          error: `Failed to parse source file: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    }

    if (ast) {
      filesWithAst += 1;
    } else {
      filesWithoutAst += 1;
    }

    nodesToUpsert.push({
      subject: sourceFile.relativePath,
      type: "file",
      references: sourceCode
        ? extractReferences(sourceCode, sourceFile.extension)
        : [],
      ast,
      summary: null,
    });
  }

  await replaceReferenceNodes(nodesToUpsert, absoluteRepoPath);

  return {
    repoAddress: absoluteRepoPath,
    scannedFiles: sourceFiles.length,
    parsedFiles: filesWithAst,
    storedNodes: nodesToUpsert.length,
    errors,
    files_with_ast: filesWithAst,
    files_without_ast: filesWithoutAst,
    language_counts: languageCounts,
    supported_extensions: Array.from(SOURCE_EXTENSIONS),
    status_message:
      sourceFiles.length === 0
        ? "No supported source files found for configured extension allowlist."
        : null,
  };
}
