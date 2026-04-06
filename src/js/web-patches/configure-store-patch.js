/**
 * configure-store-patch.js — Add composeWithStateSync to electron-redux shim
 * 
 * configureStore.js does:
 *   const { composeWithStateSync } = process.type == 'renderer'
 *     ? require('electron-redux/renderer')
 *     : require('electron-redux/main')
 * 
 * The webpack alias routes 'electron-redux/renderer' → electron-redux-shim.js
 * but the shim doesn't export composeWithStateSync.
 * 
 * Also: `process.type` is 'renderer' in Electron, but undefined/'browser' in web.
 * With webpack's process polyfill, process.type is likely undefined, so
 * the ternary goes to the else branch → require('electron-redux/main').
 * Both are aliased to the same shim, so we patch whichever we get.
 * 
 * composeWithStateSync works like Redux's compose() — it chains store enhancers.
 */

module.exports = function applyConfigureStorePatch () {
  try {
    // Patch both branches since we don't know which the ternary will take
    const shimRenderer = require('electron-redux/renderer')
    const shimMain = require('electron-redux/main')
    
    const composeWithStateSync = function composeWithStateSync (...funcs) {
      if (funcs.length === 0) return arg => arg
      if (funcs.length === 1) return funcs[0]
      return funcs.reduce((a, b) => (...args) => a(b(...args)))
    }

    // Add to both module caches
    if (!shimRenderer.composeWithStateSync) {
      shimRenderer.composeWithStateSync = composeWithStateSync
    }
    if (!shimMain.composeWithStateSync) {
      shimMain.composeWithStateSync = composeWithStateSync
    }

    // Also add to default exports if they exist
    if (shimRenderer.default && !shimRenderer.default.composeWithStateSync) {
      shimRenderer.default.composeWithStateSync = composeWithStateSync
    }
    if (shimMain.default && !shimMain.default.composeWithStateSync) {
      shimMain.default.composeWithStateSync = composeWithStateSync
    }

    console.log('[web-patches/configure-store] Patched composeWithStateSync into electron-redux shim')
  } catch (err) {
    console.warn('[web-patches/configure-store] Patch failed:', err.message)
  }
}
