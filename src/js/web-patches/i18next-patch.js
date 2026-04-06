/**
 * i18next-patch.js — Fix i18next initialization for browser
 * 
 * i18next.config.js does:
 *   const { app } = require('@electron/remote')
 *   const loadPath = path.join(app.getAppPath(), 'src', 'js', 'locales')
 * 
 * Problems:
 * 1. app.getAppPath() doesn't exist in electron-shim
 * 2. i18next-fs-backend is aliased to noop, so i18next.use(noop) then init()
 *    The noop shim returns proxy objects — i18next.use() may fail or not register a backend
 * 3. i18next falls back gracefully when no backend can load resources
 * 
 * Fix: Add getAppPath() to the electron-shim's app, and pre-load locale JSON
 * into the file cache so if anything tries to read locales, they're available.
 */

const electronShim = require('../electron-shim')

module.exports = async function applyI18nextPatch () {
  // 1. Add getAppPath to the remote.app shim
  // getAppPath() in Electron returns the app's root directory
  // In web mode, we use '/' as the base since files are served from root
  if (!electronShim.default.app.getAppPath) {
    electronShim.default.app.getAppPath = function () { return '/' }
  }
  if (!electronShim.app.getAppPath) {
    electronShim.app.getAppPath = function () { return '/' }
  }

  // 2. Pre-fetch the default locale (English) and cache it
  try {
    const res = await window.fetch('/src/js/locales/en.json')
    if (res.ok) {
      const text = await res.text()
      const possiblePaths = [
        '/src/js/locales/en.json',
        'src/js/locales/en.json',
      ]
      possiblePaths.forEach(p => electronShim._cacheFile(p, text))
      console.log('[web-patches/i18next] Cached en.json locale')
    }
  } catch (err) {
    // Not fatal — i18next will use fallback keys
    console.warn('[web-patches/i18next] Could not fetch en.json:', err.message)
  }
}
