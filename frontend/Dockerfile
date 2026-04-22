FROM node:20-slim

WORKDIR /app

# Copy all workspace manifests — npm workspaces needs all of them present.
COPY package.json package-lock.json* ./
COPY frontend/package.json ./frontend/
COPY backend/package.json ./backend/

RUN npm install

COPY frontend/ ./frontend/

EXPOSE 3000

# Vite dev server — VITE_* env vars set by docker-compose are picked up at
# startup and injected into the bundle served to the browser.
CMD ["npm", "run", "dev", "--workspace=frontend"]
