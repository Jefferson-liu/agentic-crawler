## Project Agent Instructions

This repository is a **TypeScript-first** project.

## Terminology (Critical)

- When the user says **"backend"**, treat that as the **external context backend** (not implemented in this repo).
- In this repo, `backend/` means the **agent service layer** only (Mastra workflows, tools, orchestration, and API surface for the frontend).
- Do not describe `backend/` as the source of truth for storage/retrieval infrastructure; it is a client/orchestrator of the external backend.

## Stack Defaults

- Frontend framework: **React**
- Agent service framework: **Mastra**
- Primary language across frontend and backend: **TypeScript**

## Repository Structure

- `frontend/`: React app (chat UI + file upload UI).
- `backend/`: Mastra-powered agent service/API layer for orchestration.
- Scope new work to the correct folder instead of mixing frontend/backend files in repo root.

## Implementation Rules

- Prefer TypeScript for all new code, scripts, and examples.
- Do not introduce Python services unless explicitly requested.
- Keep frontend/agent-service boundaries clear.
- Frontend (`frontend/`) handles chat UI and file upload UX.
- Agent service (`backend/`) handles orchestration and integration with the external backend.

## Agent Service Direction

- Place agent service implementation files under `backend/`.
- Use Mastra patterns for agent setup, tools, and workflow orchestration.
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
