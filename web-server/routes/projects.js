/**
 * /api/projects/* — read-only endpoints the Storyboarder web bundle needs.
 *
 * The full CRUD surface that used to live here (create, update, delete,
 * board add/update/reorder/delete, file lists) was removed — the browser
 * bundle doesn't call any of it. The web UI manages board state in memory
 * and saves the whole `.storyboarder` file back via `electron-shim` →
 * `/api/fs/write`, so the only project endpoints it actually needs are
 * the three GETs below.
 *
 * Agent-side project/board mutations go through `/api/agent/*` — see
 * `routes/agent.js`.
 */

const express = require('express');
const router = express.Router();
const store = require('../services/project-store');
const { asyncHandler } = require('../middleware/error-handler');

// GET /api/projects/current — most recently created project
// Called by: src/js/window/web-bootstrap.js (when no projectId is in the URL)
router.get('/current', asyncHandler(async (req, res) => {
  const projects = await store.listProjects();
  if (projects.length === 0) {
    return res.status(404).json({ error: { message: 'No projects exist' } });
  }
  const result = await store.getProject(projects[0].id);
  if (!result) return res.status(404).json({ error: { message: 'Project not found' } });
  res.json(result);
}));

// GET /api/projects/:id — project metadata + boards
// Called by: src/js/window/web-bootstrap.js
router.get('/:id', asyncHandler(async (req, res) => {
  const result = await store.getProject(req.params.id);
  if (!result) return res.status(404).json({ error: { message: 'Project not found' } });
  res.json(result);
}));

// GET /api/projects/:id/files — list legacy-filename assets for the existsSync cache
//
// Called by: src/js/window/web-bootstrap.js to warm the electron-shim
// cache. Without this, verifyScene() in main-window.js asks the empty
// cache "do these files exist", gets false negatives, and overwrites
// real layer PNGs with blank placeholders. This endpoint returns the
// canonical list so the bootstrap can seed the cache on page load.
router.get('/:id/files', asyncHandler(async (req, res) => {
  const result = await store.getProject(req.params.id);
  if (!result) return res.status(404).json({ error: { message: 'Project not found' } });
  const assets = store.listBoardAssets(req.params.id);
  res.json({
    files: assets.map(a => ({
      filename: a.filename,
      kind: a.kind,
      size: a.size,
      mime: a.mime,
      updatedAt: a.updatedAt,
    })),
  });
}));

module.exports = router;
