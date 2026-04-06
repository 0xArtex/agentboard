/**
 * prefs-patch.js — Ensure prefs.js works in browser context
 * 
 * prefs.js is the main-process prefs module. In Electron, renderer code accesses it via:
 *   const prefsModule = require('@electron/remote').require('./prefs')
 * 
 * The electron-shim's remote.require('./prefs') already returns prefsShim.
 * So prefs.js itself is never directly loaded in the browser — the shim intercepts it.
 * 
 * However, prefs.js also requires:
 *   - const { app } = require('electron')  → shimmed
 *   - const os = require('os')             → shimmed  
 *   - const fs = require('fs')             → shimmed
 * 
 * If prefs.js IS somehow loaded directly (e.g., by a webpack require chain),
 * the os.cpus() shim returns [{model: 'Browser', speed: 0}] with length 1,
 * which means speed <= 2000 check triggers and sets low-quality defaults.
 * That's actually fine for initial browser load.
 * 
 * This patch: no-op. The webpack aliases handle everything.
 * Kept as documentation of the analysis.
 */

module.exports = function applyPrefsPatch () {
  // No runtime patch needed — electron-shim's remote.require('./prefs') returns prefsShim
  // which reads from the pre-cached prefs fetched during web-preload.js init()
  console.log('[web-patches/prefs] No patch needed — handled by electron-shim prefsShim')
}
