import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface FileSummaryRecord {
  overall_summary: string;
  file_cluster: string[];
  important_relationships: string[];
  group_function: string | null;
  raw_output: string | null;
  updated_at: string;
}

export interface FileSummariesStore {
  version: 1;
  repo_address: string;
  fingerprint: string;
  generated_at: string;
  expected_subjects: string[];
  summaries: Record<string, FileSummaryRecord>;
}

export interface FileSummaryInput {
  overall_summary: string;
  file_cluster?: string[];
  important_relationships?: string[];
  group_function?: string | null;
}

const FILE_SUMMARIES_PATH = path.resolve(process.cwd(), "data/file-summaries.json");

let writeQueue: Promise<void> = Promise.resolve();

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  );
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeSubject(subject: string): string {
  return subject.trim();
}

function parseSummaryRecord(raw: unknown): FileSummaryRecord | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const candidate = raw as {
    subject?: unknown;
    overall_summary?: unknown;
    file_cluster?: unknown;
    important_relationships?: unknown;
    group_function?: unknown;
    raw_output?: unknown;
    updated_at?: unknown;
  };

  const overallSummary =
    typeof candidate.overall_summary === "string"
      ? candidate.overall_summary.trim()
      : "";

  if (!overallSummary) {
    return null;
  }

  return {
    overall_summary: overallSummary,
    file_cluster: normalizeStringArray(candidate.file_cluster),
    important_relationships: normalizeStringArray(candidate.important_relationships),
    group_function: normalizeOptionalString(candidate.group_function),
    raw_output: normalizeOptionalString(candidate.raw_output),
    updated_at:
      typeof candidate.updated_at === "string" && candidate.updated_at.trim().length > 0
        ? candidate.updated_at
        : new Date().toISOString(),
  };
}

function parseFileSummariesStore(raw: unknown): FileSummariesStore | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const candidate = raw as {
    version?: unknown;
    repo_address?: unknown;
    fingerprint?: unknown;
    generated_at?: unknown;
    expected_subjects?: unknown;
    summaries?: unknown;
  };

  if (
    candidate.version !== 1 ||
    typeof candidate.repo_address !== "string" ||
    typeof candidate.fingerprint !== "string" ||
    typeof candidate.generated_at !== "string"
  ) {
    return null;
  }

  const summariesRaw = candidate.summaries;
  const summaries: Record<string, FileSummaryRecord> = {};
  if (summariesRaw && typeof summariesRaw === "object" && !Array.isArray(summariesRaw)) {
    for (const [subject, summaryRaw] of Object.entries(summariesRaw)) {
      const normalizedSubject = normalizeSubject(subject);
      if (!normalizedSubject) {
        continue;
      }

      const parsedRecord = parseSummaryRecord(summaryRaw);
      if (!parsedRecord) {
        continue;
      }

      summaries[normalizedSubject] = parsedRecord;
    }
  }

  return {
    version: 1,
    repo_address: path.resolve(candidate.repo_address),
    fingerprint: candidate.fingerprint,
    generated_at: candidate.generated_at,
    expected_subjects: normalizeStringArray(candidate.expected_subjects),
    summaries,
  };
}

async function withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(operation, operation);
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function saveStore(store: FileSummariesStore): Promise<void> {
  await mkdir(path.dirname(FILE_SUMMARIES_PATH), { recursive: true });
  await writeFile(FILE_SUMMARIES_PATH, `${JSON.stringify(store, null, 2)}\n`, "utf-8");
}

export function getFileSummariesPath(): string {
  return FILE_SUMMARIES_PATH;
}

export async function loadFileSummariesStore(): Promise<FileSummariesStore | null> {
  try {
    const raw = await readFile(FILE_SUMMARIES_PATH, "utf-8");
    return parseFileSummariesStore(JSON.parse(raw) as unknown);
  } catch (error) {
    const fileNotFoundError = error as NodeJS.ErrnoException;
    if (fileNotFoundError.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function prepareFileSummariesStore(
  repoAddress: string,
  fingerprint: string,
  expectedSubjects: string[],
): Promise<FileSummariesStore> {
  const resolvedRepoAddress = path.resolve(repoAddress);
  const store: FileSummariesStore = {
    version: 1,
    repo_address: resolvedRepoAddress,
    fingerprint: fingerprint.trim(),
    generated_at: new Date().toISOString(),
    expected_subjects: normalizeStringArray(expectedSubjects),
    summaries: {},
  };

  await withWriteLock(async () => {
    await saveStore(store);
  });

  return store;
}

export async function writeFileSummaryRecord(
  subject: string,
  summaryInput: FileSummaryInput,
  rawOutput: string | null = null,
): Promise<FileSummaryRecord> {
  const normalizedSubject = normalizeSubject(subject);
  if (!normalizedSubject) {
    throw new Error("subject cannot be empty.");
  }

  const normalizedOverallSummary = summaryInput.overall_summary.trim();
  if (!normalizedOverallSummary) {
    throw new Error("overall_summary cannot be empty.");
  }

  const record: FileSummaryRecord = {
    overall_summary: normalizedOverallSummary,
    file_cluster: normalizeStringArray(summaryInput.file_cluster),
    important_relationships: normalizeStringArray(summaryInput.important_relationships),
    group_function: normalizeOptionalString(summaryInput.group_function),
    raw_output: normalizeOptionalString(rawOutput),
    updated_at: new Date().toISOString(),
  };

  await withWriteLock(async () => {
    const existingStore = await loadFileSummariesStore();
    const fallbackStore: FileSummariesStore = {
      version: 1,
      repo_address: process.cwd(),
      fingerprint: "unknown",
      generated_at: new Date().toISOString(),
      expected_subjects: [],
      summaries: {},
    };

    const store = existingStore ?? fallbackStore;
    store.summaries[normalizedSubject] = record;

    if (!store.expected_subjects.includes(normalizedSubject)) {
      store.expected_subjects.push(normalizedSubject);
    }

    await saveStore(store);
  });

  return record;
}

export function summarizeStoreProgress(store: FileSummariesStore | null): {
  expected_count: number;
  completed_count: number;
  missing_subjects: string[];
} {
  if (!store) {
    return {
      expected_count: 0,
      completed_count: 0,
      missing_subjects: [],
    };
  }

  const completedSubjects = new Set(Object.keys(store.summaries));
  const missingSubjects = store.expected_subjects.filter(
    (subject) => !completedSubjects.has(subject),
  );

  return {
    expected_count: store.expected_subjects.length,
    completed_count: completedSubjects.size,
    missing_subjects: missingSubjects,
  };
}
