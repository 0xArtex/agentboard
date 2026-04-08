// Load .env FIRST, before any module reads from process.env. Silent if
// the file isn't there — production sets env vars via the hosting
// platform's secrets manager instead of a file on disk.
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express = require('express');
const http = require('http');
const { Server: SocketIO } = require('socket.io');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs-extra');

const { errorHandler } = require('./middleware/error-handler');
const { setupSocketHandler } = require('./services/socket-handler');

// Routes
const projectsRouter = require('./routes/projects');
const filesRouter = require('./routes/files');
const prefsRouter = require('./routes/prefs');
const agentRouter = require('./routes/agent');
const agentsRouter = require('./routes/agents');

// Agent auth middleware — stamps req.agent on every request
const { agentAuthMiddleware } = require('./middleware/agent-auth');

const PORT = process.env.PORT || 3456;

// ── Repo root (one level above web-server/) ──
const REPO_ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(REPO_ROOT, 'src');

// ── App setup ──
const app = express();
const server = http.createServer(app);

// Socket.io (allowEIO3=true so v2 clients can connect)
const io = new SocketIO(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  allowEIO3: true,
});
const socketHandler = setupSocketHandler(io);
app.locals.socketHandler = socketHandler;

// ── Middleware ──
app.use(cors());
app.use(morgan('dev'));
// Body parser limits — sized to allow batch uploads of high-res storyboard
// images (256MB cap per image × base64 1.33x overhead × ~1 image safety
// margin = ~400MB ceiling). Caps are enforced per-upload by enforceUploadLimits
// in routes/agent.js, so this limit only protects the parser from total nonsense.
app.use(express.json({ limit: '400mb' }));
app.use(express.urlencoded({ extended: true, limit: '400mb' }));
// Raw body parser for binary file writes
app.use('/api/fs/write', express.raw({ type: '*/*', limit: '400mb' }));

// Agent identity: stamp req.agent on every /api/* request.
// In dev (AGENT_AUTH_ENABLED=0) anonymous access is attributed to the
// built-in default user; in prod (=1), mutations require a bearer token.
app.use('/api', agentAuthMiddleware);

// ── Ensure data directories exist ──
const DATA_DIR = path.join(__dirname, 'data');
fs.ensureDirSync(path.join(DATA_DIR, 'projects'));

// ── API Routes ──
app.use('/api/projects', projectsRouter);
app.use('/api/projects', filesRouter);
app.use('/api/prefs', prefsRouter);
app.use('/api/agent', agentRouter);
app.use('/api/agents', agentsRouter);

// ── Health check ──
// Returns operational status plus a fingerprint of which providers and
// backends are currently active. Meant for both human eyeballing during
// debugging AND for deploy-time readiness probes (uptime monitors,
// Kubernetes liveness checks, etc). Never touches the network — reports
// only what's locally observable without external calls.
app.get('/api/health', (req, res) => {
  const pkg = require('./package.json');
  const { blobStore } = require('./services/blob-store');
  const x402 = require('./services/x402');
  const imageGen = require('./services/image-gen');
  const tts = require('./services/tts');
  const x402Cfg = x402.getConfig();
  res.json({
    status: 'ok',
    version: pkg.version,
    uptime: Math.round(process.uptime()),
    backends: {
      blob: blobStore.backend,               // 'disk' | 'r2'
      imageGen: imageGen.getProvider().name, // 'mock' | 'fal-ai'
      tts: tts.getProvider().name,           // 'mock' | 'elevenlabs'
    },
    x402: {
      enabled: x402Cfg.enabled,
      mode: x402Cfg.mode,                    // 'off' | 'mock' | 'facilitator' | 'chain'
      network: x402Cfg.network,
    },
    auth: {
      enforced: process.env.AGENT_AUTH_ENABLED === '1',
    },
    rateLimits: {
      frequency: process.env.RATE_LIMIT_ENABLED === '1',
      spend: process.env.SPEND_LIMIT_ENABLED === '1',
    },
  });
});

// ── Filesystem API (used by electron-shim fs shim) ──
const fsRouter = require('./routes/fs-api');
app.use('/api/fs', fsRouter);



// ── Static files: serve the web app from src/ ──
// Serve static assets from src/ (CSS, JS bundles, images, data, etc.)
app.use(express.static(SRC_DIR, {
  // Don't serve index.html from static — we handle that explicitly
  index: false,
}));

// Also serve src/ under /src/ for webpack's __dirname-based paths
// (e.g. path.join('/src/js/window', '..', '..', 'data', 'brushes') = '/src/data/brushes')
app.use('/src', express.static(SRC_DIR, { index: false }));

// Serve node_modules that the HTML might reference (e.g. socket.io-client)
app.use('/node_modules', express.static(path.join(REPO_ROOT, 'node_modules')));

// Also serve web-server/data for project files accessible via /data/
app.use('/server-data', express.static(DATA_DIR));

// Serve project asset images at /web/projects/<uuid>/images/<filename>.
//
// This is the URL the browser hits when main-window.js does
//   new Image().src = '/web/projects/<uuid>/images/board-1-ABCDE-fill.png?<mtime>'
// for layer + posterframe + thumbnail loads. We translate the legacy
// filename through the project-store, look up the current blob hash for
// that (board, kind), and stream the bytes from the BlobStore.
const projectStore = require('./services/project-store');
const { blobStore } = require('./services/blob-store');
const PROJECT_UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

app.get('/web/projects/:uuid/images/:filename', async (req, res) => {
  const { uuid, filename } = req.params;
  if (!PROJECT_UUID_RE.test(uuid)) {
    return res.status(400).send('Invalid project id');
  }
  const asset = projectStore.resolveLegacyAsset(uuid, filename);
  if (!asset) {
    return res.status(404).send('Asset not found');
  }

  res.setHeader('Cache-Control', 'public, max-age=300');

  // Backend branch: DiskBlobStore returns a local file path synchronously,
  // R2BlobStore returns a (possibly presigned) URL from an async method.
  // Disk: stream the file directly via res.sendFile.
  // R2:   302-redirect the browser to the presigned/public URL so traffic
  //       doesn't proxy through our Node process.
  if (blobStore.backend === 'r2') {
    const url = await blobStore.pathOf(asset.hash);
    if (!url) return res.status(404).send('Blob missing');
    return res.redirect(302, url);
  }
  const fp = blobStore.pathOf(asset.hash);
  if (!fp) {
    return res.status(404).send('Blob missing on disk');
  }
  res.type(asset.mime || 'application/octet-stream');
  return res.sendFile(fp);
});

// Public read-only storyboard viewer. Mounted BEFORE the SPA catchall so
// /view/<uuid> is served as a dedicated HTML page instead of returning
// the editor shell. The agent-auth middleware runs here so owners of
// gated projects can still access their own work via bearer token.
const viewRouter = require('./routes/view');
app.use('/view', agentAuthMiddleware, viewRouter);

// Anything else under /web/projects/:uuid that isn't an image goes through
// the legacy /api/fs/read shim path, which now also routes through SQLite
// for project assets and disk for everything else (project.storyboarder is
// served via /api/projects/:id and cached client-side, so this fallback is
// rarely hit but kept for completeness).

// ── Root route: serve the web app HTML ──
app.get('/', (req, res) => {
  const htmlPath = path.join(SRC_DIR, 'web-app.html');
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    res.status(404).send('web-app.html not found. Run the webpack build first.');
  }
});

// ── SPA fallback for non-API routes ──
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  // Try to serve from src/ first, then fall back to HTML
  const filePath = path.join(SRC_DIR, req.path);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    return res.sendFile(filePath);
  }
  // SPA fallback
  const htmlPath = path.join(SRC_DIR, 'web-app.html');
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    next();
  }
});

// ── Error handler (must be last) ──
app.use(errorHandler);

// ── Seed optional userData files so first-load reads don't 404 ──
//
// The desktop app stores small bits of state under app.getPath('userData').
// Our virtual /web/userData mount maps to web-server/data, so on a fresh
// install these files don't exist and the client logs noisy 404s for things
// that are perfectly fine to be empty (e.g. the pomodoro recordings list).
// Pre-creating them with sane empty defaults keeps the network panel clean
// without papering over genuine read failures elsewhere.
async function ensureUserDataDefaults() {
  const defaults = [
    { relPath: 'recordings.json', body: [] },
  ];
  for (const { relPath, body } of defaults) {
    const fp = path.join(DATA_DIR, relPath);
    if (!(await fs.pathExists(fp))) {
      await fs.ensureDir(path.dirname(fp));
      await fs.writeJson(fp, body, { spaces: 2 });
    }
  }
}

// ── Create default project on startup if none exist ──
async function ensureDefaultProject() {
  const store = require('./services/project-store');
  const projects = await store.listProjects();
  if (projects.length === 0) {
    console.log('📋 No projects found, creating default project...');
    const { id } = await store.createProject({
      aspectRatio: 1.7777,
      fps: 24,
      defaultBoardTiming: 2000,
    });

    // Pre-name the fill layer so addBoard's blank-PNG synthesis writes it.
    // The filename format `board-<num>-<uid>-fill.png` is what
    // boardModel.boardFilenameForLayer expects when the renderer asks for the
    // fill layer.
    const uid = store.generateBoardUid();
    const board = await store.addBoard(id, {
      uid,
      dialogue: '',
      action: '',
      notes: '',
      layers: {
        fill: { url: `board-1-${uid}-fill.png` },
      },
    });
    console.log(`📋 Created default project: ${id} (board uid=${board.uid})`);
  }
}

// ── Start ──
server.listen(PORT, async () => {
  console.log(`\n🎬 Storyboarder Web Server running on http://localhost:${PORT}`);
  console.log(`   API:       http://localhost:${PORT}/api`);
  console.log(`   WebSocket: ws://localhost:${PORT}`);
  console.log(`   Health:    http://localhost:${PORT}/api/health`);
  console.log(`   Web App:   http://localhost:${PORT}/\n`);

  await ensureUserDataDefaults();
  await ensureDefaultProject();
});

// ── Graceful shutdown ──
//
// Production deploys (systemd, Docker, Fly.io, Railway) send SIGTERM
// when stopping the process. We need to:
//   1. Stop accepting new HTTP connections
//   2. Let in-flight requests finish (up to a timeout)
//   3. Close the socket.io server (disconnects websocket clients cleanly)
//   4. Close the SQLite connection so the WAL is flushed to the main DB
//   5. Exit with code 0
//
// If shutdown takes longer than FORCE_EXIT_MS, we log a warning and
// exit anyway — better to drop a few in-flight requests than hang
// forever under load.
let shuttingDown = false;
const FORCE_EXIT_MS = 10_000;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[server] received ${signal}, starting graceful shutdown...`);

  const forceTimer = setTimeout(() => {
    console.warn(`[server] shutdown exceeded ${FORCE_EXIT_MS}ms, forcing exit`);
    process.exit(1);
  }, FORCE_EXIT_MS);
  forceTimer.unref();

  // 1. stop accepting new connections
  server.close((err) => {
    if (err) {
      console.error('[server] HTTP close error:', err);
    }

    // 2. close socket.io clients
    io.close((ioErr) => {
      if (ioErr) console.error('[server] socket.io close error:', ioErr);

      // 3. close SQLite
      try {
        const { db } = require('./services/db');
        db.close();
        console.log('[server] SQLite closed cleanly');
      } catch (dbErr) {
        console.error('[server] SQLite close error:', dbErr);
      }

      console.log('[server] shutdown complete');
      clearTimeout(forceTimer);
      process.exit(0);
    });
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Uncaught error handlers — log structured, don't crash the process.
// Express's own error handler catches route exceptions; these are for
// truly out-of-band errors (unhandled promise rejections, etc).
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[server] uncaughtException:', err);
  // Only exit on genuinely fatal errors; most uncaughts are non-fatal.
});

module.exports = { app, server, io, shutdown };
