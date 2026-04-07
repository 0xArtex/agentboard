const express = require('express');
const router = express.Router();
const store = require('../services/project-store');
const { asyncHandler } = require('../middleware/error-handler');

// GET /api/projects — List all projects
router.get('/', asyncHandler(async (req, res) => {
  const projects = await store.listProjects();
  res.json({ projects });
}));

// POST /api/projects — Create new project
router.post('/', asyncHandler(async (req, res) => {
  const opts = req.body || {};
  const { id, project } = await store.createProject(opts);
  if (req.app.locals.socketHandler) {
    req.app.locals.socketHandler.broadcast('project:save', { id });
  }
  res.status(201).json({ id, project });
}));

// GET /api/projects/current — Get the most recently created project
router.get('/current', asyncHandler(async (req, res) => {
  const projects = await store.listProjects();
  if (projects.length === 0) {
    return res.status(404).json({ error: { message: 'No projects exist' } });
  }
  const result = await store.getProject(projects[0].id);
  if (!result) return res.status(404).json({ error: { message: 'Project not found' } });
  res.json(result);
}));

// GET /api/projects/:id — Get project metadata
router.get('/:id', asyncHandler(async (req, res) => {
  const result = await store.getProject(req.params.id);
  if (!result) return res.status(404).json({ error: { message: 'Project not found' } });
  res.json(result);
}));

// PUT /api/projects/:id — Update project metadata
router.put('/:id', asyncHandler(async (req, res) => {
  const result = await store.updateProject(req.params.id, req.body);
  if (!result) return res.status(404).json({ error: { message: 'Project not found' } });
  if (req.app.locals.socketHandler) {
    req.app.locals.socketHandler.broadcast('project:save', { id: req.params.id });
  }
  res.json(result);
}));

// DELETE /api/projects/:id — Delete project
router.delete('/:id', asyncHandler(async (req, res) => {
  const deleted = await store.deleteProject(req.params.id);
  if (!deleted) return res.status(404).json({ error: { message: 'Project not found' } });
  res.json({ success: true });
}));

// ── Board routes ──

// GET /api/projects/:id/files — List every legacy-filename asset that exists
//
// Used by the web-bootstrap to prefetch the existsSync cache. Without this,
// verifyScene() in main-window.js asks the in-memory shim cache "do these
// files exist" on every page load, gets a false negative because the cache
// is empty, and overwrites real layer PNGs with blank placeholders. This
// endpoint returns the canonical list so the bootstrap can warm the cache.
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

// GET /api/projects/:id/boards — List all boards
router.get('/:id/boards', asyncHandler(async (req, res) => {
  const result = await store.getProject(req.params.id);
  if (!result) return res.status(404).json({ error: { message: 'Project not found' } });
  res.json({ boards: result.project.boards });
}));

// PUT /api/projects/:id/boards/reorder — Reorder boards (must be before :uid route)
router.put('/:id/boards/reorder', asyncHandler(async (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) {
    return res.status(400).json({ error: { message: '`order` must be an array of board UIDs' } });
  }
  const boards = await store.reorderBoards(req.params.id, order);
  if (!boards) return res.status(404).json({ error: { message: 'Project not found' } });
  if (req.app.locals.socketHandler) {
    req.app.locals.socketHandler.broadcast('board:reorder', { projectId: req.params.id, boards });
  }
  res.json({ boards });
}));

// POST /api/projects/:id/boards — Add a board
router.post('/:id/boards', asyncHandler(async (req, res) => {
  const board = await store.addBoard(req.params.id, req.body || {});
  if (!board) return res.status(404).json({ error: { message: 'Project not found' } });
  if (req.app.locals.socketHandler) {
    req.app.locals.socketHandler.broadcast('board:add', { projectId: req.params.id, board });
  }
  res.status(201).json({ board });
}));

// PUT /api/projects/:id/boards/:uid — Update a board
router.put('/:id/boards/:uid', asyncHandler(async (req, res) => {
  const board = await store.updateBoard(req.params.id, req.params.uid, req.body);
  if (!board) return res.status(404).json({ error: { message: 'Board not found' } });
  if (req.app.locals.socketHandler) {
    req.app.locals.socketHandler.broadcast('board:update', { projectId: req.params.id, board });
  }
  res.json({ board });
}));

// DELETE /api/projects/:id/boards/:uid — Delete a board
router.delete('/:id/boards/:uid', asyncHandler(async (req, res) => {
  const deleted = await store.deleteBoard(req.params.id, req.params.uid);
  if (deleted === null) return res.status(404).json({ error: { message: 'Project not found' } });
  if (!deleted) return res.status(404).json({ error: { message: 'Board not found' } });
  if (req.app.locals.socketHandler) {
    req.app.locals.socketHandler.broadcast('board:delete', { projectId: req.params.id, uid: req.params.uid });
  }
  res.json({ success: true });
}));

module.exports = router;
