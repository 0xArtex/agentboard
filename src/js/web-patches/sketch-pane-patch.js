/**
 * sketch-pane-patch.js — Pre-cache brushes.json for StoryboarderSketchPane
 * 
 * storyboarder-sketch-pane.js does:
 *   fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'brushes', 'brushes.json'))
 * 
 * In webpack with __dirname: true, __dirname resolves to the module's directory
 * relative to the webpack context. We need to ensure the brushes.json is in the
 * pre-loaded file cache so readFileSync returns it.
 * 
 * Also caches prefs values that are read at module load time via:
 *   const prefsModule = require('@electron/remote').require('./prefs')
 *   prefsModule.getPrefs('main')['enableBrushCursor']
 */

const electronShim = require('../electron-shim')

module.exports = async function applySketchPanePatch () {
  // Pre-fetch brushes.json and cache it under multiple possible paths
  // so readFileSync can find it regardless of how __dirname resolves
  try {
    const res = await window.fetch('/data/brushes/brushes.json')
    if (res.ok) {
      const text = await res.text()
      
      // Cache under various path forms that path.join(__dirname, '..', '..', 'data', 'brushes', 'brushes.json')
      // might resolve to. Webpack __dirname: true gives paths like '/src/js/window' or './src/js/window'
      const possiblePaths = [
        'brushes.json',
        'data/brushes/brushes.json',
        '/data/brushes/brushes.json',
        'src/data/brushes/brushes.json',
        '/src/data/brushes/brushes.json',
        './src/data/brushes/brushes.json',
        '../data/brushes/brushes.json',
        '../../data/brushes/brushes.json',
        // webpack __dirname = '/src/js/window' → path.join('/src/js/window', '..', '..', 'data', ...) = '/src/data/brushes/brushes.json'
        '/src/data/brushes/brushes.json',
        // webpack __dirname = 'src/js/window' → 'src/data/brushes/brushes.json'
        'src/data/brushes/brushes.json',
        // webpack __dirname = '.' (sometimes) → '../../data/brushes/brushes.json' would be weird
      ]
      
      possiblePaths.forEach(p => electronShim._cacheFile(p, text))
      console.log('[web-patches/sketch-pane] Cached brushes.json under', possiblePaths.length, 'paths')
    } else {
      console.warn('[web-patches/sketch-pane] Could not fetch brushes.json:', res.status)
    }
  } catch (err) {
    console.warn('[web-patches/sketch-pane] brushes.json fetch failed:', err.message)
  }
}
