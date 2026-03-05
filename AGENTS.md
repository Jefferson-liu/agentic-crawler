## Project Agent Instructions

This repository is a **TypeScript-first implementation project**.
Repository analysis targets are **language-agnostic** and may be any codebase language.

## Terminology (Critical)

- When the user says **"backend"**, treat that as the **external context backend** (not implemented in this repo).
- In this repo, `backend/` means the **agent service layer** only (Claude-Agent-SDK workflows, tools, orchestration, and API surface for the frontend).
- Do not describe `backend/` as the source of truth for storage/retrieval infrastructure; it is a client/orchestrator of the external backend.

## Stack Defaults

- Frontend framework: **React**
- Agent service framework: **Claude-Agent-SDK**
- Primary implementation language in this repo: **TypeScript**
- Analysis scope for target repositories: **any language supported by the analyzer**

## Repository Structure

- `frontend/`: React app (chat UI + file upload UI).
- `backend/`: Claude-agent-sdk powered agent backend
- Scope new work to the correct folder instead of mixing frontend/backend files in repo root.

## Implementation Rules

- Prefer TypeScript for new code in this repo unless explicitly requested otherwise.
- Do not restrict repository analysis features to TypeScript-only inputs.
- Do not introduce Python services unless explicitly requested.
- Keep frontend/agent-service boundaries clear.
- Frontend (`frontend/`) handles chat UI and file upload UX.
- Agent service (`backend/`) handles orchestration and integration with the external backend.

## Agent Service Direction

- Place agent service implementation files under `backend/`.
- Use Claude agent sdk patterns for agent setup, tools, and workflow orchestration.
- The agent service should expose clean API endpoints for the React app.
- Context retrieval and related operations must be delegated to the external backend API.

## Frontend Direction

- Place frontend implementation files under `frontend/`.
- Build a minimal but clear React interface for:
  - chat interactions
  - file upload interactions
- Keep API client code typed and centralized.

## Environment Conventions

- Store local secrets/config in `.env` (already gitignored).
- Keep committed examples in `.env.example` when needed.
- `localhost:8000` is reserved for the external backend.
- Default the agent service (`backend/`) to a different port (for example `4111`) so both services can run simultaneously.

## Context Backend Contract

- External backend base URL: `http://localhost:8000/`.
- Prefer frontend env names:
  - `VITE_CONTEXT_API_BASE_URL` (default `http://localhost:8000/`)
  - `VITE_CONTEXT_SCOPE` (optional, sent as `X-Scope` header)
- Upload endpoint rules (from backend OpenAPI):
  - Single file upload: `POST /documents` with multipart field `file`
  - Multi-file upload: `POST /documents/bulk` with multipart field `files`
- Common endpoints available for integration:
  - `GET /health`
  - `GET /search?q=...`
  - `GET /data`
  - `GET /data/{data_id}`
  - `DELETE /data/{data_id}`
  - `POST /threads`
- When implementing integrations, follow the provided OpenAPI shapes and do not invent alternate payload formats unless explicitly requested.

This is the explicit openapi contract
{"openapi":"3.1.0","info":{"title":"Graphiti POC API","description":"Minimal FastAPI setup to explore Graphiti-backed knowledge graph.","version":"0.1.0"},"paths":{"/health":{"get":{"summary":"Health check","description":"Basic liveness probe.","operationId":"health_health_get","responses":{"200":{"description":"Successful Response","content":{"application/json":{"schema":{}}}}}}},"/documents":{"post":{"tags":["Documents"],"summary":"Upload Document","operationId":"upload_document_documents_post","parameters":[{"name":"X-Scope","in":"header","required":false,"schema":{"anyOf":[{"type":"string"},{"type":"null"}],"title":"X-Scope"}}],"requestBody":{"required":true,"content":{"multipart/form-data":{"schema":{"$ref":"#/components/schemas/Body_upload_document_documents_post"}}}},"responses":{"201":{"description":"Successful Response","content":{"application/json":{"schema":{"$ref":"#/components/schemas/DataResponse"}}}},"422":{"description":"Validation Error","content":{"application/json":{"schema":{"$ref":"#/components/schemas/HTTPValidationError"}}}}}}},"/documents/bulk":{"post":{"tags":["Documents"],"summary":"Upload Documents Bulk","operationId":"upload_documents_bulk_documents_bulk_post","parameters":[{"name":"X-Scope","in":"header","required":false,"schema":{"anyOf":[{"type":"string"},{"type":"null"}],"title":"X-Scope"}}],"requestBody":{"required":true,"content":{"multipart/form-data":{"schema":{"$ref":"#/components/schemas/Body_upload_documents_bulk_documents_bulk_post"}}}},"responses":{"201":{"description":"Successful Response","content":{"application/json":{"schema":{"$ref":"#/components/schemas/BulkDataResponse"}}}},"422":{"description":"Validation Error","content":{"application/json":{"schema":{"$ref":"#/components/schemas/HTTPValidationError"}}}}}}},"/threads":{"post":{"tags":["Threads"],"summary":"Ingest Thread","operationId":"ingest_thread_threads_post","parameters":[{"name":"X-Scope","in":"header","required":false,"schema":{"anyOf":[{"type":"string"},{"type":"null"}],"title":"X-Scope"}}],"requestBody":{"required":true,"content":{"application/json":{"schema":{"$ref":"#/components/schemas/ThreadCreateRequest"}}}},"responses":{"201":{"description":"Successful Response","content":{"application/json":{"schema":{"$ref":"#/components/schemas/ThreadIngestResponse"}}}},"422":{"description":"Validation Error","content":{"application/json":{"schema":{"$ref":"#/components/schemas/HTTPValidationError"}}}}}}},"/data":{"get":{"tags":["Data"],"summary":"List Data","operationId":"list_data_data_get","parameters":[{"name":"X-Scope","in":"header","required":false,"schema":{"anyOf":[{"type":"string"},{"type":"null"}],"title":"X-Scope"}}],"responses":{"200":{"description":"Successful Response","content":{"application/json":{"schema":{"type":"array","items":{"$ref":"#/components/schemas/DataListItem"},"title":"Response List Data Data Get"}}}},"422":{"description":"Validation Error","content":{"application/json":{"schema":{"$ref":"#/components/schemas/HTTPValidationError"}}}}}}},"/data/{data_id}":{"get":{"tags":["Data"],"summary":"Get Data","operationId":"get_data_data__data_id__get","parameters":[{"name":"data_id","in":"path","required":true,"schema":{"type":"integer","title":"Data Id"}},{"name":"X-Scope","in":"header","required":false,"schema":{"anyOf":[{"type":"string"},{"type":"null"}],"title":"X-Scope"}}],"responses":{"200":{"description":"Successful Response","content":{"application/json":{"schema":{"$ref":"#/components/schemas/DataResponse"}}}},"422":{"description":"Validation Error","content":{"application/json":{"schema":{"$ref":"#/components/schemas/HTTPValidationError"}}}}}},"delete":{"tags":["Data"],"summary":"Delete Data","operationId":"delete_data_data__data_id__delete","parameters":[{"name":"data_id","in":"path","required":true,"schema":{"type":"integer","title":"Data Id"}},{"name":"X-Scope","in":"header","required":false,"schema":{"anyOf":[{"type":"string"},{"type":"null"}],"title":"X-Scope"}}],"responses":{"204":{"description":"Successful Response"},"422":{"description":"Validation Error","content":{"application/json":{"schema":{"$ref":"#/components/schemas/HTTPValidationError"}}}}}}},"/search":{"get":{"tags":["Search"],"summary":"Search","operationId":"search_search_get","parameters":[{"name":"q","in":"query","required":true,"schema":{"type":"string","minLength":1,"description":"Search query","title":"Q"},"description":"Search query"},{"name":"X-Scope","in":"header","required":false,"schema":{"anyOf":[{"type":"string"},{"type":"null"}],"title":"X-Scope"}}],"responses":{"200":{"description":"Successful Response","content":{"application/json":{"schema":{}}}},"422":{"description":"Validation Error","content":{"application/json":{"schema":{"$ref":"#/components/schemas/HTTPValidationError"}}}}}}}},"components":{"schemas":{"Body_upload_document_documents_post":{"properties":{"file":{"type":"string","format":"binary","title":"File"}},"type":"object","required":["file"],"title":"Body_upload_document_documents_post"},"Body_upload_documents_bulk_documents_bulk_post":{"properties":{"files":{"items":{"type":"string","format":"binary"},"type":"array","title":"Files"}},"type":"object","required":["files"],"title":"Body_upload_documents_bulk_documents_bulk_post"},"BulkDataResponse":{"properties":{"successes":{"items":{"$ref":"#/components/schemas/DataResponse"},"type":"array","title":"Successes"},"errors":{"items":{"$ref":"#/components/schemas/BulkIngestError"},"type":"array","title":"Errors"}},"type":"object","title":"BulkDataResponse"},"BulkIngestError":{"properties":{"index":{"type":"integer","title":"Index"},"title":{"anyOf":[{"type":"string"},{"type":"null"}],"title":"Title"},"error":{"type":"string","title":"Error"}},"type":"object","required":["index","error"],"title":"BulkIngestError"},"ChunkResponse":{"properties":{"id":{"type":"integer","title":"Id"},"index":{"type":"integer","title":"Index"},"content":{"type":"string","title":"Content"}},"type":"object","required":["id","index","content"],"title":"ChunkResponse"},"DataListItem":{"properties":{"id":{"type":"integer","title":"Id"},"title":{"type":"string","title":"Title"},"body":{"type":"string","title":"Body"}},"type":"object","required":["id","title","body"],"title":"DataListItem"},"DataResponse":{"properties":{"id":{"type":"integer","title":"Id"},"title":{"type":"string","title":"Title"},"body":{"type":"string","title":"Body"},"chunk_count":{"anyOf":[{"type":"integer"},{"type":"null"}],"title":"Chunk Count"},"chunks":{"anyOf":[{"items":{"$ref":"#/components/schemas/ChunkResponse"},"type":"array"},{"type":"null"}],"title":"Chunks"}},"type":"object","required":["id","title","body"],"title":"DataResponse"},"HTTPValidationError":{"properties":{"detail":{"items":{"$ref":"#/components/schemas/ValidationError"},"type":"array","title":"Detail"}},"type":"object","title":"HTTPValidationError"},"ThreadCreateRequest":{"properties":{"messages":{"items":{"additionalProperties":true,"type":"object"},"type":"array","title":"Messages","description":"Slack-like messages payload"}},"type":"object","required":["messages"],"title":"ThreadCreateRequest"},"ThreadIngestResponse":{"properties":{"id":{"type":"integer","title":"Id"},"title":{"type":"string","title":"Title"},"body":{"type":"string","title":"Body"},"chunk_count":{"anyOf":[{"type":"integer"},{"type":"null"}],"title":"Chunk Count"},"graph_entities":{"anyOf":[{"items":{"additionalProperties":true,"type":"object"},"type":"array"},{"type":"null"}],"title":"Graph Entities"},"graph_edges":{"anyOf":[{"items":{"additionalProperties":true,"type":"object"},"type":"array"},{"type":"null"}],"title":"Graph Edges"},"invalidated_edges":{"anyOf":[{"items":{"additionalProperties":true,"type":"object"},"type":"array"},{"type":"null"}],"title":"Invalidated Edges"}},"type":"object","required":["id","title","body"],"title":"ThreadIngestResponse"},"ValidationError":{"properties":{"loc":{"items":{"anyOf":[{"type":"string"},{"type":"integer"}]},"type":"array","title":"Location"},"msg":{"type":"string","title":"Message"},"type":{"type":"string","title":"Error Type"}},"type":"object","required":["loc","msg","type"],"title":"ValidationError"}}}}
