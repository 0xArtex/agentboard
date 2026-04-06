const express = require('express');
const router = express.Router();
const store = require('../services/project-store');
const { asyncHandler } = require('../middleware/error-handler');

// POST /api/agent/create-project — Create project from JSON spec
router.post('/create-project', asyncHandler(async (req, res) => {
  const { title, aspectRatio, fps, defaultBoardTiming, boards } = req.body;

  const { id, project } = await store.createProject({
    aspectRatio: aspectRatio || 1.7777,
    fps: fps || 24,
    defaultBoardTiming: defaultBoardTiming || 2000,
  });

  // Add boards if provided
  const addedBoards = [];
  if (Array.isArray(boards)) {
    for (const boardSpec of boards) {
      const board = await store.addBoard(id, {
        dialogue: boardSpec.dialogue || '',
        action: boardSpec.action || '',
        notes: boardSpec.notes || '',
        duration: boardSpec.duration || defaultBoardTiming || 2000,
        newShot: boardSpec.newShot,
        shot: boardSpec.shot,
      });
      addedBoards.push(board);
    }
  }

  if (req.app.locals.socketHandler) {
    req.app.locals.socketHandler.broadcast('project:save', { id });
  }

  res.status(201).json({
    id,
    title: title || 'Untitled',
    boardCount: addedBoards.length,
    boards: addedBoards,
    shareUrl: `/api/agent/share/${id}`,
  });
}));

// POST /api/agent/add-board — Add board with dialogue/action/notes
router.post('/add-board', asyncHandler(async (req, res) => {
  const { projectId, dialogue, action, notes, duration, newShot, shot } = req.body;

  if (!projectId) {
    return res.status(400).json({ error: { message: 'projectId is required' } });
  }

  const board = await store.addBoard(projectId, {
    dialogue: dialogue || '',
    action: action || '',
    notes: notes || '',
    duration,
    newShot,
    shot,
  });

  if (!board) {
    return res.status(404).json({ error: { message: 'Project not found' } });
  }

  if (req.app.locals.socketHandler) {
    req.app.locals.socketHandler.broadcast('board:add', { projectId, board });
  }

  res.status(201).json({ board });
}));

// POST /api/agent/draw — Programmatic draw commands
router.post('/draw', asyncHandler(async (req, res) => {
  const { projectId, boardUid, commands } = req.body;

  if (!projectId || !boardUid) {
    return res.status(400).json({ error: { message: 'projectId and boardUid are required' } });
  }

  if (!Array.isArray(commands)) {
    return res.status(400).json({ error: { message: 'commands must be an array' } });
  }

  // Verify project and board exist
  const result = await store.getProject(projectId);
  if (!result) return res.status(404).json({ error: { message: 'Project not found' } });

  const board = result.project.boards.find(b => b.uid === boardUid);
  if (!board) return res.status(404).json({ error: { message: 'Board not found' } });

  // Broadcast draw commands via WebSocket for real-time rendering
  if (req.app.locals.socketHandler) {
    req.app.locals.socketHandler.broadcast('canvas:draw', {
      projectId,
      boardUid,
      commands,
    });
  }

  res.json({
    success: true,
    message: 'Draw commands broadcast to connected clients',
    commandCount: commands.length,
  });
}));

// POST /api/agent/generate-image — Generate AI image for a board
router.post('/generate-image', asyncHandler(async (req, res) => {
  const { projectId, boardUid, prompt, style } = req.body;

  if (!projectId || !boardUid || !prompt) {
    return res.status(400).json({
      error: { message: 'projectId, boardUid, and prompt are required' },
    });
  }

  // Verify project and board exist
  const result = await store.getProject(projectId);
  if (!result) return res.status(404).json({ error: { message: 'Project not found' } });

  const board = result.project.boards.find(b => b.uid === boardUid);
  if (!board) return res.status(404).json({ error: { message: 'Board not found' } });

  // TODO: Integrate with fal.ai for actual image generation
  // For now, return placeholder response
  res.json({
    success: true,
    message: 'AI image generation — not yet implemented (fal.ai integration pending)',
    projectId,
    boardUid,
    prompt,
    style: style || 'storyboard',
    imageUrl: null,
  });
}));

// GET /api/agent/share/:id — Get shareable URL for project
router.get('/share/:id', asyncHandler(async (req, res) => {
  const result = await store.getProject(req.params.id);
  if (!result) return res.status(404).json({ error: { message: 'Project not found' } });

  const host = req.get('host') || 'localhost:3000';
  const protocol = req.protocol || 'http';

  res.json({
    id: req.params.id,
    shareUrl: `${protocol}://${host}/project/${req.params.id}`,
    apiUrl: `${protocol}://${host}/api/projects/${req.params.id}`,
    boardCount: result.project.boards.length,
  });
}));

module.exports = router;
