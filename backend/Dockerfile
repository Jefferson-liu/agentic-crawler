FROM node:20-slim

WORKDIR /app

# Copy all workspace manifests so npm can resolve the workspace graph.
# The lock file lives at the monorepo root, so copy it from there too.
COPY package.json package-lock.json* ./
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/

RUN npm install

COPY backend/ ./backend/

# ../data/mastra.db (in agent.ts) resolves to /app/data/mastra.db when
# the working directory is /app/backend — create it so libsql can open it.
RUN mkdir -p /app/data

WORKDIR /app/backend

EXPOSE 4111

CMD ["npx", "tsx", "src/index.ts"]
