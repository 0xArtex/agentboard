const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs-extra');
const { asyncHandler } = require('../middleware/error-handler');

const PREFS_FILE = path.join(__dirname, '..', 'data', 'prefs.json');

async function loadPrefs() {
  if (await fs.pathExists(PREFS_FILE)) {
    return fs.readJson(PREFS_FILE);
  }
  // Default preferences (mirrors Storyboarder defaults)
  return {
    aspectRatio: 1.7777,
    defaultBoardTiming: 2000,
    fps: 24,
    lastUsedFps: 24,
    enableHighQualityDrawingEngine: true,
    enableStabilizer: false,
    stabilizerAmount: 0.5,
    enableAnalytics: false,
    enableNotifications: true,
    enableAutoSave: true,
    enableDiagnostics: false,
  };
}

async function savePrefs(prefs) {
  await fs.ensureDir(path.dirname(PREFS_FILE));
  await fs.writeJson(PREFS_FILE, prefs, { spaces: 2 });
}

// GET /api/prefs — Get all preferences
router.get('/', asyncHandler(async (req, res) => {
  const prefs = await loadPrefs();
  res.json(prefs);
}));

// PUT /api/prefs — Update preferences
router.put('/', asyncHandler(async (req, res) => {
  const existing = await loadPrefs();
  const updated = { ...existing, ...req.body };
  await savePrefs(updated);
  res.json(updated);
}));

// GET /api/prefs/:key — Get specific preference
router.get('/:key', asyncHandler(async (req, res) => {
  const prefs = await loadPrefs();
  const key = req.params.key;
  if (!(key in prefs)) {
    return res.status(404).json({ error: { message: `Preference "${key}" not found` } });
  }
  res.json({ [key]: prefs[key] });
}));

module.exports = router;
