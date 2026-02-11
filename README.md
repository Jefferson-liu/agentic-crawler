# Context Retrieval Agent Test

This repository is a testing ground for context-retrieval work.

It contains:

- A basic React frontend with:
  - chat UI
  - file upload support
- A Mastra-based agent service that:
  - powers agent behavior/orchestration
  - calls your external context backend API for retrieval/context operations

## Goal

Use this project as a sandbox to validate end-to-end behavior between:

- user interactions (chat + uploaded files)
- agent orchestration (Mastra)
- external backend integration

## Repository Structure

- `frontend/`: React + Vite app (runs on `http://localhost:3000`)
- `backend/`: Agent service (Mastra + Express, default `http://localhost:4111`)
- External backend (your service): expected at `http://localhost:8000`

## Local Setup

1. Install dependencies:

```bash
npm install
```

2. Run frontend:

```bash
npm run dev:frontend
```

3. Run agent service:

```bash
npm run dev:backend
```

## Environment

Root `.env` is used by the agent service.

- `PORT=4111` (agent service)
- `FRONTEND_ORIGIN=http://localhost:3000`
- `CONTEXT_API_BASE_URL=http://localhost:8000` (your external backend)

Frontend env (optional) can be set via `frontend/.env`:

```bash
VITE_AGENT_API_BASE_URL=http://localhost:4111
VITE_CONTEXT_API_BASE_URL=http://localhost:8000/
VITE_CONTEXT_SCOPE=
```
