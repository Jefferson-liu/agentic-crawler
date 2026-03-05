import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type ReferenceType = "file" | "class" | "func";

export interface ReferenceNode {
  subject: string;
  type: ReferenceType;
  references: string[];
  ast: unknown | null;
  summary: string | null;
}

export interface ReferenceGraphContext {
  repo_address: string | null;
  indexed_at: string | null;
  node_count: number;
  file_node_count: number;
}

interface ReferenceGraphStore {
  repo_address: string | null;
  indexed_at: string | null;
  nodes: ReferenceNode[];
}

const REF_GRAPH_PATH = path.resolve(process.cwd(), "data/ref-graph.json");
let writeQueue: Promise<void> = Promise.resolve();

function normalizeReferences(references: string[]): string[] {
  return Array.from(
    new Set(
      references
        .map((reference) => reference.trim())
        .filter((reference) => reference.length > 0),
    ),
  );
}

function parseReferenceType(rawType: unknown): rawType is ReferenceType {
  return rawType === "file" || rawType === "class" || rawType === "func";
}

function normalizeSummary(summary: unknown): string | null {
  if (typeof summary !== "string") {
    return null;
  }

  const trimmed = summary.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(operation, operation);
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function parseStore(raw: unknown): ReferenceGraphStore {
  if (!raw || typeof raw !== "object" || !("nodes" in raw)) {
    return { repo_address: null, indexed_at: null, nodes: [] };
  }

  const candidate = raw as {
    repo_address?: unknown;
    indexed_at?: unknown;
    nodes?: unknown;
  };

  const nodesRaw = candidate.nodes;
  if (!Array.isArray(nodesRaw)) {
    return { repo_address: null, indexed_at: null, nodes: [] };
  }

  const nodes: ReferenceNode[] = [];
  for (const nodeRaw of nodesRaw) {
    if (!nodeRaw || typeof nodeRaw !== "object") {
      continue;
    }

    const candidate = nodeRaw as {
      subject?: unknown;
      type?: unknown;
      references?: unknown;
      ast?: unknown;
      summary?: unknown;
    };

    if (typeof candidate.subject !== "string" || !parseReferenceType(candidate.type)) {
      continue;
    }

    const references = Array.isArray(candidate.references)
      ? normalizeReferences(
          candidate.references.filter(
            (reference): reference is string => typeof reference === "string",
          ),
        )
      : [];

    nodes.push({
      subject: candidate.subject,
      type: candidate.type,
      references,
      ast: "ast" in candidate ? candidate.ast ?? null : null,
      summary: normalizeSummary(candidate.summary),
    });
  }

  return {
    repo_address:
      typeof candidate.repo_address === "string" && candidate.repo_address.trim().length > 0
        ? path.resolve(candidate.repo_address)
        : null,
    indexed_at:
      typeof candidate.indexed_at === "string" && candidate.indexed_at.trim().length > 0
        ? candidate.indexed_at
        : null,
    nodes,
  };
}

async function loadReferenceGraphStore(): Promise<ReferenceGraphStore> {
  try {
    const raw = await readFile(REF_GRAPH_PATH, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return parseStore(parsed);
  } catch (error) {
    const fileNotFoundError = error as NodeJS.ErrnoException;
    if (fileNotFoundError.code === "ENOENT") {
      return { repo_address: null, indexed_at: null, nodes: [] };
    }
    throw error;
  }
}

async function saveReferenceGraphStore(store: ReferenceGraphStore): Promise<void> {
  await mkdir(path.dirname(REF_GRAPH_PATH), { recursive: true });
  await writeFile(REF_GRAPH_PATH, `${JSON.stringify(store, null, 2)}\n`, "utf-8");
}

function normalizeNode(node: ReferenceNode): ReferenceNode {
  return {
    subject: node.subject.trim(),
    type: node.type,
    references: normalizeReferences(node.references),
    ast: node.ast ?? null,
    summary: normalizeSummary(node.summary),
  };
}

function upsertReferenceNodeInStore(store: ReferenceGraphStore, node: ReferenceNode): void {
  const normalized = normalizeNode(node);
  if (!normalized.subject) {
    throw new Error("Reference node subject cannot be empty.");
  }

  const index = store.nodes.findIndex(
    (existing) =>
      existing.subject === normalized.subject && existing.type === normalized.type,
  );

  if (index >= 0) {
    store.nodes[index] = normalized;
    return;
  }

  store.nodes.push(normalized);
}

export async function listReferenceNodes(): Promise<ReferenceNode[]> {
  const store = await loadReferenceGraphStore();
  return store.nodes;
}

export async function readReferenceGraphContext(): Promise<ReferenceGraphContext> {
  const store = await loadReferenceGraphStore();
  return {
    repo_address: store.repo_address,
    indexed_at: store.indexed_at,
    node_count: store.nodes.length,
    file_node_count: store.nodes.filter((node) => node.type === "file").length,
  };
}

export async function listReferenceSubjects(
  type?: ReferenceType,
): Promise<string[]> {
  const nodes = await listReferenceNodes();
  const filtered = typeof type === "string"
    ? nodes.filter((node) => node.type === type)
    : nodes;

  return Array.from(
    new Set(filtered.map((node) => node.subject)),
  ).sort();
}

export async function readReferenceNode(
  inputSubject: string,
  type: ReferenceType,
): Promise<ReferenceNode | null> {
  const store = await loadReferenceGraphStore();
  const match = store.nodes.find(
    (node) => node.subject === inputSubject && node.type === type,
  );
  return match ?? null;
}

export async function readReferenceGraph(
  inputSubject: string,
  type: ReferenceType,
): Promise<string[]> {
  const match = await readReferenceNode(inputSubject, type);
  return match?.references ?? [];
}

export async function readReferenceAst(
  inputSubject: string,
  type: ReferenceType,
): Promise<unknown | null> {
  const match = await readReferenceNode(inputSubject, type);
  return match?.ast ?? null;
}

export async function upsertReferenceNode(node: ReferenceNode): Promise<void> {
  await withWriteLock(async () => {
    const store = await loadReferenceGraphStore();
    upsertReferenceNodeInStore(store, node);
    await saveReferenceGraphStore(store);
  });
}

export async function upsertReferenceNodes(nodes: ReferenceNode[]): Promise<void> {
  if (nodes.length === 0) {
    return;
  }

  await withWriteLock(async () => {
    const store = await loadReferenceGraphStore();
    for (const node of nodes) {
      const normalized = normalizeNode(node);
      if (!normalized.subject) {
        continue;
      }
      upsertReferenceNodeInStore(store, normalized);
    }
    await saveReferenceGraphStore(store);
  });
}

export async function replaceReferenceNodes(
  nodes: ReferenceNode[],
  repoAddress?: string,
): Promise<void> {
  await withWriteLock(async () => {
    const normalizedNodes: ReferenceNode[] = [];

    for (const node of nodes) {
      const normalized = normalizeNode(node);
      if (!normalized.subject) {
        continue;
      }
      normalizedNodes.push(normalized);
    }

    const store: ReferenceGraphStore = {
      repo_address: typeof repoAddress === "string" ? path.resolve(repoAddress) : null,
      indexed_at: new Date().toISOString(),
      nodes: normalizedNodes,
    };

    await saveReferenceGraphStore(store);
  });
}

export async function writeReferenceAst(
  inputSubject: string,
  type: ReferenceType,
  ast: unknown,
): Promise<void> {
  await withWriteLock(async () => {
    const store = await loadReferenceGraphStore();
    const existing = store.nodes.find(
      (node) => node.subject === inputSubject && node.type === type,
    );
    upsertReferenceNodeInStore(store, {
      subject: inputSubject,
      type,
      references: existing?.references ?? [],
      ast,
      summary: existing?.summary ?? null,
    });
    await saveReferenceGraphStore(store);
  });
}

export async function writeReferenceLinks(
  inputSubject: string,
  type: ReferenceType,
  references: string[],
): Promise<void> {
  await withWriteLock(async () => {
    const store = await loadReferenceGraphStore();
    const existing = store.nodes.find(
      (node) => node.subject === inputSubject && node.type === type,
    );
    upsertReferenceNodeInStore(store, {
      subject: inputSubject,
      type,
      references,
      ast: existing?.ast ?? null,
      summary: existing?.summary ?? null,
    });
    await saveReferenceGraphStore(store);
  });
}

export async function writeReferenceSummary(
  inputSubject: string,
  type: ReferenceType,
  summary: string | null,
): Promise<void> {
  await withWriteLock(async () => {
    const store = await loadReferenceGraphStore();
    const existing = store.nodes.find(
      (node) => node.subject === inputSubject && node.type === type,
    );
    upsertReferenceNodeInStore(store, {
      subject: inputSubject,
      type,
      references: existing?.references ?? [],
      ast: existing?.ast ?? null,
      summary,
    });
    await saveReferenceGraphStore(store);
  });
}
