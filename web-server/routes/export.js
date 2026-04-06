const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs-extra');
const archiver = require('archiver');
const store = require('../services/project-store');
const { asyncHandler } = require('../middleware/error-handler');

const EXPORTS_DIR = path.join(store.DATA_DIR, 'exports');

// Ensure exports directory
fs.ensureDirSync(EXPORTS_DIR);

// POST /api/projects/:id/export/pdf — Export as PDF
router.post('/:id/export/pdf', asyncHandler(async (req, res) => {
  const result = await store.getProject(req.params.id);
  if (!result) return res.status(404).json({ error: { message: 'Project not found' } });

  // TODO: Implement PDF generation with pdfkit
  // For now, return a placeholder response
  res.json({
    success: true,
    message: 'PDF export — not yet implemented (requires pdfkit integration)',
    projectId: req.params.id,
    boardCount: result.project.boards.length,
  });
}));

// POST /api/projects/:id/export/images — Export all boards as images
router.post('/:id/export/images', asyncHandler(async (req, res) => {
  const result = await store.getProject(req.params.id);
  if (!result) return res.status(404).json({ error: { message: 'Project not found' } });

  const imagesDir = store.getImagesDir(req.params.id);
  const images = [];

  for (const board of result.project.boards) {
    const imgPath = path.join(imagesDir, board.url);
    if (await fs.pathExists(imgPath)) {
      images.push({
        uid: board.uid,
        url: `/api/projects/${req.params.id}/files/images/${board.url}`,
        filename: board.url,
      });
    }
  }

  res.json({ images });
}));

// POST /api/projects/:id/export/zip — Export entire project as ZIP
router.post('/:id/export/zip', asyncHandler(async (req, res) => {
  const result = await store.getProject(req.params.id);
  if (!result) return res.status(404).json({ error: { message: 'Project not found' } });

  const projectDir = store.getProjectDir(req.params.id);
  const zipName = `project-${req.params.id}.zip`;
  const zipPath = path.join(EXPORTS_DIR, zipName);

  const output = fs.createWriteStream(zipPath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  archive.pipe(output);
  archive.directory(projectDir, false);

  await archive.finalize();

  await new Promise((resolve, reject) => {
    output.on('close', resolve);
    output.on('error', reject);
  });

  res.json({
    success: true,
    downloadUrl: `/api/projects/${req.params.id}/export/download/${zipName}`,
    size: archive.pointer(),
  });
}));

// GET /api/projects/:id/export/download/:filename — Download exported file
router.get('/:id/export/download/:filename', asyncHandler(async (req, res) => {
  const safe = req.params.filename.replace(/[^a-zA-Z0-9_\-\.]/g, '');
  const filePath = path.join(EXPORTS_DIR, safe);
  if (!(await fs.pathExists(filePath))) {
    return res.status(404).json({ error: { message: 'Export file not found' } });
  }
  res.download(filePath);
}));

// GET /api/projects/:id/export/grid — Generate storyboard grid overview
router.get('/:id/export/grid', asyncHandler(async (req, res) => {
  const result = await store.getProject(req.params.id);
  if (!result) return res.status(404).json({ error: { message: 'Project not found' } });

  // TODO: Implement grid PNG generation (requires canvas/sharp)
  // Return board layout info for now
  const boards = result.project.boards.map(b => ({
    uid: b.uid,
    number: b.number,
    shot: b.shot,
    dialogue: b.dialogue,
    action: b.action,
    duration: b.duration,
    imageUrl: `/api/projects/${req.params.id}/files/images/${b.url}`,
  }));

  res.json({
    message: 'Grid PNG generation — not yet implemented (requires canvas/sharp)',
    aspectRatio: result.project.aspectRatio,
    boards,
  });
}));

module.exports = router;
