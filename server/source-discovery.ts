import { readdir } from "node:fs/promises";
import path from "node:path";

export const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".java",
  ".go",
  ".rs",
  ".rb",
  ".php",
  ".cs",
  ".cpp",
  ".cc",
  ".c",
  ".h",
  ".hpp",
  ".kt",
  ".kts",
  ".swift",
  ".scala",
  ".sh",
  ".bash",
  ".zsh",
  ".sql",
] as const;

export const IGNORED_SOURCE_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
  ".venv",
  "venv",
  ".venv-wsl",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "target",
]);

const SOURCE_EXTENSION_SET = new Set<string>(SOURCE_EXTENSIONS);

const SOURCE_LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".java": "java",
  ".go": "go",
  ".rs": "rust",
  ".rb": "ruby",
  ".php": "php",
  ".cs": "csharp",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".c": "c",
  ".h": "c-header",
  ".hpp": "cpp-header",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".swift": "swift",
  ".scala": "scala",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".sql": "sql",
};

export interface SourceFileDescriptor {
  absolutePath: string;
  relativePath: string;
  extension: string;
  language: string;
}

export function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

export function getSourceExtension(filePath: string): string {
  return path.extname(filePath).toLowerCase();
}

export function inferSourceLanguage(extension: string): string {
  return SOURCE_LANGUAGE_BY_EXTENSION[extension] ?? "unknown";
}

export function isSupportedSourceExtension(extension: string): boolean {
  return SOURCE_EXTENSION_SET.has(extension.toLowerCase());
}

export function hasIgnoredDirectory(relativePath: string): boolean {
  const segments = relativePath
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  return segments.some((segment) => IGNORED_SOURCE_DIRS.has(segment));
}

export function isSupportedSourcePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  if (!normalized || hasIgnoredDirectory(normalized)) {
    return false;
  }

  return isSupportedSourceExtension(getSourceExtension(normalized));
}

export async function collectSourceFiles(rootDir: string): Promise<SourceFileDescriptor[]> {
  const absoluteRoot = path.resolve(rootDir);
  const files: SourceFileDescriptor[] = [];

  async function walk(currentDir: string): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (IGNORED_SOURCE_DIRS.has(entry.name)) {
          continue;
        }
        await walk(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const extension = getSourceExtension(entry.name);
      if (!isSupportedSourceExtension(extension)) {
        continue;
      }

      const relativePath = toPosixPath(path.relative(absoluteRoot, fullPath));
      files.push({
        absolutePath: fullPath,
        relativePath,
        extension,
        language: inferSourceLanguage(extension),
      });
    }
  }

  await walk(absoluteRoot);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return files;
}
