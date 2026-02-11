# Context Retrieval Agent Test

This repository is a testing ground for context-retrieval backend work.

It contains:

- A basic frontend with:
  - chat UI
  - file upload support
- A backend that:
  - powers an agent using LangGraph
  - calls a context backend API for retrieval and context operations

## Goal

Use this project as a sandbox to validate end-to-end behavior between:

- user interactions (chat + uploaded files)
- agent orchestration (LangGraph)
- external context backend integration

## Planned Architecture

### Frontend

- Minimal chat interface
- File upload flow for attaching context/data
- Requests sent to backend agent endpoint(s)

### Backend

- LangGraph-based agent workflow
- API layer for frontend requests
- Integration client for context backend API
- Response streaming or standard response handling (as needed)

## Development Focus

- Fast iteration for backend context retrieval experiments
- Clear integration boundaries between frontend, agent orchestration, and context services
- Easy local testing of chat + file-driven context flows
