/**
 * web-entry.js — Browser entry point for Storyboarder Web
 *
 * This is the webpack entry point. It:
 * 1. Runs the preloader (socket.io, prefs, brushes)
 * 2. Applies web-compatibility patches
 * 3. Then runs the web bootstrap (pre-fetches project data, language, board files)
 * 4. The bootstrap loads main-window.js when ready
 */

const preload = require('./web-preload')
const { applyAllPatches } = require('./web-patches')

// Start the preload, then boot the app
preload.init().then(async ({ socket }) => {
  console.log('[web-entry] Preload done, applying patches...')

  // Store socket globally for anything that needs it
  window.__storyboarder_socket = socket

  // Apply web-compatibility patches before loading app code
  // This fixes missing module exports, pre-caches data files, etc.
  await applyAllPatches()

  console.log('[web-entry] Patches applied, starting bootstrap...')

  // Load the web bootstrap which handles async data fetching
  // then loads main-window.js when everything is ready
  require('./window/web-bootstrap')

  console.log('[web-entry] Bootstrap initiated')
}).catch((err) => {
  console.error('[web-entry] Failed to initialize:', err)
  document.body.innerHTML = '<div style="padding:2em;color:red;font-family:sans-serif">' +
    '<h2>Storyboarder Web failed to start</h2>' +
    '<pre>' + (err.stack || err.message || err) + '</pre>' +
    '</div>'
})
