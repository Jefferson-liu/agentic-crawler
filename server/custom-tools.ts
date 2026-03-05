import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import * as path from "path";
import * as dotenv from "dotenv";
import * as fs from "fs";
import type { ReferenceType } from "./reference-graph";
import {
  listReferenceNodes,
  listReferenceSubjects,
  readReferenceGraphContext,
  readReferenceNode,
  writeReferenceSummary,
} from "./reference-graph";
import { indexRepositoryAst } from "./ast-indexer";
import {
  getContextSummaryPath,
  readContextSummary,
  writeContextSummary,
} from "./context-summary";
import { load_prompt } from "./prompt-loader";
import {
  getFileSummariesPath,
  loadFileSummariesStore,
  prepareFileSummariesStore,
  summarizeStoreProgress,
  writeFileSummaryRecord,
} from "./file-summary-store";
import { computeRepoFingerprint } from "./repo-fingerprint";
import { runRepoKnowledgeTeamPipeline } from "./repo-knowledge-team";
import { normalizeRepoPathInput } from "./path-normalization";

const REF_GRAPH_PATH = path.resolve(process.cwd(), "data/ref-graph.json");

// Load environment variables
const envPath = path.join(process.cwd(), ".env");
dotenv.config({ path: envPath });

function resolveRepoAddress(repoAddress?: string): string {
  const normalizedRepoAddress = normalizeRepoPathInput(repoAddress);
  const resolvedPath = path.resolve(normalizedRepoAddress ?? process.cwd());
  if (!fs.existsSync(resolvedPath) || !fs.lstatSync(resolvedPath).isDirectory()) {
    throw new Error(
      `The provided path "${resolvedPath}" does not exist or is not a directory.`,
    );
  }
  return resolvedPath;
}

const fileSummaryPayloadSchema = z.object({
  overall_summary: z.string().min(1),
  file_cluster: z.array(z.string()).optional(),
  important_relationships: z.array(z.string()).optional(),
  group_function: z.string().nullable().optional(),
});

function jsonTextResult(payload: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
}

export const customServer = createSdkMcpServer({
  name: "file",
  version: "0.1",
  tools: [
    tool(
      "return_directory",
      "Get the directory structure of the repository as a tree-like string.",
      {
        repo_address: z
          .string()
          .describe("The address of the repository to analyze. e.g., /home/user/my-repo"),
      },
      async ({ repo_address }) => {
        console.log("==== DIRECTORY STRUCTURE TOOL CALLED ====");
        console.log(`Received repo_address: ${repo_address}`);
        const absoluteRepoPath = resolveRepoAddress(repo_address);

        const getDirectoryTree = (dir: string, prefix = ""): string => {
          let tree = "";
          const items = fs.readdirSync(dir);
          items.forEach((item, index) => {
            const isLast = index === items.length - 1;
            const itemPath = path.join(dir, item);
            tree += `${prefix}${isLast ? "└── " : "├── "}${item}\n`;
            if (fs.lstatSync(itemPath).isDirectory()) {
              tree += getDirectoryTree(itemPath, `${prefix}${isLast ? "    " : "│   "}`);
            }
          });
          return tree;
        };

        const tree = getDirectoryTree(absoluteRepoPath);
        const payload = {
          repo_address: absoluteRepoPath,
          tree,
        };
        return jsonTextResult(payload);
      },
    ),
    tool(
      "read_file",
      "Read the full content of a code file",
      {
        file_path: z.string().describe(
          `The path to the file to read. e.g., /home/user/my-repo/src/index.ts
The file_path can be absolute or relative to the current working directory.`,
        ),
      },
      async ({ file_path }) => {
        console.log("==== READ FILE TOOL CALLED ====");
        console.log(`Received file_path: ${file_path}`);

        const absoluteFilePath = path.resolve(file_path);
        if (!fs.existsSync(absoluteFilePath) || !fs.lstatSync(absoluteFilePath).isFile()) {
          throw new Error(
            `The provided path "${absoluteFilePath}" does not exist or is not a file.`,
          );
        }

        const content = fs.readFileSync(absoluteFilePath, "utf-8");
        const payload = {
          file_path: absoluteFilePath,
          content,
        };
        return jsonTextResult(payload);
      },
    ),
    tool(
      "return_reference_graph",
      "Retrieve the reference and reverse-reference graph for a file, class, or function",
      {
        input_subject: z
          .string()
          .describe("The subject for which to return the reference graph."),
        type: z
          .enum(["file", "class", "func"])
          .describe('The type can be one of "file", "class", or "func".'),
      },
      async ({ input_subject, type }) => {
        console.log("==== RETURN REFERENCE GRAPH TOOL CALLED ====");
        console.log(`Received input_subject: ${input_subject}`);
        console.log(`Received type: ${type}`);

        const normalizedSubject = input_subject.trim();
        if (!normalizedSubject) {
          throw new Error("input_subject cannot be empty.");
        }

        const normalizedType = type as ReferenceType;
        const node = await readReferenceNode(normalizedSubject, normalizedType);
        const allNodes = await listReferenceNodes();

        const reverseReferences = allNodes
          .filter((candidate) => candidate.references.includes(normalizedSubject))
          .map((candidate) => ({
            subject: candidate.subject,
            type: candidate.type,
          }));

        const payload = {
          found: Boolean(node),
          subject: normalizedSubject,
          type: normalizedType,
          references: node?.references ?? [],
          reverse_references: reverseReferences,
        };
        return jsonTextResult(payload);
      },
    ),
    tool(
      "write_reference_summary",
      "Write or update a summary for a file, class, or function reference-graph node",
      {
        input_subject: z
          .string()
          .describe("The subject whose summary should be stored."),
        type: z
          .enum(["file", "class", "func"])
          .describe('The type can be one of "file", "class", or "func".'),
        summary: z
          .string()
          .nullable()
          .describe("Summary text to store. Use null to clear existing summary."),
      },
      async ({ input_subject, type, summary }) => {
        console.log("==== WRITE REFERENCE SUMMARY TOOL CALLED ====");
        console.log(`Received input_subject: ${input_subject}`);
        console.log(`Received type: ${type}`);

        const normalizedSubject = input_subject.trim();
        if (!normalizedSubject) {
          throw new Error("input_subject cannot be empty.");
        }

        const normalizedType = type as ReferenceType;
        await writeReferenceSummary(normalizedSubject, normalizedType, summary);

        const payload = {
          success: true,
          subject: normalizedSubject,
          type: normalizedType,
          summary,
        };
        return jsonTextResult(payload);
      },
    ),
    tool(
      "index_repository_ast",
      "Index supported source files in a repository, storing per-file references and ASTs when parser support exists.",
      {
        repo_address: z
          .string()
          .optional()
          .describe("Absolute or relative path to the repository root."),
      },
      async ({ repo_address }) => {
        console.log("==== INDEX REPOSITORY AST TOOL CALLED ====");
        console.log(`Received repo_address: ${repo_address ?? "(default cwd)"}`);

        const absoluteRepoPath = resolveRepoAddress(repo_address);
        const indexResult = await indexRepositoryAst(absoluteRepoPath);
        const payload = {
          repo_address: absoluteRepoPath,
          index_result: indexResult,
        };
        return jsonTextResult(payload);
      },
    ),
    tool(
      "get_repo_knowledge_status",
      "Return cache validity and freshness information for repo knowledge artifacts.",
      {
        repo_address: z
          .string()
          .optional()
          .describe("Absolute or relative path to the repository root. Defaults to current working directory."),
        force_refresh: z
          .boolean()
          .optional()
          .describe("Set true to force a rebuild regardless of cache validity."),
      },
      async ({ repo_address, force_refresh }) => {
        console.log("==== GET REPO KNOWLEDGE STATUS TOOL CALLED ====");

        const absoluteRepoPath = resolveRepoAddress(repo_address);
        const forceRefresh = force_refresh ?? false;
        const fingerprint = await computeRepoFingerprint(absoluteRepoPath);
        const store = await loadFileSummariesStore();
        const refGraphContext = await readReferenceGraphContext();

        const summaryExists = fs.existsSync(getContextSummaryPath());
        const refGraphExists = fs.existsSync(REF_GRAPH_PATH);
        const fileSummariesExists = fs.existsSync(getFileSummariesPath());

        const matchesRepo = store?.repo_address === absoluteRepoPath;
        const matchesFingerprint = store?.fingerprint === fingerprint.fingerprint;
        const refGraphRepoMatches = refGraphContext.repo_address === absoluteRepoPath;
        const hasAllArtifacts = summaryExists && refGraphExists && fileSummariesExists;
        const progress = summarizeStoreProgress(store);
        const progressComplete =
          progress.expected_count === 0 || progress.completed_count >= progress.expected_count;
        const cacheInvalidReasons: string[] = [];
        if (forceRefresh) {
          cacheInvalidReasons.push("force_refresh_requested");
        }
        if (!hasAllArtifacts) {
          cacheInvalidReasons.push("missing_required_artifacts");
        }
        if (!store) {
          cacheInvalidReasons.push("file_summaries_store_missing");
        }
        if (!matchesRepo) {
          cacheInvalidReasons.push("store_repo_mismatch");
        }
        if (!matchesFingerprint) {
          cacheInvalidReasons.push("store_fingerprint_mismatch");
        }
        if (!refGraphRepoMatches) {
          cacheInvalidReasons.push("ref_graph_repo_mismatch");
        }
        if (!progressComplete) {
          cacheInvalidReasons.push("file_summaries_incomplete");
        }
        const cacheValid = cacheInvalidReasons.length === 0;

        const payload = {
          repo_address: absoluteRepoPath,
          force_refresh: forceRefresh,
          cache_valid: cacheValid,
          has_all_artifacts: hasAllArtifacts,
          summary_exists: summaryExists,
          ref_graph_exists: refGraphExists,
          file_summaries_exists: fileSummariesExists,
          store_repo_matches: Boolean(matchesRepo),
          store_fingerprint_matches: Boolean(matchesFingerprint),
          ref_graph_repo_address: refGraphContext.repo_address,
          ref_graph_repo_matches: refGraphRepoMatches,
          ref_graph_indexed_at: refGraphContext.indexed_at,
          ref_graph_node_count: refGraphContext.node_count,
          ref_graph_file_node_count: refGraphContext.file_node_count,
          store_fingerprint: store?.fingerprint ?? null,
          current_fingerprint: fingerprint.fingerprint,
          fingerprint_method: fingerprint.method,
          fingerprint_head: fingerprint.head,
          fingerprint_dirty: fingerprint.dirty,
          fingerprint_changed_files: fingerprint.changed_files,
          progress_complete: progressComplete,
          cache_invalid_reasons: cacheInvalidReasons,
          progress,
        };
        return jsonTextResult(payload);
      },
    ),
    tool(
      "run_repo_knowledge_team_pipeline",
      "Run the service-level repo knowledge pipeline (index, summarize queue, context generation) without nested subagent spawning.",
      {
        repo_address: z
          .string()
          .optional()
          .describe("Absolute or relative path to the repository root. Defaults to current working directory."),
        force_refresh: z
          .boolean()
          .optional()
          .describe("Set true to force a rebuild regardless of cache validity."),
        chat_id: z
          .string()
          .optional()
          .describe("Optional chat/session id used for websocket repo_progress events."),
      },
      async ({ repo_address, force_refresh, chat_id }) => {
        console.log("==== RUN REPO KNOWLEDGE TEAM PIPELINE TOOL CALLED ====");

        const report = await runRepoKnowledgeTeamPipeline({
          repo_address,
          force_refresh,
          chat_id,
          mcp_server: customServer,
        });

        const payload = {
          success: true,
          ...report,
        };
        return jsonTextResult(payload);
      },
    ),
    tool(
      "list_reference_subjects",
      "List reference graph subjects, optionally filtered by node type.",
      {
        type: z
          .enum(["file", "class", "func"])
          .optional()
          .describe("Optional node type filter. Defaults to file."),
      },
      async ({ type }) => {
        console.log("==== LIST REFERENCE SUBJECTS TOOL CALLED ====");
        const normalizedType = (type ?? "file") as ReferenceType;
        const subjects = await listReferenceSubjects(normalizedType);

        const payload = {
          type: normalizedType,
          count: subjects.length,
          subjects,
        };
        return jsonTextResult(payload);
      },
    ),
    tool(
      "prepare_file_summaries_store",
      "Initialize or reset data/file-summaries.json for a new repo-knowledge generation run.",
      {
        repo_address: z
          .string()
          .optional()
          .describe("Absolute or relative path to the repository root. Defaults to current working directory."),
        fingerprint: z.string().min(1).describe("Repo fingerprint string for this run."),
        expected_subjects: z
          .array(z.string())
          .describe("Complete list of file subjects expected to be summarized."),
      },
      async ({ repo_address, fingerprint, expected_subjects }) => {
        console.log("==== PREPARE FILE SUMMARIES STORE TOOL CALLED ====");

        const absoluteRepoPath = resolveRepoAddress(repo_address);
        const store = await prepareFileSummariesStore(
          absoluteRepoPath,
          fingerprint,
          expected_subjects,
        );

        const payload = {
          success: true,
          output_path: getFileSummariesPath(),
          repo_address: store.repo_address,
          fingerprint: store.fingerprint,
          expected_count: store.expected_subjects.length,
        };
        return jsonTextResult(payload);
      },
    ),
    tool(
      "write_file_summary",
      "Write a structured summary entry for a file into data/file-summaries.json.",
      {
        subject: z.string().describe("File subject/path key in the reference graph."),
        summary_json: fileSummaryPayloadSchema,
        raw_output: z
          .string()
          .nullable()
          .optional()
          .describe("Optional raw model output for traceability."),
      },
      async ({ subject, summary_json, raw_output }) => {
        console.log("==== WRITE FILE SUMMARY TOOL CALLED ====");

        const normalizedSubject = subject.trim();
        if (!normalizedSubject) {
          throw new Error("subject cannot be empty.");
        }

        const record = await writeFileSummaryRecord(
          normalizedSubject,
          summary_json,
          raw_output ?? null,
        );
        await writeReferenceSummary(normalizedSubject, "file", record.overall_summary);

        const payload = {
          success: true,
          output_path: getFileSummariesPath(),
          subject: normalizedSubject,
          overall_summary: record.overall_summary,
          updated_at: record.updated_at,
        };
        return jsonTextResult(payload);
      },
    ),
    tool(
      "read_file_summaries",
      "Read data/file-summaries.json and return progress plus missing subjects.",
      {
        repo_address: z
          .string()
          .optional()
          .describe("Absolute or relative path to the repository root. Defaults to current working directory."),
      },
      async ({ repo_address }) => {
        console.log("==== READ FILE SUMMARIES TOOL CALLED ====");

        const absoluteRepoPath = resolveRepoAddress(repo_address);
        const store = await loadFileSummariesStore();
        const progress = summarizeStoreProgress(store);

        const payload = {
          found: Boolean(store),
          output_path: getFileSummariesPath(),
          repo_address: absoluteRepoPath,
          store_repo_address: store?.repo_address ?? null,
          store_repo_matches: store?.repo_address === absoluteRepoPath,
          fingerprint: store?.fingerprint ?? null,
          generated_at: store?.generated_at ?? null,
          progress,
          summaries: store?.summaries ?? {},
        };
        return jsonTextResult(payload);
      },
    ),
    tool(
      "write_context_summary",
      "Write the generated repository context summary markdown to data/summary.md",
      {
        summary_markdown: z
          .string()
          .describe("Full markdown content to persist as the context summary."),
      },
      async ({ summary_markdown }) => {
        console.log("==== WRITE CONTEXT SUMMARY TOOL CALLED ====");

        const outputPath = await writeContextSummary(summary_markdown);
        const payload = {
          success: true,
          output_path: outputPath,
        };
        return jsonTextResult(payload);
      },
    ),
    tool(
      "read_context_summary",
      "Read data/summary.md if it exists.",
      {},
      async () => {
        console.log("==== READ CONTEXT SUMMARY TOOL CALLED ====");
        const content = await readContextSummary();

        const payload = {
          found: Boolean(content),
          output_path: getContextSummaryPath(),
          content,
        };
        return jsonTextResult(payload);
      },
    ),
    tool(
      "load_prompt",
      "Load a prompt template from server/prompts by name",
      {
        prompt_name: z
          .string()
          .describe(
            "Prompt file name with or without .txt (example: context_generator or context_generator.txt).",
          ),
      },
      async ({ prompt_name }) => {
        console.log("==== LOAD PROMPT TOOL CALLED ====");
        const content = await load_prompt(prompt_name);
        const payload = { prompt_name, content };
        return jsonTextResult(payload);
      },
    ),
  ],
});
