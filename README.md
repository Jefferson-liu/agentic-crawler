# Simple Chat App

A demo chat application using the Claude Agent SDK with a React frontend and Express backend.

![Architecture Diagram](diagram.png)

## Getting Started

### Prerequisites

- Node.js 18+
- Claude Agent SDK credentials (set `ANTHROPIC_API_KEY`)

### Installation

```bash
npm install
```

### Running

```bash
npm run dev
```

This starts both services:
- Backend (Express + WebSocket) on `http://localhost:4111`
- Frontend (Vite + React) on `http://localhost:5173`

Open `http://localhost:5173` in your browser.

## Skill-Based Repo Analysis

Repository crawling and architecture analysis are orchestrated by a project skill:
- Skill path: `.claude/skills/repo-crawling-analysis/SKILL.md`
- Runtime toggle: `REPO_ANALYSIS_SKILL_ENABLED=1` (default enabled)
- Skill discovery source: SDK settings sources `user` + `project`

When enabled, the agent can invoke the `Skill` tool and then use the repo MCP tools for deterministic crawl steps.

### Refresh command

Use `/repo refresh` in chat to force rebuild (index + summary regeneration) instead of cache reuse.

## Debug Tips

- Watch backend logs for skill lifecycle lines:
  - `[skill][session=...][turn=...] started ...`
  - `[skill][session=...][turn=...] completed ...`
- Tool stream in the UI will show `Skill` tool calls with `_is_skill_invocation: true` metadata.
- If you need to disable skills temporarily, set `REPO_ANALYSIS_SKILL_ENABLED=0`.

## Features

- Multi-chat UI with persistent in-memory transcript per chat
- Live assistant/tool-use streaming over WebSocket
- Per-turn and per-chat assistant cost tracking
- Skill-driven repository analysis orchestration

## Production Considerations

This is an example app for demonstration purposes. For production use, consider:

1. Isolate the Agent SDK in a separate service/container.
2. Replace the in-memory `ChatStore` with persistent storage.
3. Persist and restore SDK conversation transcripts across restarts.
4. Add authentication and authorization.

## Demo

![Demo](demo.gif)
