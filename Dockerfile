# AgentBoard — production container image
#
# Builds an image containing ONLY the web-server and the compiled web UI.
# None of the Electron / desktop Storyboarder / webpack-watcher / XR /
# shot-generator code is needed at runtime — see .dockerignore for the
# exclusions that keep this image small.
#
# The image expects a persistent volume to be mounted at
#   /app/web-server/data
# so that the SQLite DB, project files, and the content-addressed blob
# store survive container restarts. Fly.io deploys wire this up via the
# [[mounts]] block in fly.toml.

FROM node:22-slim AS base

# Security: run as the non-root 'node' user that the official image provides.
# /app needs to be writable by that user at build time.
WORKDIR /app

# ── 1. Install production dependencies only ──
# Copy the manifest first so Docker can cache the npm install layer when
# nothing in package.json changes.
COPY web-server/package.json web-server/package-lock.json ./web-server/
RUN cd web-server && npm ci --omit=dev && npm cache clean --force

# ── 2. Copy the application source ──
# We need the web-server code AND the src/ directory, because server.js
# serves the compiled Storyboarder web UI (src/web-app.html + the 2.6 MB
# webpack bundle at src/build/web-app.js) from the root URL.
COPY web-server/ ./web-server/
COPY src/ ./src/

# ── 3. Create the data directory (will be mounted over by the volume) ──
# If the volume isn't mounted (e.g. local Docker run), these dirs exist so
# the server still boots and writes to the container's local filesystem.
RUN mkdir -p /app/web-server/data/projects /app/web-server/data/blobs

# The data dir needs to be owned by 'node' so the server can write to it
# when running as that user.
RUN chown -R node:node /app/web-server/data

USER node

# ── 4. Runtime config ──
# Port the server listens on. Fly.io forwards 80/443 → this internal port
# via the [[services.ports]] block in fly.toml.
EXPOSE 3456

# Health check — Fly.io's load balancer uses this to decide when the
# container is ready to serve traffic. We use the same /api/health
# endpoint that's documented in the readiness probe runbook.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:3456/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# ── 5. Launch ──
# node 22 has the global fetch() needed by the healthcheck above and by
# several of our service modules (image-gen, tts). No extra deps required.
CMD ["node", "web-server/server.js"]
