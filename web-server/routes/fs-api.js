/**
 * Filesystem API routes — used by electron-shim's fs shim
 * 
 * These endpoints let the browser-based app read/write files on the server,
 * replacing Electron's native fs access.
 * 
 * SECURITY: Paths are restricted to the project data directory and src/data/
 * to prevent arbitrary filesystem access.
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs-extra');
const { asyncHandler } = require('../middleware/error-handler');

const DATA_DIR = path.join(__dirname, '..', 'data');
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC_DIR = path.join(REPO_ROOT, 'src');

// Allowed base directories for fs operations
const ALLOWED_BASES = [
  DATA_DIR,
  path.join(SRC_DIR, 'data'),
  path.join(SRC_DIR, 'fonts'),
  '/web',  // Virtual paths used by the electron shim
  '/tmp',
];

/**
 * Resolve a requested path to a real filesystem path.
 * Virtual paths like /web/userData map to DATA_DIR.
 * Returns null if the path is not allowed.
 */
function resolvePath(requestedPath) {
  if (!requestedPath) return null;

  // Helper: ensure resolved is within a safe base dir (no traversal)
  const safeJoin = (base, rel) => {
    const resolved = path.resolve(base, '.' + (rel.startsWith('/') ? rel : '/' + rel));
    if (!resolved.startsWith(base + path.sep) && resolved !== base) return null;
    return resolved;
  };

  // /web/projects/<uuid>/... → DATA_DIR/projects/<uuid>/...
  const projMatch = requestedPath.match(/^\/web\/projects\/([0-9a-fA-F-]{8,})(\/.*)?$/);
  if (projMatch) {
    const uuid = projMatch[1];
    // Validate uuid chars only
    if (!/^[0-9a-fA-F-]+$/.test(uuid)) return null;
    const rest = projMatch[2] || '';
    const base = path.join(DATA_DIR, 'projects', uuid);
    return safeJoin(base, rest || '/');
  }

  // Map virtual paths
  if (requestedPath.startsWith('/web/userData') || requestedPath.startsWith('/web/appData')) {
    return safeJoin(DATA_DIR, requestedPath.replace(/^\/web\/(userData|appData)/, ''));
  }
  if (requestedPath.startsWith('/web/')) {
    return safeJoin(DATA_DIR, requestedPath.replace(/^\/web\//, ''));
  }
  if (requestedPath.startsWith('/tmp')) {
    return safeJoin(path.join(DATA_DIR, 'tmp'), requestedPath.replace(/^\/tmp\/?/, '/'));
  }

  // Relative paths resolve from project data
  const resolved = path.resolve(DATA_DIR, requestedPath);

  // Security: must be within allowed directories
  const isAllowed = ALLOWED_BASES.some(base => {
    const realBase = base.startsWith('/web') || base.startsWith('/tmp') ? DATA_DIR : base;
    return resolved.startsWith(realBase);
  });

  // Also allow paths within SRC_DIR (for reading app data files)
  if (resolved.startsWith(SRC_DIR)) return resolved;
  // Allow paths within DATA_DIR
  if (resolved.startsWith(DATA_DIR)) return resolved;

  if (!isAllowed) return null;
  return resolved;
}

// GET /api/fs/read?path=... — Read a file
router.get('/read', asyncHandler(async (req, res) => {
  const filePath = resolvePath(req.query.path);
  if (!filePath) {
    return res.status(403).json({ error: { message: 'Path not allowed' } });
  }
  if (!await fs.pathExists(filePath)) {
    return res.status(404).json({ error: { message: 'File not found' } });
  }

  const stat = await fs.stat(filePath);
  if (stat.isDirectory()) {
    return res.status(400).json({ error: { message: 'Path is a directory' } });
  }

  // Detect content type
  const ext = path.extname(filePath).toLowerCase();
  const binaryExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.mp3', '.wav', '.ogg', '.mp4', '.webm', '.pdf', '.zip'];
  
  if (binaryExts.includes(ext)) {
    res.sendFile(filePath);
  } else {
    const content = await fs.readFile(filePath, 'utf8');
    res.type('text/plain').send(content);
  }
}));

// POST /api/fs/write?path=... — Write a file
router.post('/write', asyncHandler(async (req, res) => {
  const filePath = resolvePath(req.query.path);
  if (!filePath) {
    return res.status(403).json({ error: { message: 'Path not allowed' } });
  }

  await fs.ensureDir(path.dirname(filePath));

  // Body could be raw buffer or text
  if (Buffer.isBuffer(req.body)) {
    await fs.writeFile(filePath, req.body);
  } else if (typeof req.body === 'string') {
    await fs.writeFile(filePath, req.body, 'utf8');
  } else if (req.body && typeof req.body === 'object') {
    await fs.writeJson(filePath, req.body, { spaces: 2 });
  } else {
    await fs.writeFile(filePath, '');
  }

  res.json({ ok: true, path: req.query.path });
}));

// GET /api/fs/exists?path=... — Check if file exists
router.get('/exists', asyncHandler(async (req, res) => {
  const filePath = resolvePath(req.query.path);
  if (!filePath) {
    return res.json({ exists: false });
  }
  const exists = await fs.pathExists(filePath);
  res.json({ exists });
}));

// GET /api/fs/readdir?path=... — List directory contents
router.get('/readdir', asyncHandler(async (req, res) => {
  const dirPath = resolvePath(req.query.path);
  if (!dirPath) {
    return res.status(403).json({ error: { message: 'Path not allowed' } });
  }
  if (!await fs.pathExists(dirPath)) {
    return res.status(404).json({ error: { message: 'Directory not found' } });
  }
  const entries = await fs.readdir(dirPath);
  res.json({ entries });
}));

// POST /api/fs/mkdir?path=... — Create directory
router.post('/mkdir', asyncHandler(async (req, res) => {
  const dirPath = resolvePath(req.query.path);
  if (!dirPath) {
    return res.status(403).json({ error: { message: 'Path not allowed' } });
  }
  await fs.ensureDir(dirPath);
  res.json({ ok: true, path: req.query.path });
}));

// DELETE /api/fs/delete?path=... — Delete a file
router.delete('/delete', asyncHandler(async (req, res) => {
  const filePath = resolvePath(req.query.path);
  if (!filePath) {
    return res.status(403).json({ error: { message: 'Path not allowed' } });
  }
  if (await fs.pathExists(filePath)) {
    await fs.remove(filePath);
  }
  res.json({ ok: true });
}));

// GET /api/fs/stat?path=... — Get file stats
router.get('/stat', asyncHandler(async (req, res) => {
  const filePath = resolvePath(req.query.path);
  if (!filePath) {
    return res.status(403).json({ error: { message: 'Path not allowed' } });
  }
  if (!await fs.pathExists(filePath)) {
    return res.status(404).json({ error: { message: 'File not found' } });
  }
  const stat = await fs.stat(filePath);
  res.json({
    isFile: stat.isFile(),
    isDirectory: stat.isDirectory(),
    size: stat.size,
    mtime: stat.mtime,
    ctime: stat.ctime,
  });
}));

module.exports = router;
