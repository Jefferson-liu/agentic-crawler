import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import { collectSourceFiles, isSupportedSourcePath } from "./source-discovery";

const execFile = promisify(execFileCallback);

export interface RepoFingerprint {
  fingerprint: string;
  method: "git-aware-v1" | "hash-scan-v1";
  head: string | null;
  dirty: boolean;
  changed_files: number;
}

function hashString(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

async function computeHashScanFingerprint(repoAddress: string): Promise<RepoFingerprint> {
  const absoluteRepoPath = path.resolve(repoAddress);
  const files = await collectSourceFiles(absoluteRepoPath);
  const hasher = createHash("sha256");

  for (const file of files) {
    const content = await readFile(file.absolutePath, "utf-8");
    hasher.update(`${file.relativePath}\n`);
    hasher.update(content);
    hasher.update("\n");
  }

  const digest = hasher.digest("hex");
  return {
    fingerprint: `hash-scan-v1:${digest}`,
    method: "hash-scan-v1",
    head: null,
    dirty: false,
    changed_files: files.length,
  };
}

function tryParseQuotedPath(pathValue: string): string {
  if (!(pathValue.startsWith("\"") && pathValue.endsWith("\""))) {
    return pathValue;
  }

  try {
    return JSON.parse(pathValue) as string;
  } catch {
    return pathValue.slice(1, -1);
  }
}

function extractPathFromGitStatusLine(line: string): string | null {
  if (!line || line.length < 4) {
    return null;
  }

  const payload = line.slice(3).trim();
  if (!payload) {
    return null;
  }

  const renameDelimiter = " -> ";
  const pathValue = payload.includes(renameDelimiter)
    ? payload.split(renameDelimiter).at(-1) ?? ""
    : payload;

  if (!pathValue) {
    return null;
  }

  const normalizedPath = tryParseQuotedPath(pathValue).replace(/\\/g, "/").trim();
  return normalizedPath.length > 0 ? normalizedPath : null;
}

async function computeGitAwareFingerprint(repoAddress: string): Promise<RepoFingerprint | null> {
  const absoluteRepoPath = path.resolve(repoAddress);

  try {
    const insideRepoResult = await execFile("git", [
      "-C",
      absoluteRepoPath,
      "rev-parse",
      "--is-inside-work-tree",
    ]);
    if (insideRepoResult.stdout.trim() !== "true") {
      return null;
    }
  } catch {
    return null;
  }

  let head = "unknown";
  try {
    const headResult = await execFile("git", ["-C", absoluteRepoPath, "rev-parse", "HEAD"]);
    head = headResult.stdout.trim() || "unknown";
  } catch {
    head = "unknown";
  }

  let statusOutput = "";
  try {
    const statusResult = await execFile("git", [
      "-C",
      absoluteRepoPath,
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]);
    statusOutput = statusResult.stdout;
  } catch {
    statusOutput = "";
  }

  const changedSourcePaths = statusOutput
    .split("\n")
    .map((line) => extractPathFromGitStatusLine(line))
    .filter((relativePath): relativePath is string => Boolean(relativePath))
    .filter((relativePath) => isSupportedSourcePath(relativePath));

  const normalizedStatus = Array.from(new Set(changedSourcePaths))
    .sort()
    .join("\n");

  const changedFiles = normalizedStatus ? normalizedStatus.split("\n").length : 0;
  const statusHash = hashString(normalizedStatus);

  return {
    fingerprint: `git-aware-v1:${head}:${statusHash}`,
    method: "git-aware-v1",
    head: head === "unknown" ? null : head,
    dirty: changedFiles > 0,
    changed_files: changedFiles,
  };
}

export async function computeRepoFingerprint(repoAddress: string): Promise<RepoFingerprint> {
  const gitAware = await computeGitAwareFingerprint(repoAddress);
  if (gitAware) {
    return gitAware;
  }

  return computeHashScanFingerprint(repoAddress);
}
