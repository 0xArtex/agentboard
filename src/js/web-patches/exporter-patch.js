/**
 * exporter-patch.js — Analysis of exporter.js and exporters/common.js
 * 
 * exporter.js uses:
 *   - const fs = require('fs-extra')     → aliased to electron-shim (has fs methods)
 *   - const { dialog } = require('@electron/remote') → aliased to electron-shim dialogShim
 *   - const app = require('@electron/remote').app     → aliased to electron-shim remote.app
 *   - fs.existsSync, fs.mkdirSync, fs.writeFileSync  → all shimmed
 * 
 * exporters/common.js uses:
 *   - const fs = require('fs')           → aliased to electron-shim
 *   - fs.writeFileSync with base64       → shimmed (fire-and-forget POST to API)
 *   - fs.readFile                        → shimmed (fetches from API)
 * 
 * Both files will work with existing webpack aliases. Export operations will
 * attempt async writes to the backend API, which may or may not succeed depending
 * on whether the backend implements the /api/fs/write endpoint.
 * 
 * This patch: no-op for runtime crash prevention. Full export functionality
 * would need backend support.
 */

module.exports = function applyExporterPatch () {
  // No runtime crash patch needed — webpack aliases handle all requires
  console.log('[web-patches/exporter] No patch needed — handled by webpack aliases')
}
