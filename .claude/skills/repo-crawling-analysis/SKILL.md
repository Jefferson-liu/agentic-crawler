
# Repository Architecture Recovery Skill

## Skill Name
repository-architecture-recovery

## Goal
Analyze a software repository and reconstruct a **business-aligned architectural understanding** of the system using structured repository exploration, reference graphs, and progressive summarization.

This skill prioritizes **tool-driven code analysis over internal model knowledge**.

The workflow mirrors the ArchAgent architecture recovery pipeline, which combines reference indexing, file summarization, and hierarchical synthesis to recover system-level architecture from large repositories.

---

# Core Principle

Always prioritize **MCP tools over model inference**.

Never guess repository structure or relationships when the information can be retrieved using tools.

Repository understanding must be **constructed incrementally**.

---

# Tool Priority Order

Tools must be used in the following priority order.

---

## 1. Repository Structure Discovery

Use first to understand the repository layout.

Tool:
return_directory

Purpose:
- Discover repository structure
- Identify major modules
- Detect entrypoints
- Identify languages and frameworks

Never begin analysis without first calling this tool.

---

## 2. AST Indexing

Build a structural representation of repository dependencies.

Tool:
index_repository_ast

Purpose:
- Generate file/class/function reference graphs
- Enable dependency analysis
- Support downstream summarization

This step corresponds to **reference indexing using ASTs**.

---

## 3. Reference Graph Exploration

Use reference graphs to identify dependency structure.

Tools:
return_reference_graph  
list_reference_subjects

Purpose:
- Discover dependency edges
- Identify central modules
- Detect upstream/downstream relationships
- Find entrypoints

The reference graph should guide **which files are analyzed first**.

---

## 4. File Content Retrieval

Only read files **when necessary**.

Tool:
read_file

Rules:
- Prefer reading files referenced by many others
- Prioritize entrypoints and orchestration logic
- Avoid reading unrelated utility files early

---

## 5. File-Level Summarization

Store structured summaries for each analyzed file.

Tool:
write_file_summary

Summary JSON format:

```

{
"overall_summary": "...",
"file_cluster": ["related/file1", "related/file2"],
"important_relationships": ["dependency1", "dependency2"],
"group_function": "optional high-level module description"
}

```

Important rule:

When summarizing a file:

1. Identify files that depend on it
2. Identify files it depends on
3. Include those relationships in the summary

---

## 6. File Summary Store Initialization

Before summarization begins, initialize the summary store.

Tool:
prepare_file_summaries_store

Purpose:
- Track summarization progress
- Ensure every file is summarized once

---

## 7. Progress Monitoring

Track summarization completion.

Tool:
read_file_summaries

Use this to:

- detect missing summaries
- determine next files to process

---

## 8. Reference Graph Annotation

Attach summaries to reference graph nodes.

Tool:
write_reference_summary

Purpose:
- enable graph-based reasoning
- enrich dependency context

---

## 9. Repository-Level Synthesis

Once file summaries are complete, generate a repository architecture summary.

Tool:
write_context_summary

The output should describe:

- system architecture
- core modules
- execution flows
- business-critical components

---

# Repository Analysis Procedure

Follow this exact sequence.

---

## Step 1 — Discover Repository Structure

Call:

return_directory

Identify:

- main folders
- service boundaries
- frameworks
- potential entrypoints

---

## Step 2 — Build Reference Graph

Call:

index_repository_ast

This produces the dependency graph used for reasoning.

---

## Step 3 — Identify All Subjects

Call:

list_reference_subjects

Collect the list of files that must be summarized.

---

## Step 4 — Initialize Summary Store

Call:

prepare_file_summaries_store

Inputs:

- repository fingerprint
- expected_subjects

---

## Step 5 — Iterative File Analysis

Loop until all summaries are complete.

Procedure:

1. Select next file from missing summaries
2. Call return_reference_graph
3. Retrieve file contents using read_file
4. Generate summary
5. Store summary using write_file_summary

---

## Step 6 — Monitor Progress

Periodically call:

read_file_summaries

Continue until no missing subjects remain.

---

## Step 7 — Architecture Reconstruction

After all files are summarized:

1. Identify entrypoints
2. Trace downstream dependencies
3. Detect major subsystems
4. Detect business logic modules

---

## Step 8 — Generate Final Repository Summary

Write the final architecture summary using:

write_context_summary

The summary should include:

- system overview
- architectural layers
- core services/modules
- key execution flows
- dependency structure

---

# Architectural Reasoning Heuristics

Use these heuristics when interpreting the repository.

### Entrypoint Detection

Common names:

main  
server  
app  
index  
bootstrap  
cli

---

### Service Boundaries

Often appear in folders like:

services/  
controllers/  
handlers/  
modules/  
packages/

---

### Infrastructure vs Business Logic

Infrastructure:

config  
utils  
helpers  
middleware  
logging  
db

Business Logic:

services  
core  
domain  
engine  
pipeline

---

# Constraints

The model **must not**:

- invent repository relationships
- guess file dependencies
- summarize files without reading them
- skip AST indexing
- bypass tool usage

All reasoning must be **grounded in tool outputs**.

---

# Output Format Requirements

File summaries must always include:

overall_summary  
file_cluster  
important_relationships  
group_function

Final repository summaries must include:

System Overview  
Architecture Layers  
Core Modules  
Execution Flows  
Dependency Graph Description

---

# Error Handling

If a tool returns incomplete data:

1. retry the tool
2. check reference graph
3. read additional related files

Never hallucinate missing information.

---

# Key Architecture Insight

Large repositories exceed LLM context windows, so architecture recovery must be performed using **hierarchical summarization and dependency-aware grouping**.

The reconstruction pipeline follows:

code → reference graph → file summaries → repository architecture

