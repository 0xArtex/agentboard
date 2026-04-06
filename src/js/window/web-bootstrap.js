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
  let project = null

  // Check URL params for a specific project
  const params = new URLSearchParams(window.location.search)
  const projectId = params.get('project')

  try {
    if (projectId) {
      const res = await window.fetch(`${API_BASE}/projects/${projectId}`)
      if (res.ok) project = await res.json()
    }

    if (!project) {
      // Get first/default project
      const res = await window.fetch(`${API_BASE}/projects`)
      if (res.ok) {
        const projects = await res.json()
        if (Array.isArray(projects) && projects.length > 0) {
          project = projects[0]
        }
      }
    }
  } catch (err) {
    console.warn('[web-bootstrap] Could not fetch project:', err.message)
  }

  // Build sharedObj matching Electron's shape
  const sharedObj = {
    projectPath: (project && project.path) || '/web/projects/default',
    boardFilename: (project && project.boardFilename) || 'default.storyboarder',
    port: parseInt(window.location.port, 10) || 3456,
    enableAnalytics: false,
    prefs: electronShim._cachedPrefs || {},
    enableTooltips: true,
  }

  // If project provides a full board file path, use it
  if (project && project.boardPath) {
    sharedObj.boardFilename = project.boardPath
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

  try {
    // Try fetching via project files API
    const projectId = new URLSearchParams(window.location.search).get('project') || 'current'
    const res = await window.fetch(
      `${API_BASE}/projects/${projectId}/files/${encodeURIComponent(boardFilename)}`
    )
    if (res.ok) {
      const text = await res.text()
      electronShim._cacheFile(boardFilename, text)
      console.log('[web-bootstrap] Cached board file:', boardFilename)
      return
    }
  } catch (err) {
    // fall through
  }

  try {
    // Fallback: try the fs API
    const res = await window.fetch(
      `${API_BASE}/fs/read?path=${encodeURIComponent(boardFilename)}`
    )
    if (res.ok) {
      const text = await res.text()
      electronShim._cacheFile(boardFilename, text)
      console.log('[web-bootstrap] Cached board file (fs):', boardFilename)
      return
    }
  } catch (err) {
    console.warn('[web-bootstrap] Could not prefetch board file:', err.message)
  }

  // Cache an empty/default board so readFileSync doesn't crash
  const defaultBoard = JSON.stringify({
    version: '1.0.0',
    aspectRatio: 2.333,
    fps: 24,
    defaultBoardTiming: 2000,
    boards: []
  })
  electronShim._cacheFile(boardFilename, defaultBoard)
  console.log('[web-bootstrap] Using default empty board for:', boardFilename)
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
