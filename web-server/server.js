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
const exportRouter = require('./routes/export');
const prefsRouter = require('./routes/prefs');
const agentRouter = require('./routes/agent');
const agentsRouter = require('./routes/agents');
const appRouter = require('./routes/app');

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
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
// Raw body parser for binary file writes
app.use('/api/fs/write', express.raw({ type: '*/*', limit: '50mb' }));

// Agent identity: stamp req.agent on every /api/* request.
// In dev (AGENT_AUTH_ENABLED=0) anonymous access is attributed to the
// built-in default user; in prod (=1), mutations require a bearer token.
app.use('/api', agentAuthMiddleware);

// ── Ensure data directories exist ──
const DATA_DIR = path.join(__dirname, 'data');
fs.ensureDirSync(path.join(DATA_DIR, 'projects'));
fs.ensureDirSync(path.join(DATA_DIR, 'exports'));

// ── API Routes ──
app.use('/api/projects', projectsRouter);
app.use('/api/projects', filesRouter);
app.use('/api/projects', exportRouter);
app.use('/api/prefs', prefsRouter);
app.use('/api/agent', agentRouter);
app.use('/api/agents', agentsRouter);
app.use('/api/app', appRouter);

// ── Health check ──
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: require('./package.json').version });
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

app.get('/web/projects/:uuid/images/:filename', (req, res) => {
  const { uuid, filename } = req.params;
  if (!PROJECT_UUID_RE.test(uuid)) {
    return res.status(400).send('Invalid project id');
  }
  const asset = projectStore.resolveLegacyAsset(uuid, filename);
  if (!asset) {
    return res.status(404).send('Asset not found');
  }
  const fp = blobStore.pathOf(asset.hash);
  if (!fp) {
    return res.status(404).send('Blob missing on disk');
  }
  res.type(asset.mime || 'application/octet-stream');
  // Long-cache: blob URLs are content-addressed by the (uid, kind) lookup
  // and the cachebuster querystring rotates whenever the underlying hash
  // changes, so we can let browsers hold these for a while.
  res.setHeader('Cache-Control', 'public, max-age=300');
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

module.exports = { app, server, io };
