import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";

const PROMPTS_DIR = path.resolve(process.cwd(), "server/prompts");

function resolvePromptPath(promptName: string): string {
  const normalizedName = promptName.trim();
  if (!normalizedName) {
    throw new Error("promptName cannot be empty.");
  }

  const fileName = normalizedName.endsWith(".txt")
    ? normalizedName
    : `${normalizedName}.txt`;
  const promptPath = path.resolve(PROMPTS_DIR, fileName);

  // Prevent path traversal outside the prompts directory.
  if (!promptPath.startsWith(`${PROMPTS_DIR}${path.sep}`)) {
    throw new Error("Invalid prompt path.");
  }

  return promptPath;
}

export async function load_prompt(promptName: string): Promise<string> {
  return readFile(resolvePromptPath(promptName), "utf-8");
}

export function load_prompt_sync(promptName: string): string {
  return readFileSync(resolvePromptPath(promptName), "utf-8");
}
