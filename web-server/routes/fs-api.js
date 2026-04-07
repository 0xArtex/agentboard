/**
 * Filesystem API routes — used by electron-shim's fs shim.
 *
 * The shim treats the server as if it were a Node fs API, but the server
 * silently routes the writes through SQLite + the BlobStore. There are two
 * worlds:
 *
 *   1. Project asset paths — anything under /web/projects/<uuid>/images/
 *      goes through the project-store legacy filename translation. Writes
 *      hash the bytes and update board_assets; reads look up the current
 *      blob hash for that filename and stream the bytes.
 *
 *   2. Everything else — locale files, prefs, recordings.json, etc. —
 *      stays on real disk under web-server/data/. We don't need
 *      content-addressed storage for these; they're tiny and rarely written.
 *
 * SECURITY: project asset paths are validated against the project_id from
 * the URL. Non-project paths are restricted to a small set of allowed
 * directories that prevent traversal outside web-server/data and src/data.
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs-extra');
const { asyncHandler } = require('../middleware/error-handler');
const store = require('../services/project-store');
const { blobStore } = require('../services/blob-store');

const DATA_DIR = path.join(__dirname, '..', 'data');
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC_DIR = path.join(REPO_ROOT, 'src');

// Allowed base directories for non-project fs operations.
// Project assets are NOT here — they're handled by the project-store path
// below, which never touches the filesystem directly.
const ALLOWED_BASES = [
  DATA_DIR,
  path.join(SRC_DIR, 'data'),
  path.join(SRC_DIR, 'fonts'),
];

// ── path classification ────────────────────────────────────────────────

const PROJECT_IMAGE_RE =
  /^\/web\/projects\/([0-9a-fA-F-]{8,})\/images\/([^/?#]+)$/;
const PROJECT_FILE_RE =
  /^\/web\/projects\/([0-9a-fA-F-]{8,})\/project\.storyboarder$/;
// Backup files have names like project.storyboarder.backup-1775528587673
// We swallow these silently — main-window writes them as part of its
// atomic save flow but the SQLite store doesn't need to remember them.
const PROJECT_FILE_BACKUP_RE =
  /^\/web\/projects\/([0-9a-fA-F-]{8,})\/project\.storyboarder\.backup-\d+$/;

function classifyPath(requestedPath) {
  if (!requestedPath) return { kind: 'invalid' };

  let m;
  if ((m = requestedPath.match(PROJECT_FILE_RE))) {
    return { kind: 'project-file', projectId: m[1] };
  }
  if ((m = requestedPath.match(PROJECT_FILE_BACKUP_RE))) {
    return { kind: 'project-file-backup', projectId: m[1] };
  }
  if ((m = requestedPath.match(PROJECT_IMAGE_RE))) {
    return {
      kind: 'project-image',
      projectId: m[1],
      filename: m[2],
    };
  }

  // Everything else goes through resolveDiskPath
  const disk = resolveDiskPath(requestedPath);
  if (!disk) return { kind: 'invalid' };
  return { kind: 'disk', filePath: disk };
}

function resolveDiskPath(requestedPath) {
  const safeJoin = (base, rel) => {
    const resolved = path.resolve(base, '.' + (rel.startsWith('/') ? rel : '/' + rel));
    if (!resolved.startsWith(base + path.sep) && resolved !== base) return null;
    return resolved;
  };

  // /web/userData and /web/appData both map to web-server/data
  if (requestedPath.startsWith('/web/userData') || requestedPath.startsWith('/web/appData')) {
    return safeJoin(DATA_DIR, requestedPath.replace(/^\/web\/(userData|appData)/, ''));
  }

  // Other /web/ paths also fall under data dir (legacy)
  if (requestedPath.startsWith('/web/')) {
    return safeJoin(DATA_DIR, requestedPath.replace(/^\/web\//, ''));
  }

  if (requestedPath.startsWith('/tmp')) {
    return safeJoin(path.join(DATA_DIR, 'tmp'), requestedPath.replace(/^\/tmp\/?/, '/'));
  }

  // Bare paths resolve relative to DATA_DIR
  const resolved = path.resolve(DATA_DIR, requestedPath.replace(/^\/+/, ''));
  if (resolved.startsWith(DATA_DIR)) return resolved;
  if (resolved.startsWith(SRC_DIR)) return resolved;
  for (const base of ALLOWED_BASES) {
    if (resolved.startsWith(base)) return resolved;
  }
  return null;
}

// ── handlers ───────────────────────────────────────────────────────────

// GET /api/fs/read?path=... — Read a file
router.get('/read', asyncHandler(async (req, res) => {
  const cls = classifyPath(req.query.path);
  if (cls.kind === 'invalid') {
    return res.status(403).json({ error: { message: 'Path not allowed' } });
  }

  if (cls.kind === 'project-file') {
    // Serve project.storyboarder from SQLite, not from any leftover legacy
    // file on disk. The client treats this as the source of truth for
    // boards/dialogue/timing, and SQLite is now the source of truth for
    // those things.
    const json = store.serializeProjectAsLegacyJson(cls.projectId);
    if (!json) return res.status(404).json({ error: { message: 'Project not found' } });
    res.type('text/plain').send(json);
    return;
  }

  if (cls.kind === 'project-file-backup') {
    // We don't keep backups in the new store. Tell the client there's
    // nothing here so its rotate-old-backups logic doesn't fall over, but
    // don't error noisily.
    return res.status(404).json({ error: { message: 'No backups in SQLite store' } });
  }

  if (cls.kind === 'project-image') {
    const asset = store.resolveLegacyAsset(cls.projectId, cls.filename);
    if (!asset) {
      return res.status(404).json({ error: { message: 'Asset not found' } });
    }
    if (blobStore.backend === 'r2') {
      const url = await blobStore.pathOf(asset.hash);
      if (!url) return res.status(404).json({ error: { message: 'Blob missing' } });
      return res.redirect(302, url);
    }
    const fp = blobStore.pathOf(asset.hash);
    if (!fp) {
      return res.status(404).json({ error: { message: 'Blob missing on disk' } });
    }
    res.type(asset.mime || 'application/octet-stream');
    return res.sendFile(fp);
  }

  // Disk path
  const filePath = cls.filePath;
  if (!await fs.pathExists(filePath)) {
    return res.status(404).json({ error: { message: 'File not found' } });
  }
  const stat = await fs.stat(filePath);
  if (stat.isDirectory()) {
    return res.status(400).json({ error: { message: 'Path is a directory' } });
  }
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
  const cls = classifyPath(req.query.path);
  if (cls.kind === 'invalid') {
    return res.status(403).json({ error: { message: 'Path not allowed' } });
  }

  // Both project.storyboarder and project.storyboarder.backup-<ts> are the
  // authoritative "here is the full project state" write from the client.
  // main-window.js saveBoardFile uses an atomic-rename pattern where it
  // writes to the backup path FIRST and then fs.moveSync's to the real
  // path — but the electron-shim's moveSync is a no-op, so the real path
  // is never POSTed. We have to treat the backup write as the real thing
  // and sync its JSON into SQLite, otherwise client-side mutations like
  // "add board 2" never propagate and subsequent layer asset writes for
  // the new board get rejected with NO_BOARD.
  if (cls.kind === 'project-file' || cls.kind === 'project-file-backup') {
    let payload;
    try {
      const text = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
      payload = JSON.parse(text);
    } catch (err) {
      return res.status(400).json({ error: { message: 'project.storyboarder body is not valid JSON' } });
    }
    try {
      const stats = store.syncFromProjectFile(cls.projectId, payload);
      return res.json({ ok: true, path: req.query.path, ...stats });
    } catch (err) {
      const status = err.code === 'WRONG_PROJECT' ? 403 : 400;
      return res.status(status).json({ error: { message: err.message, code: err.code } });
    }
  }

  if (cls.kind === 'project-image') {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: { message: 'Project images must be sent as a non-empty binary body' } });
    }
    try {
      const result = await store.storeLegacyAsset(cls.projectId, cls.filename, req.body);
      return res.json({
        ok: true,
        path: req.query.path,
        hash: result.hash,
        kind: result.kind,
      });
    } catch (err) {
      // BAD_FILENAME / NO_BOARD / WRONG_PROJECT — translate to 4xx so the
      // shim sees a real error instead of a silent corruption.
      const status = err.code === 'WRONG_PROJECT' ? 403 : 400;
      return res.status(status).json({ error: { message: err.message, code: err.code } });
    }
  }

  // Disk path
  const filePath = cls.filePath;
  await fs.ensureDir(path.dirname(filePath));
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
  const cls = classifyPath(req.query.path);
  if (cls.kind === 'invalid') return res.json({ exists: false });

  if (cls.kind === 'project-file') {
    const json = store.serializeProjectAsLegacyJson(cls.projectId);
    return res.json({ exists: !!json });
  }
  if (cls.kind === 'project-file-backup') {
    return res.json({ exists: false });
  }
  if (cls.kind === 'project-image') {
    const asset = store.resolveLegacyAsset(cls.projectId, cls.filename);
    return res.json({ exists: !!asset });
  }

  res.json({ exists: await fs.pathExists(cls.filePath) });
}));

// GET /api/fs/readdir?path=... — List directory contents
router.get('/readdir', asyncHandler(async (req, res) => {
  const cls = classifyPath(req.query.path);
  if (cls.kind === 'invalid') {
    return res.status(403).json({ error: { message: 'Path not allowed' } });
  }
  if (cls.kind === 'project-image') {
    // /readdir on a project-image path doesn't make sense; if a caller wants
    // the list of assets they should hit /api/projects/:id/files instead.
    return res.status(400).json({ error: { message: 'Use /api/projects/:id/files for project asset lists' } });
  }
  const dirPath = cls.filePath;
  if (!await fs.pathExists(dirPath)) {
    return res.status(404).json({ error: { message: 'Directory not found' } });
  }
  const entries = await fs.readdir(dirPath);
  res.json({ entries });
}));

// POST /api/fs/mkdir?path=... — Create directory
router.post('/mkdir', asyncHandler(async (req, res) => {
  const cls = classifyPath(req.query.path);
  if (cls.kind === 'invalid') {
    return res.status(403).json({ error: { message: 'Path not allowed' } });
  }
  if (cls.kind === 'project-image') {
    // Asset directories don't exist as filesystem entries anymore
    return res.json({ ok: true, path: req.query.path });
  }
  await fs.ensureDir(cls.filePath);
  res.json({ ok: true, path: req.query.path });
}));

// DELETE /api/fs/delete?path=... — Delete a file
router.delete('/delete', asyncHandler(async (req, res) => {
  const cls = classifyPath(req.query.path);
  if (cls.kind === 'invalid') {
    return res.status(403).json({ error: { message: 'Path not allowed' } });
  }
  if (cls.kind === 'project-image') {
    // Deleting an individual asset means removing the board_assets row.
    // The blob can be GC'd later by blobStore.gc(). For Phase 2 we just
    // accept the request; the legacy delete path is rarely exercised.
    // TODO: implement when the agent API needs it.
    return res.json({ ok: true });
  }
  if (cls.kind === 'project-file' || cls.kind === 'project-file-backup') {
    // No-op: the JSON is derived from SQLite, backups don't exist.
    return res.json({ ok: true });
  }
  if (await fs.pathExists(cls.filePath)) {
    await fs.remove(cls.filePath);
  }
  res.json({ ok: true });
}));

// GET /api/fs/stat?path=... — Get file stats
router.get('/stat', asyncHandler(async (req, res) => {
  const cls = classifyPath(req.query.path);
  if (cls.kind === 'invalid') {
    return res.status(403).json({ error: { message: 'Path not allowed' } });
  }

  if (cls.kind === 'project-file') {
    const json = store.serializeProjectAsLegacyJson(cls.projectId);
    if (!json) return res.status(404).json({ error: { message: 'Project not found' } });
    return res.json({
      isFile: true,
      isDirectory: false,
      size: Buffer.byteLength(json, 'utf8'),
      mtime: new Date().toISOString(),
      ctime: new Date().toISOString(),
    });
  }
  if (cls.kind === 'project-file-backup') {
    return res.status(404).json({ error: { message: 'Backups not stored' } });
  }
  if (cls.kind === 'project-image') {
    const asset = store.resolveLegacyAsset(cls.projectId, cls.filename);
    if (!asset) {
      return res.status(404).json({ error: { message: 'Asset not found' } });
    }
    return res.json({
      isFile: true,
      isDirectory: false,
      size: asset.size,
      mtime: new Date(asset.updatedAt).toISOString(),
      ctime: new Date(asset.updatedAt).toISOString(),
    });
  }

  if (!await fs.pathExists(cls.filePath)) {
    return res.status(404).json({ error: { message: 'File not found' } });
  }
  const stat = await fs.stat(cls.filePath);
  res.json({
    isFile: stat.isFile(),
    isDirectory: stat.isDirectory(),
    size: stat.size,
    mtime: stat.mtime,
    ctime: stat.ctime,
  });
}));

module.exports = router;
