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
const appRouter = require('./routes/app');

const PORT = process.env.PORT || 3456;

// ── Repo root (one level above web-server/) ──
const REPO_ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(REPO_ROOT, 'src');

// ── App setup ──
const app = express();
const server = http.createServer(app);

// Socket.io
const io = new SocketIO(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
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

// ── Create default project on startup if none exist ──
async function ensureDefaultProject() {
  const store = require('./services/project-store');
  const projects = await store.listProjects();
  if (projects.length === 0) {
    console.log('📋 No projects found, creating default project...');
    const { id, project } = await store.createProject({
      aspectRatio: 1.7777,
      fps: 24,
      defaultBoardTiming: 2000,
    });
    // Add one blank board
    await store.addBoard(id, {
      dialogue: '',
      action: '',
      notes: '',
    });
    console.log(`📋 Created default project: ${id}`);
    
    // Create a blank PNG for the board
    const imgDir = store.getImagesDir(id);
    const updatedProject = await store.getProject(id);
    if (updatedProject && updatedProject.project.boards.length > 0) {
      const boardUrl = updatedProject.project.boards[0].url;
      const imgPath = path.join(imgDir, boardUrl);
      // Create a minimal 1x1 transparent PNG if the image doesn't exist
      if (!await fs.pathExists(imgPath)) {
        // Minimal valid PNG (1x1 transparent pixel)
        const minPng = Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB' +
          'Nl7BcQAAAABJRU5ErkJggg==', 'base64'
        );
        await fs.writeFile(imgPath, minPng);
      }
    }
  }
}

// ── Start ──
server.listen(PORT, async () => {
  console.log(`\n🎬 Storyboarder Web Server running on http://localhost:${PORT}`);
  console.log(`   API:       http://localhost:${PORT}/api`);
  console.log(`   WebSocket: ws://localhost:${PORT}`);
  console.log(`   Health:    http://localhost:${PORT}/api/health`);
  console.log(`   Web App:   http://localhost:${PORT}/\n`);
  
  await ensureDefaultProject();
});

module.exports = { app, server, io };
