import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const CONTEXT_SUMMARY_PATH = path.resolve(process.cwd(), "data/summary.md");

export function getContextSummaryPath(): string {
  return CONTEXT_SUMMARY_PATH;
}

export async function writeContextSummary(summary: string): Promise<string> {
  const normalized = summary.trim();
  await mkdir(path.dirname(CONTEXT_SUMMARY_PATH), { recursive: true });
  await writeFile(CONTEXT_SUMMARY_PATH, `${normalized}\n`, "utf-8");
  return CONTEXT_SUMMARY_PATH;
}

export async function readContextSummary(): Promise<string | null> {
  try {
    const content = await readFile(CONTEXT_SUMMARY_PATH, "utf-8");
    const normalized = content.trim();
    return normalized.length > 0 ? normalized : null;
  } catch (error) {
    const fileNotFoundError = error as NodeJS.ErrnoException;
    if (fileNotFoundError.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
