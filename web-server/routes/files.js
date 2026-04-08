/**
 * /api/projects/:id/files/* — legacy file read for the Storyboarder shim.
 *
 * The write/delete/list and multipart image-upload handlers that used to
 * live here were removed — nothing in the browser bundle calls them.
 * Writes go through `electron-shim` → `/api/fs/write` (see routes/fs-api.js)
 * and image uploads from agents go through `/api/agent/draw` or
 * `/api/agent/upload-batch`.
 *
 * This GET handler is kept only because `src/js/electron-shim.js` still
 * references it from `shell.openItem`, `shell.openPath`, and
 * `nativeImage.createFromPath().toDataURL()`. Those are rarely-hit edge
 * cases that resolve legacy absolute-path URLs — mostly dead in the
 * post-SQLite world but cheap enough to keep serving 404s properly
 * rather than crashing the shim with "route not found".
 *
 * The canonical image-serving path for the web UI is
 * `/web/projects/:uuid/images/:filename` in `server.js`, which
 * resolves legacy filenames through `resolveLegacyAsset()` and streams
 * from the content-addressed blob store.
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs-extra');
const store = require('../services/project-store');
const { asyncHandler } = require('../middleware/error-handler');

// Sanitize file path to prevent directory traversal.
function safePath(projectId, ...segments) {
  const projectDir = store.getProjectDir(projectId);
  const resolved = path.resolve(projectDir, ...segments);
  if (!resolved.startsWith(projectDir)) {
    throw Object.assign(new Error('Invalid file path'), { status: 400 });
  }
  return resolved;
}

// GET /api/projects/:id/files/* — Read a file from the legacy project dir.
router.get('/:id/files/*', asyncHandler(async (req, res) => {
  const filePath = safePath(req.params.id, req.params[0]);
  if (!(await fs.pathExists(filePath))) {
    return res.status(404).json({ error: { message: 'File not found' } });
  }

  const stat = await fs.stat(filePath);
  if (stat.isDirectory()) {
    const entries = await fs.readdir(filePath);
    return res.json({ entries });
  }

  res.sendFile(filePath);
}));

module.exports = router;
