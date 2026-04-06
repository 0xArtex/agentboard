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
  // PIXI in the browser may fail to load images without CORS credentials or
  // when the image URL uses backslashes or odd resolution. Pre-set the global
  // PIXI crossOrigin to anonymous, and install a global Image loader override
  // that normalizes brush paths to absolute URLs.
  try {
    // Override Image constructor hooks so PIXI's BaseTexture.fromImage works
    // Actually, the simplest fix: pre-load brush PNGs into Image cache so
    // when PIXI creates a new Image() with the same src, the browser serves
    // from memory and fires 'load' even without CORS.
    const brushNames = [
      'brushefficiency', 'brushhard', 'brushmediumoval', 'brushmediumovalhollow',
      'brushsoft', 'graincanvas', 'grainpaper2', 'grainpaper4', 'hardwood', 'teardrop'
    ]
    await Promise.all(brushNames.map(name => {
      return new Promise((resolve) => {
        const img = new Image()
        img.crossOrigin = 'anonymous'
        // Warm the cache at multiple paths that might be used
        img.onload = img.onerror = resolve
        img.src = '/data/brushes/' + name + '.png'
        // Keep a global reference so it isn't GC'd
        window.__brushImageCache = window.__brushImageCache || []
        window.__brushImageCache.push(img)
      })
    }))
    console.log('[web-patches/sketch-pane] Pre-loaded', brushNames.length, 'brush images')
  } catch (err) {
    console.warn('[web-patches/sketch-pane] brush image preload failed:', err.message)
  }

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
