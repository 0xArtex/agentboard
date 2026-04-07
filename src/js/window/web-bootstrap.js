/**
 * web-bootstrap.js — Async bootstrap for Storyboarder Web
 *
 * Pre-fetches all data that main-window.js tries to read synchronously,
 * caches it in the electron-shim's file cache, then loads main-window.js.
 *
 * This replaces the direct require('./main-window') in web-entry.js.
 */

const electronShim = require('../electron-shim')

const API_BASE = '/api'

/**
 * Fetch project info from the backend and set up sharedObj
 */
async function setupSharedObj () {
  let projectId = null
  let projectJson = null

  const params = new URLSearchParams(window.location.search)
  const urlProjectId = params.get('project')

  try {
    if (urlProjectId) {
      const res = await window.fetch(`${API_BASE}/projects/${urlProjectId}`)
      if (res.ok) {
        const data = await res.json()
        projectId = data.id
        projectJson = data.project
      }
    }
    if (!projectId) {
      const res = await window.fetch(`${API_BASE}/projects/current`)
      if (res.ok) {
        const data = await res.json()
        projectId = data.id
        projectJson = data.project
      }
    }
  } catch (err) {
    console.warn('[web-bootstrap] Could not fetch project:', err.message)
  }

  const sharedObj = {
    port: parseInt(window.location.port, 10) || 3456,
    enableAnalytics: false,
    prefs: electronShim._cachedPrefs || {},
    enableTooltips: true,
  }

  if (projectId && projectJson) {
    const projectPath = `/web/projects/${projectId}`
    sharedObj.projectPath = projectPath
    sharedObj.boardPath = projectPath
    sharedObj.boardFilename = `${projectPath}/project.storyboarder`
    sharedObj.projectId = projectId
    sharedObj.projectJson = projectJson
    // Pre-cache the real project file JSON so readFileSync returns it
    electronShim._cacheFile(sharedObj.boardFilename, JSON.stringify(projectJson))
  } else {
    sharedObj.projectPath = '/web/projects/default'
    sharedObj.boardPath = '/web/projects/default'
    sharedObj.boardFilename = '/web/projects/default/default.storyboarder'
  }

  window.__sharedObj = sharedObj
  console.log('[web-bootstrap] sharedObj:', sharedObj)
  return sharedObj
}

/**
 * Pre-fetch the board JSON file and cache it in the fs shim
 */
async function prefetchBoardFile (sharedObj) {
  const boardFilename = sharedObj.boardFilename
  if (!boardFilename) return

  // If we already have the real project JSON cached from setupSharedObj, use it.
  // Otherwise fall back to fs API.
  let projectJson = sharedObj.projectJson
  if (!projectJson) {
    try {
      const res = await window.fetch(
        `${API_BASE}/fs/read?path=${encodeURIComponent(boardFilename)}`
      )
      if (res.ok) {
        const text = await res.text()
        electronShim._cacheFile(boardFilename, text)
        try { projectJson = JSON.parse(text) } catch (e) {}
        console.log('[web-bootstrap] Cached board file (fs):', boardFilename)
      }
    } catch (err) {
      console.warn('[web-bootstrap] Could not prefetch board file:', err.message)
    }
  } else {
    console.log('[web-bootstrap] Using pre-cached real project:', boardFilename)
  }

  if (!projectJson) {
    // Empty fallback
    const defaultBoard = JSON.stringify({
      version: '1.0.0', aspectRatio: 2.333, fps: 24,
      defaultBoardTiming: 2000, boards: []
    })
    electronShim._cacheFile(boardFilename, defaultBoard)
    return
  }

  // Warm the shim's existsSync cache with EVERY asset filename the server
  // currently has for this project. main-window.js's verifyScene() does
  // synchronous fs.existsSync() checks against these filenames; without
  // pre-warming, the cache is empty on every page load, verifyScene reports
  // every layer as "missing", and writes blank placeholders that destroy
  // the user's drawings. This single fetch fixes the refresh-loses-work bug
  // root cause.
  //
  // We don't fetch the actual bytes — just register the path as "exists".
  // The browser will fetch the real bytes on demand when main-window.js
  // sets an Image().src to the same URL.
  const boardPath = sharedObj.boardPath
  if (sharedObj.projectId) {
    try {
      const filesRes = await window.fetch(
        `${API_BASE}/projects/${sharedObj.projectId}/files`
      )
      if (filesRes.ok) {
        const { files } = await filesRes.json()
        for (const file of files) {
          // Marker bytes — we just need existsSync to return true. The actual
          // image data is fetched by Image() through the static handler.
          electronShim._cacheFile(`${boardPath}/images/${file.filename}`, new Uint8Array(0))
        }
        console.log('[web-bootstrap] Warmed existsSync cache with', files.length, 'assets')
      }
    } catch (err) {
      console.warn('[web-bootstrap] Could not prefetch project files:', err.message)
    }
  }
}

/**
 * Pre-fetch language settings
 */
async function prefetchLanguage () {
  try {
    const res = await window.fetch(`${API_BASE}/prefs/language`)
    if (res.ok) {
      const data = await res.json()
      if (data && data.value) {
        window.__storyboarder_language = data.value
        return
      }
    }
  } catch (err) {
    // ignore
  }

  // Default to browser locale or 'en'
  const browserLang = (navigator.language || 'en').split('-')[0]
  window.__storyboarder_language = browserLang || 'en'
  console.log('[web-bootstrap] Language:', window.__storyboarder_language)
}

/**
 * Cache locale JSON files so i18n can find them via readFileSync
 */
async function prefetchLocaleFiles () {
  const lang = window.__storyboarder_language || 'en'
  // The i18n config looks for: path.join(app.getAppPath(), 'src', 'js', 'locales', `${lng}.json`)
  // app.getAppPath() returns '/' in our shim, so the path becomes /src/js/locales/en.json
  const localePaths = [
    `/src/js/locales/${lang}.json`,
    `/src/js/locales/en.json`  // always cache English as fallback
  ]

  for (const localePath of [...new Set(localePaths)]) {
    try {
      const res = await window.fetch(localePath)
      if (res.ok) {
        const text = await res.text()
        electronShim._cacheFile(localePath, text)
        console.log('[web-bootstrap] Cached locale:', localePath)
      }
    } catch (err) {
      // Locale file not available, i18n will handle gracefully
    }
  }
}

/**
 * Cache the language settings file that SettingsService tries to read
 */
async function prefetchLanguageSettings () {
  // SettingsService reads: path.join(userDataPath, 'locales', 'language-settings.json')
  // userDataPath = app.getPath('userData') = '/web/userData'
  const settingsPath = '/web/userData/locales/language-settings.json'
  const lang = window.__storyboarder_language || 'en'

  // Create a minimal settings file
  const settings = JSON.stringify({
    selectedLanguage: lang,
    builtInLanguages: [
      { fileName: 'en', language: 'English' }
    ]
  })
  electronShim._cacheFile(settingsPath, settings)
  // Also ensure the fs shim's ensureFileSync won't fail
  electronShim._cacheFile(settingsPath, settings)
}

/**
 * Main bootstrap sequence
 */
async function bootstrap () {
  console.log('[web-bootstrap] Starting bootstrap...')

  // 1. Set up language first (sendSync needs it before main-window loads)
  await prefetchLanguage()
  await prefetchLanguageSettings()
  await prefetchLocaleFiles()

  // 2. Set up sharedObj (remote.getGlobal needs it)
  const sharedObj = await setupSharedObj()

  // 3. Pre-fetch the board file (readFileSync needs it)
  await prefetchBoardFile(sharedObj)

  // Set up global __dirname for modules that use window.__dirname or __dirname at load time.
  // In Electron, this points to the file's directory. We use '/src/js/window' which is where
  // main-window.js lives — then relative paths like '../../data/brushes' resolve to '/src/data/brushes',
  // which the backend serves as static files.
  if (typeof window.__dirname === 'undefined') {
    // path.join('/js/window', '..', '..', 'data', 'brushes') = '/data/brushes'
    // which the server serves from src/data/brushes/
    window.__dirname = '/js/window'
  }
  if (typeof window.__filename === 'undefined') {
    window.__filename = '/js/window/main-window.js'
  }

  console.log('[web-bootstrap] Bootstrap complete, loading main-window...')

  // 4. Now load main-window — all sync calls should be satisfied
  require('./main-window')

  console.log('[web-bootstrap] main-window loaded')

  // 5. Simulate the 'load' IPC event that Electron's main process sends
  // This triggers the actual project load in main-window.js
  setTimeout(() => {
    const { ipcRenderer } = require('electron')
    console.log('[web-bootstrap] Triggering load event...')
    // The load handler expects: (event, args) where args[0] = boardFilename
    // For script-based projects, args[1] = scriptData
    const loadArgs = [sharedObj.boardFilename]
    
    // Emit directly through the handlers since ipcRenderer.on was used to register
    if (ipcRenderer._handlers && ipcRenderer._handlers.has('load')) {
      const handlers = ipcRenderer._handlers.get('load')
      handlers.forEach(h => {
        h.wrapped(loadArgs)
      })
    }
  }, 100)
}

module.exports = { bootstrap }

// Auto-run
bootstrap().catch(err => {
  console.error('[web-bootstrap] Bootstrap failed:', err)
  document.body.innerHTML = '<div style="padding:2em;color:red;font-family:sans-serif">' +
    '<h2>Storyboarder Web - Bootstrap Failed</h2>' +
    '<pre>' + (err.stack || err.message || err) + '</pre>' +
    '</div>'
})
