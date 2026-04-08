# AgentBoard — production container image (multi-stage).
#
# Stage 1 (webpack-builder): runs webpack against the Storyboarder web
# config to produce src/build/web-app.js. This file is gitignored in the
# repo (it's a build artifact) so the CI builder must generate it fresh
# rather than relying on whatever happened to exist on the developer's
# laptop. Every deploy rebuilds it from source, reproducibly.
#
# Stage 2 (runtime): slim node:22 image containing ONLY the web-server,
# the src/ tree, and the webpack bundle from stage 1. The Electron /
# desktop Storyboarder code is not included — see .dockerignore.
#
# The image expects a persistent volume to be mounted at
#   /app/web-server/data
# so that the SQLite DB, project files, and the content-addressed blob
# store survive container restarts. Fly.io wires this up via the
# [[mounts]] block in fly.toml.

# ─────────────────────────────────────────────────────────────────────
# Stage 1 — build the webpack bundle
# ─────────────────────────────────────────────────────────────────────
FROM node:22-slim AS webpack-builder

WORKDIR /build

# Some dev-dep install scripts reach out to git URLs (e.g. for
# semver-pinned github refs). Install git + certs so `npm ci` doesn't
# fail midway through.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Skip Electron's postinstall binary download — we're only running
# webpack here, never the desktop app, and the Electron download is
# both flaky and irrelevant for the web build. Combined with
# --ignore-scripts on `npm ci`, this keeps the build fast and robust.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

# Install root deps (webpack, loaders, babel, etc). We copy only the
# manifest first so Docker can cache this layer when package.json hasn't
# changed between deploys.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Copy the source tree and the web webpack config. We deliberately
# don't copy configs/xr, configs/shot-generator etc. — only the web
# config is relevant for this build.
COPY src/ ./src/
COPY configs/web/ ./configs/web/

# Webpack 4 + Node 22 needs the legacy OpenSSL provider for the
# md4-based hash calls the old webpack pipeline uses. Without this
# flag the build aborts with `error:0308010C:digital envelope
# routines::unsupported`.
ENV NODE_OPTIONS=--openssl-legacy-provider

# Run the build. Output lands at src/build/web-app.js.
RUN npm run build:web

# Sanity check — fail the build early if the bundle didn't land.
RUN test -f src/build/web-app.js && \
    echo "webpack bundle OK, size: $(stat -c%s src/build/web-app.js) bytes"

# ─────────────────────────────────────────────────────────────────────
# Stage 2 — runtime image
# ─────────────────────────────────────────────────────────────────────
FROM node:22-slim AS runtime

WORKDIR /app

# Install production dependencies for the web-server only.
# Copying the manifest first lets Docker cache this layer independently
# of the webpack build stage above.
COPY web-server/package.json web-server/package-lock.json ./web-server/
RUN cd web-server && npm ci --omit=dev && npm cache clean --force

# Copy the runtime application source.
# web-server/ is the Express + Socket.io backend.
# src/ is the Storyboarder web UI source (HTML, CSS, images, fonts, etc).
COPY web-server/ ./web-server/
COPY src/ ./src/

# Copy the built webpack bundle from stage 1 into the runtime image.
# This is the critical step — without it, requests to /build/web-app.js
# fall through to the SPA catchall and return HTML, which the browser
# then tries to parse as JavaScript and dies on the first `<`.
COPY --from=webpack-builder /build/src/build/ ./src/build/

# Create the data dir (will be mounted over by the volume in production,
# but needs to exist so the server boots cleanly in non-volume contexts
# like local docker run).
RUN mkdir -p /app/web-server/data/projects /app/web-server/data/blobs \
    && chown -R node:node /app/web-server/data

USER node

EXPOSE 3456

# Health check for Fly.io's load balancer + any other orchestrator.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:3456/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "web-server/server.js"]
