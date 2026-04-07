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
    // Used by web-bootstrap.js prefetchLanguage(); defaulting here keeps
    // /api/prefs/language from 404'ing on a fresh install.
    language: 'en',
    // Used by pomodoro-timer-view.js — having this here also stops the
    // 'value="undefined"' warning on the timer's <input type="number">.
    pomodoroTimerMinutes: 25,
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
//
// Returns 200 with `{ key, value }` whether or not the key is set, so callers
// like web-bootstrap.js can read `data.value` uniformly without distinguishing
// "missing pref" from "network error". (The previous 404 was meaningful in a
// CRUD sense but produced noise in the dev tools network panel for what is
// really a perfectly normal "first run, no value yet" case.)
router.get('/:key', asyncHandler(async (req, res) => {
  const prefs = await loadPrefs();
  const key = req.params.key;
  const value = key in prefs ? prefs[key] : null;
  res.json({ key, value, [key]: value });
}));

module.exports = router;
