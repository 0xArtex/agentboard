const express = require('express');
const router = express.Router();
const path = require('path');
const os = require('os');
const store = require('../services/project-store');
const { asyncHandler } = require('../middleware/error-handler');

const VERSION = require('../package.json').version;

// Paths map (replaces electron app.getPath)
const PATHS = {
  userData: store.DATA_DIR,
  temp: os.tmpdir(),
  home: os.homedir(),
  documents: path.join(os.homedir(), 'Documents'),
  downloads: path.join(os.homedir(), 'Downloads'),
  projects: store.PROJECTS_DIR,
};

// GET /api/app/path/:name — Get paths
router.get('/path/:name', asyncHandler(async (req, res) => {
  const name = req.params.name;
  if (!(name in PATHS)) {
    return res.status(404).json({
      error: { message: `Unknown path name: "${name}". Available: ${Object.keys(PATHS).join(', ')}` },
    });
  }
  res.json({ name, path: PATHS[name] });
}));

// GET /api/app/version — Get app version
router.get('/version', (req, res) => {
  res.json({ version: VERSION });
});

module.exports = router;
