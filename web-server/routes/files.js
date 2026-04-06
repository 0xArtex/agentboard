const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs-extra');
const multer = require('multer');
const store = require('../services/project-store');
const { asyncHandler } = require('../middleware/error-handler');

// Multer for image uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
});

// Sanitize file path to prevent directory traversal
function safePath(projectId, ...segments) {
  const projectDir = store.getProjectDir(projectId);
  const resolved = path.resolve(projectDir, ...segments);
  if (!resolved.startsWith(projectDir)) {
    throw Object.assign(new Error('Invalid file path'), { status: 400 });
  }
  return resolved;
}

// GET /api/projects/:id/files/* — Read a file
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

  // Serve file with appropriate content type
  res.sendFile(filePath);
}));

// POST /api/projects/:id/files/* — Write/upload a file
router.post('/:id/files/*', upload.single('file'), asyncHandler(async (req, res) => {
  const filePath = safePath(req.params.id, req.params[0]);
  await fs.ensureDir(path.dirname(filePath));

  if (req.file) {
    await fs.writeFile(filePath, req.file.buffer);
  } else if (req.body && req.body.content) {
    // JSON/text content
    await fs.writeFile(filePath, req.body.content);
  } else if (req.is('application/octet-stream')) {
    // Raw binary body
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    await fs.writeFile(filePath, Buffer.concat(chunks));
  } else {
    return res.status(400).json({ error: { message: 'No file or content provided' } });
  }

  res.json({ success: true, path: req.params[0] });
}));

// DELETE /api/projects/:id/files/* — Delete a file
router.delete('/:id/files/*', asyncHandler(async (req, res) => {
  const filePath = safePath(req.params.id, req.params[0]);
  if (!(await fs.pathExists(filePath))) {
    return res.status(404).json({ error: { message: 'File not found' } });
  }
  await fs.remove(filePath);
  res.json({ success: true });
}));

// GET /api/projects/:id/images — List all images in project
router.get('/:id/images', asyncHandler(async (req, res) => {
  const imagesDir = store.getImagesDir(req.params.id);
  if (!(await fs.pathExists(imagesDir))) {
    return res.json({ images: [] });
  }
  const entries = await fs.readdir(imagesDir);
  const images = entries.filter(f => /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(f));
  res.json({ images });
}));

// POST /api/projects/:id/images — Upload an image (multipart)
router.post('/:id/images', upload.single('image'), asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: { message: 'No image file provided' } });
  }

  const imagesDir = store.getImagesDir(req.params.id);
  await fs.ensureDir(imagesDir);

  const filename = req.body.filename || req.file.originalname || `image-${Date.now()}.png`;
  const safe = filename.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
  const filePath = path.join(imagesDir, safe);

  await fs.writeFile(filePath, req.file.buffer);
  res.status(201).json({ success: true, filename: safe });
}));

module.exports = router;
