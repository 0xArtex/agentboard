/**
 * web-patches/index.js — Master patch file for Storyboarder Web
 * 
 * Applied before the main app loads (imported by web-entry.js after preload).
 * 
 * Patches are applied in two phases:
 * 1. Synchronous patches (monkey-patching module exports) — run immediately
 * 2. Async patches (fetching/caching data) — returns a promise
 * 
 * Analysis summary of all 10 target files:
 * 
 * NEEDS PATCHING:
 * - configureStore.js: electron-redux shim missing composeWithStateSync export
 * - storyboarder-sketch-pane.js: needs brushes.json pre-cached for readFileSync
 * - i18next.config.js: needs app.getAppPath() added to electron-shim
 * 
 * ALREADY HANDLED BY WEBPACK ALIASES (no patch needed):
 * - menu.js: only uses ipcRenderer.send() → shimmed
 * - prefs.js: intercepted by remote.require('./prefs') → prefsShim
 * - storyboarder-electron-log.js: electron-log → shimmed
 * - exporter.js: fs-extra + dialog → all shimmed
 * - exporters/common.js: fs → shimmed
 * - models/board.js: pure JS, only uses path + utils
 * - utils/index.js: pure JS utilities, no Node/Electron APIs
 */

// Phase 1: Synchronous patches (must run before any app code requires these modules)
const applyConfigureStorePatch = require('./configure-store-patch')
const applyI18nextPatch = require('./i18next-patch')

// Phase 2: Async patches (data fetching)
const applySketchPanePatch = require('./sketch-pane-patch')
const applyAlchemancyPatch = require('./alchemancy-patch')

/**
 * Apply all patches. Returns a promise for async patches.
 * Call this after web-preload but before loading main-window.
 */
async function applyAllPatches () {
  console.log('[web-patches] Applying patches...')
  
  // Synchronous patches — fix module exports
  applyConfigureStorePatch()
  
  // Async patches — fetch and cache data
  // i18next patch adds getAppPath AND fetches locale data
  await applyI18nextPatch()
  
  // Sketch pane patch fetches and caches brushes.json
  await applySketchPanePatch()

  // Alchemancy runtime guards (cursor + pixelsToCanvas)
  applyAlchemancyPatch()

  console.log('[web-patches] All patches applied')
}

module.exports = { applyAllPatches }
