/**
 * electron-shim.js — Browser-compatible drop-in replacement for Electron APIs
 * 
 * This file is aliased by webpack so that:
 *   require('electron')        → this file
 *   require('@electron/remote') → this file
 *   require('fs')              → this file (exports.fs / exports.default for fs)
 *   require('fs-extra')        → this file
 *
 * It provides browser-compatible replacements for ALL Electron APIs used
 * across the ~90 affected Storyboarder files.
 */

const API_BASE = '/api'

// ============================================================
// Pre-loaded file cache (populated by web-preload.js)
// ============================================================
const preloadedFiles = new Map()
const cachedPrefs = {}

// Public API to populate the cache from web-preload
function _cacheFile(filePath, content) {
  preloadedFiles.set(filePath, content)
}
function _cachePrefs(prefs) {
  Object.assign(cachedPrefs, prefs)
}

// ============================================================
// Socket.io connection (set by web-preload.js)
// ============================================================
let _socket = null
function _setSocket(socket) {
  _socket = socket
}

// ============================================================
// Window shim (replaces remote.getCurrentWindow())
// ============================================================
const windowShim = {
  webContents: {
    send: (channel, ...args) => {
      if (_socket) _socket.emit(channel, ...args)
    },
    on: (channel, handler) => {
      if (_socket) _socket.on(channel, handler)
    },
  },
  setTitle: (title) => { document.title = title },
  getTitle: () => document.title,
  isFullScreen: () => !!document.fullscreenElement,
  setFullScreen: (flag) => {
    if (flag) {
      document.documentElement.requestFullscreen().catch(() => {})
    } else {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    }
  },
  isMaximized: () => false,
  minimize: () => {},
  maximize: () => {},
  unmaximize: () => {},
  close: () => { window.close() },
  on: (event, handler) => {
    // Map common Electron window events to browser equivalents
    if (event === 'resize') window.addEventListener('resize', handler)
    if (event === 'focus') window.addEventListener('focus', handler)
    if (event === 'blur') window.addEventListener('blur', handler)
  },
  removeListener: (event, handler) => {
    if (event === 'resize') window.removeEventListener('resize', handler)
    if (event === 'focus') window.removeEventListener('focus', handler)
    if (event === 'blur') window.removeEventListener('blur', handler)
  },
  show: () => {},
  hide: () => {},
  isFocused: () => document.hasFocus(),
  getBounds: () => ({
    x: window.screenX,
    y: window.screenY,
    width: window.innerWidth,
    height: window.innerHeight,
  }),
  setBounds: () => {},
  setSize: () => {},
  getSize: () => [window.innerWidth, window.innerHeight],
  id: 1,
}

// ============================================================
// Dialog shim (replaces remote.dialog / electron.dialog)
// ============================================================
const dialogShim = {
  showOpenDialog: async (browserWindow, options) => {
    // Handle both (options) and (browserWindow, options) signatures
    if (!options && browserWindow && !browserWindow.webContents) {
      options = browserWindow
      browserWindow = null
    }
    
    return new Promise((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      if (options && options.properties && options.properties.includes('openDirectory')) {
        input.webkitdirectory = true
      }
      if (options && options.properties && options.properties.includes('multiSelections')) {
        input.multiple = true
      }
      if (options && options.filters && options.filters.length) {
        const exts = options.filters.flatMap(f => f.extensions || [])
        if (exts.length) input.accept = exts.map(e => '.' + e).join(',')
      }
      input.addEventListener('change', () => {
        const filePaths = Array.from(input.files || []).map(f => f.name)
        resolve({ canceled: filePaths.length === 0, filePaths, files: Array.from(input.files || []) })
      })
      input.addEventListener('cancel', () => {
        resolve({ canceled: true, filePaths: [] })
      })
      input.click()
    })
  },

  showSaveDialog: async (browserWindow, options) => {
    if (!options && browserWindow && !browserWindow.webContents) {
      options = browserWindow
      browserWindow = null
    }
    
    const defaultName = (options && options.defaultPath) || 'untitled'
    const fileName = prompt('Save as:', defaultName)
    if (!fileName) return { canceled: true, filePath: undefined }
    return { canceled: false, filePath: fileName }
  },

  showMessageBox: async (browserWindow, options) => {
    if (!options && browserWindow && !browserWindow.webContents) {
      options = browserWindow
      browserWindow = null
    }
    
    const buttons = (options && options.buttons) || ['OK']
    if (buttons.length <= 2) {
      const result = confirm(
        ((options && options.title) ? options.title + '\n\n' : '') +
        ((options && options.message) || '')
      )
      return { response: result ? 0 : 1 }
    }
    // For more buttons, fall back to 0 (first button)
    alert(((options && options.title) ? options.title + '\n\n' : '') + ((options && options.message) || ''))
    return { response: 0 }
  },

  showMessageBoxSync: (browserWindow, options) => {
    if (!options && browserWindow && !browserWindow.webContents) {
      options = browserWindow
      browserWindow = null
    }
    const result = confirm(((options && options.message) || ''))
    return result ? 0 : 1
  },

  showOpenDialogSync: () => {
    console.warn('[electron-shim] showOpenDialogSync not available in browser, use async showOpenDialog')
    return undefined
  },

  showSaveDialogSync: () => {
    console.warn('[electron-shim] showSaveDialogSync not available in browser, use async showSaveDialog')
    return undefined
  },
}

// ============================================================
// ipcRenderer shim (maps to socket.io)
// ============================================================
const ipcRenderer = {
  on: (channel, handler) => {
    if (_socket) {
      const wrappedHandler = (...args) => handler({ sender: ipcRenderer }, ...args)
      _socket.on(channel, wrappedHandler)
      // Store for removeListener
      if (!ipcRenderer._handlers) ipcRenderer._handlers = new Map()
      if (!ipcRenderer._handlers.has(channel)) ipcRenderer._handlers.set(channel, [])
      ipcRenderer._handlers.get(channel).push({ original: handler, wrapped: wrappedHandler })
    }
    return ipcRenderer
  },
  once: (channel, handler) => {
    if (_socket) {
      const wrappedHandler = (...args) => handler({ sender: ipcRenderer }, ...args)
      _socket.once(channel, wrappedHandler)
    }
    return ipcRenderer
  },
  send: (channel, ...args) => {
    if (_socket) _socket.emit(channel, ...args)
  },
  invoke: async (channel, ...args) => {
    return new Promise((resolve, reject) => {
      if (!_socket) return reject(new Error('Socket not connected'))
      const replyChannel = `${channel}:reply:${Date.now()}`
      _socket.once(replyChannel, (result) => resolve(result))
      _socket.emit(channel, ...args, replyChannel)
    })
  },
  removeListener: (channel, handler) => {
    if (_socket && ipcRenderer._handlers && ipcRenderer._handlers.has(channel)) {
      const handlers = ipcRenderer._handlers.get(channel)
      const idx = handlers.findIndex(h => h.original === handler)
      if (idx !== -1) {
        _socket.off(channel, handlers[idx].wrapped)
        handlers.splice(idx, 1)
      }
    }
    return ipcRenderer
  },
  removeAllListeners: (channel) => {
    if (_socket) {
      if (channel) {
        _socket.removeAllListeners(channel)
        if (ipcRenderer._handlers) ipcRenderer._handlers.delete(channel)
      } else {
        _socket.removeAllListeners()
        if (ipcRenderer._handlers) ipcRenderer._handlers.clear()
      }
    }
    return ipcRenderer
  },
  sendSync: (channel, ...args) => {
    // Return cached/default values for known sync channels
    const syncDefaults = {
      'getCurrentLanguage': window.__storyboarder_language || 'en',
      'getLanguage': window.__storyboarder_language || 'en',
    }
    if (channel in syncDefaults) {
      return syncDefaults[channel]
    }
    console.warn(`[electron-shim] sendSync('${channel}') not available in browser`)
    return null
  },
  _handlers: new Map(),
}

// ============================================================
// shell shim
// ============================================================
const shell = {
  openExternal: (url) => { window.open(url, '_blank'); return Promise.resolve() },
  showItemInFolder: (fullPath) => {
    console.info('[electron-shim] showItemInFolder:', fullPath)
  },
  openItem: (fullPath) => {
    // Try to open as URL from the API
    window.open(`${API_BASE}/projects/current/files/${encodeURIComponent(fullPath)}`, '_blank')
    return true
  },
  openPath: (fullPath) => {
    window.open(`${API_BASE}/projects/current/files/${encodeURIComponent(fullPath)}`, '_blank')
    return Promise.resolve('')
  },
  beep: () => {},
}

// ============================================================
// clipboard shim
// ============================================================
const clipboard = {
  writeImage: async (nativeImg) => {
    try {
      const dataURL = typeof nativeImg.toDataURL === 'function' ? nativeImg.toDataURL() : nativeImg
      const resp = await fetch(dataURL)
      const blob = await resp.blob()
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    } catch (err) {
      console.warn('[electron-shim] clipboard.writeImage failed:', err)
    }
  },
  readImage: () => {
    return nativeImage.createEmpty()
  },
  writeText: (text) => {
    try { navigator.clipboard.writeText(text) } catch (e) { /* fallback */ }
  },
  readText: async () => {
    try { return await navigator.clipboard.readText() } catch (e) { return '' }
  },
  writeHTML: () => {},
  readHTML: () => '',
  clear: () => {},
  availableFormats: () => [],
}

// ============================================================
// nativeImage shim
// ============================================================
const nativeImage = {
  createFromBuffer: (buffer) => ({
    toDataURL: () => {
      try {
        const blob = new Blob([buffer], { type: 'image/png' })
        return URL.createObjectURL(blob)
      } catch (e) {
        return ''
      }
    },
    toPNG: () => buffer,
    toJPEG: () => buffer,
    getSize: () => ({ width: 0, height: 0 }),
    isEmpty: () => !buffer || buffer.length === 0,
  }),
  createFromPath: (filePath) => ({
    toDataURL: () => `${API_BASE}/projects/current/files/${encodeURIComponent(filePath)}`,
    toPNG: () => new Uint8Array(0),
    toJPEG: () => new Uint8Array(0),
    getSize: () => ({ width: 0, height: 0 }),
    isEmpty: () => false,
  }),
  createFromDataURL: (dataURL) => ({
    toDataURL: () => dataURL,
    toPNG: () => {
      try {
        const base64 = dataURL.split(',')[1]
        const binary = atob(base64)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
        return bytes
      } catch (e) { return new Uint8Array(0) }
    },
    toJPEG: () => new Uint8Array(0),
    getSize: () => ({ width: 0, height: 0 }),
    isEmpty: () => !dataURL,
  }),
  createEmpty: () => ({
    toDataURL: () => '',
    toPNG: () => new Uint8Array(0),
    toJPEG: () => new Uint8Array(0),
    getSize: () => ({ width: 0, height: 0 }),
    isEmpty: () => true,
  }),
}

// ============================================================
// Prefs shim (replaces remote.require('./prefs'))
// ============================================================
const prefsShim = {
  init: (prefsFilePath) => {
    // In Electron, this loads prefs from a JSON file on disk.
    // In web, prefs are already cached from the API by web-preload.
    console.log('[electron-shim] prefsShim.init called with:', prefsFilePath)
    // No-op — prefs are fetched from API
  },
  savePrefs: () => {
    // Persist current prefs to backend
    fetch(`${API_BASE}/prefs`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cachedPrefs),
    }).catch(err => console.warn('[electron-shim] prefs.savePrefs failed:', err))
  },
  getPrefs: (name) => {
    if (name) return cachedPrefs[name] || {}
    return cachedPrefs
  },
  set: (key, value) => {
    cachedPrefs[key] = value
    fetch(`${API_BASE}/prefs`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: value }),
    }).catch(err => console.warn('[electron-shim] prefs.set failed:', err))
  },
  get: (key) => {
    return cachedPrefs[key]
  },
  versionCanBeMigrated: () => false,
  revokeLicense: () => {},
  // Some code accesses prefs() directly as a function
  _asFunction: function(name) {
    return prefsShim.getPrefs(name)
  },
}

// ============================================================
// fs / fs-extra shim
// ============================================================
const fsShim = {
  // Async methods (callback style — Node fs API)
  readFile: function(filePath, encodingOrOptions, callback) {
    if (typeof encodingOrOptions === 'function') {
      callback = encodingOrOptions
      encodingOrOptions = null
    }
    const encoding = typeof encodingOrOptions === 'string' ? encodingOrOptions : 
                     (encodingOrOptions && encodingOrOptions.encoding) || null
    
    fetch(`${API_BASE}/fs/read?path=${encodeURIComponent(filePath)}`)
      .then(resp => {
        if (!resp.ok) throw new Error(`ENOENT: no such file: ${filePath}`)
        return encoding ? resp.text() : resp.arrayBuffer()
      })
      .then(data => {
        if (!encoding && typeof Buffer !== 'undefined') data = Buffer.from(data)
        if (callback) callback(null, data)
      })
      .catch(err => { if (callback) callback(err) })
  },

  writeFile: function(filePath, data, encodingOrOptions, callback) {
    if (typeof encodingOrOptions === 'function') {
      callback = encodingOrOptions
      encodingOrOptions = null
    }
    
    fetch(`${API_BASE}/fs/write?path=${encodeURIComponent(filePath)}`, {
      method: 'POST',
      body: data,
    })
      .then(resp => {
        if (!resp.ok) throw new Error(`Write failed: ${filePath}`)
        if (callback) callback(null)
      })
      .catch(err => { if (callback) callback(err) })
  },

  // Sync methods — use pre-loaded cache, warn on miss
  readFileSync: function(filePath, encodingOrOptions) {
    const encoding = typeof encodingOrOptions === 'string' ? encodingOrOptions :
                     (encodingOrOptions && encodingOrOptions.encoding) || null
    
    if (preloadedFiles.has(filePath)) {
      const cached = preloadedFiles.get(filePath)
      return cached
    }
    
    // Try normalized path
    const normalized = filePath.replace(/\\/g, '/')
    if (preloadedFiles.has(normalized)) {
      return preloadedFiles.get(normalized)
    }
    
    // Try basename match for data files
    const basename = filePath.split('/').pop()
    for (const [key, value] of preloadedFiles) {
      if (key.endsWith('/' + basename) || key === basename) {
        return value
      }
    }
    
    console.warn(`[electron-shim] readFileSync cache miss: ${filePath}`)
    return encoding ? '' : (typeof Buffer !== 'undefined' ? Buffer.alloc(0) : new Uint8Array(0))
  },

  writeFileSync: function(filePath, data, options) {
    // Fire-and-forget async write
    fetch(`${API_BASE}/fs/write?path=${encodeURIComponent(filePath)}`, {
      method: 'POST',
      body: data,
    }).catch(err => console.warn('[electron-shim] writeFileSync async failed:', err))
    // Also cache locally
    preloadedFiles.set(filePath, data)
  },

  existsSync: function(filePath) {
    return preloadedFiles.has(filePath) || 
           preloadedFiles.has(filePath.replace(/\\/g, '/'))
  },

  exists: function(filePath, callback) {
    const exists = fsShim.existsSync(filePath)
    if (callback) callback(exists)
  },

  mkdirSync: function() {},
  mkdir: function(p, opts, cb) { if (typeof opts === 'function') cb = opts; if (cb) cb(null) },
  mkdirp: function(p, cb) { if (cb) cb(null) },

  readdirSync: function(dirPath) {
    const results = []
    const prefix = dirPath.replace(/\\/g, '/').replace(/\/$/, '') + '/'
    for (const key of preloadedFiles.keys()) {
      if (key.startsWith(prefix)) {
        const rest = key.slice(prefix.length)
        const name = rest.split('/')[0]
        if (name && !results.includes(name)) results.push(name)
      }
    }
    return results
  },

  readdir: function(dirPath, cb) {
    const result = fsShim.readdirSync(dirPath)
    if (cb) cb(null, result)
  },

  statSync: function(filePath) {
    const exists = fsShim.existsSync(filePath)
    return {
      isDirectory: () => false,
      isFile: () => exists,
      isSymbolicLink: () => false,
      size: exists ? (preloadedFiles.get(filePath) || '').length : 0,
      mtime: new Date(),
      ctime: new Date(),
      atime: new Date(),
      birthtime: new Date(),
    }
  },

  stat: function(filePath, cb) {
    if (cb) cb(null, fsShim.statSync(filePath))
  },

  lstatSync: function(filePath) { return fsShim.statSync(filePath) },
  lstat: function(filePath, cb) { fsShim.stat(filePath, cb) },

  unlinkSync: function(filePath) {
    preloadedFiles.delete(filePath)
    fetch(`${API_BASE}/fs/delete?path=${encodeURIComponent(filePath)}`, { method: 'DELETE' })
      .catch(() => {})
  },
  unlink: function(filePath, cb) {
    fsShim.unlinkSync(filePath)
    if (cb) cb(null)
  },

  renameSync: function() {},
  rename: function(oldP, newP, cb) { if (cb) cb(null) },

  copyFileSync: function() {},
  copyFile: function(src, dest, cb) { if (cb) cb(null) },

  createReadStream: function(filePath) {
    // Return a minimal EventEmitter-like object
    const stream = {
      _handlers: {},
      on: function(event, handler) { 
        this._handlers[event] = handler; return this 
      },
      pipe: function(dest) { return dest },
      destroy: function() {},
    }
    // Trigger data/end async
    setTimeout(() => {
      const data = preloadedFiles.get(filePath)
      if (data && stream._handlers.data) stream._handlers.data(data)
      if (stream._handlers.end) stream._handlers.end()
    }, 0)
    return stream
  },

  createWriteStream: function(filePath) {
    const chunks = []
    return {
      write: function(chunk) { chunks.push(chunk); return true },
      end: function(chunk) { 
        if (chunk) chunks.push(chunk)
        const data = chunks.join('')
        fsShim.writeFileSync(filePath, data)
      },
      on: function() { return this },
      once: function() { return this },
      emit: function() { return this },
    }
  },

  // Watch (no-op in browser — backend handles via WebSocket)
  watchFile: function() {},
  unwatchFile: function() {},
  watch: function() { 
    return { close: () => {}, on: () => {} } 
  },

  // fs-extra methods
  ensureDirSync: function() {},
  ensureDir: function(p, cb) { if (cb) cb(null) },
  ensureFileSync: function(p) {
    // Make sure the file exists in cache (no-op if already there)
    if (!preloadedFiles.has(p)) {
      preloadedFiles.set(p, '')
    }
  },
  ensureFile: function(p, cb) { fsShim.ensureFileSync(p); if (cb) cb(null) },
  copySync: function() {},
  copy: function(src, dest, cb) { if (cb) cb(null) },
  moveSync: function() {},
  move: function(src, dest, cb) { if (cb) cb(null) },
  removeSync: function(p) { preloadedFiles.delete(p) },
  remove: function(p, cb) { fsShim.removeSync(p); if (cb) cb(null) },
  emptyDirSync: function() {},
  emptyDir: function(p, cb) { if (cb) cb(null) },
  pathExistsSync: function(p) { return fsShim.existsSync(p) },
  pathExists: function(p, cb) { if (cb) cb(null, fsShim.existsSync(p)) },
  readJsonSync: function(p) {
    try {
      return JSON.parse(fsShim.readFileSync(p, 'utf8') || '{}')
    } catch (e) { return {} }
  },
  readJson: function(p, cb) {
    try {
      const data = fsShim.readJsonSync(p)
      if (cb) cb(null, data)
    } catch (e) { if (cb) cb(e) }
  },
  writeJsonSync: function(p, data, options) {
    const spaces = (options && options.spaces) || 2
    fsShim.writeFileSync(p, JSON.stringify(data, null, spaces))
  },
  writeJson: function(p, data, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {} }
    fsShim.writeJsonSync(p, data, opts)
    if (cb) cb(null)
  },
  outputFileSync: function(p, data) { fsShim.writeFileSync(p, data) },
  outputFile: function(p, data, cb) { fsShim.writeFileSync(p, data); if (cb) cb(null) },
  outputJsonSync: function(p, data, opts) { fsShim.writeJsonSync(p, data, opts) },
  outputJson: function(p, data, opts, cb) { fsShim.writeJson(p, data, opts, cb) },

  // Promise-based methods (fs-extra also exposes these)
  promises: {
    readFile: (p, opts) => new Promise((res, rej) => fsShim.readFile(p, opts, (e, d) => e ? rej(e) : res(d))),
    writeFile: (p, d, opts) => new Promise((res, rej) => fsShim.writeFile(p, d, opts, (e) => e ? rej(e) : res())),
    mkdir: (p) => Promise.resolve(),
    readdir: (p) => Promise.resolve(fsShim.readdirSync(p)),
    stat: (p) => Promise.resolve(fsShim.statSync(p)),
    unlink: (p) => new Promise((res) => { fsShim.unlinkSync(p); res() }),
    access: (p) => Promise.resolve(),
  },

  // Constants
  constants: {
    F_OK: 0,
    R_OK: 4,
    W_OK: 2,
    X_OK: 1,
  },

  access: function(p, mode, cb) {
    if (typeof mode === 'function') { cb = mode }
    if (cb) cb(null)
  },
  accessSync: function() {},
}

// ============================================================
// remote shim (replaces @electron/remote)
// ============================================================
const remote = {
  getGlobal: function(name) {
    if (name === 'sharedObj') {
      return window.__sharedObj || {
        projectPath: '/web/projects/default',
        boardFilename: 'default.storyboarder',
        port: window.location.port || 3456,
        enableAnalytics: false,
      }
    }
    console.warn(`[electron-shim] remote.getGlobal('${name}') — returning undefined`)
    return undefined
  },

  require: function(modulePath) {
    if (modulePath.includes('prefs') || modulePath === './prefs') return prefsShim
    if (modulePath === '@electron/remote/main') return { enable: () => {} }
    if (modulePath === 'electron-is-dev') return false
    // Return a no-op proxy for unknown requires
    console.warn(`[electron-shim] remote.require('${modulePath}') — returning no-op`)
    return new Proxy({}, { get: () => () => {} })
  },

  app: {
    getPath: function(name) {
      // Sync version returns a placeholder — async fetch in background
      const paths = {
        'userData': '/web/userData',
        'home': '/home/user',
        'temp': '/tmp',
        'desktop': '/home/user/Desktop',
        'documents': '/home/user/Documents',
        'downloads': '/home/user/Downloads',
        'pictures': '/home/user/Pictures',
        'appData': '/web/appData',
      }
      return paths[name] || `/web/${name}`
    },
    getAppPath: () => '/',
    getVersion: () => '3.0.0-web',
    getName: () => 'Storyboarder',
    getLocale: () => navigator.language || 'en',
    isPackaged: false,
    quit: () => { window.close() },
    exit: () => { window.close() },
    on: () => {},
    removeListener: () => {},
  },

  dialog: dialogShim,

  getCurrentWindow: () => windowShim,
  getCurrentWebContents: () => windowShim.webContents,

  process: {
    platform: 'browser',
    arch: 'web',
    version: 'v18.0.0',
    versions: { electron: '0.0.0', chrome: navigator.userAgent },
    env: typeof process !== 'undefined' ? process.env : {},
    argv: [],
    type: 'browser',
    resourcesPath: '/',
    cwd: () => '/',
  },

  BrowserWindow: {
    getAllWindows: () => [windowShim],
    getFocusedWindow: () => windowShim,
    fromId: () => windowShim,
    fromWebContents: () => windowShim,
  },

  Menu: {
    buildFromTemplate: () => ({ popup: () => {}, closePopup: () => {} }),
    setApplicationMenu: () => {},
    getApplicationMenu: () => null,
  },
  MenuItem: function() {},

  screen: {
    getPrimaryDisplay: () => ({
      workAreaSize: { width: window.screen.width, height: window.screen.height },
      size: { width: window.screen.width, height: window.screen.height },
      bounds: { x: 0, y: 0, width: window.screen.width, height: window.screen.height },
      scaleFactor: window.devicePixelRatio || 1,
    }),
    getAllDisplays: () => [remote.screen.getPrimaryDisplay()],
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  },

  globalShortcut: {
    register: () => {},
    unregister: () => {},
    unregisterAll: () => {},
    isRegistered: () => false,
  },

  powerSaveBlocker: {
    start: () => 0,
    stop: () => {},
    isStarted: () => false,
  },
}

// ============================================================
// BrowserWindow shim (for code that imports electron.BrowserWindow)
// ============================================================
const BrowserWindow = remote.BrowserWindow

// ============================================================
// app shim (for code that imports electron.app)
// ============================================================
const app = remote.app

// ============================================================
// Module exports — structured to work with multiple import patterns:
//   const { ipcRenderer } = require('electron')
//   const remote = require('@electron/remote')
//   const fs = require('fs')
//   const fse = require('fs-extra')
// ============================================================

// webFrame shim — used for zoom control (Electron's renderer-only API)
const webFrame = {
  setZoomFactor: (factor) => {
    if (document && document.body) {
      document.body.style.zoom = factor
    }
  },
  getZoomFactor: () => {
    return parseFloat(document?.body?.style?.zoom) || 1
  },
  setZoomLevel: () => {},
  getZoomLevel: () => 0,
  setVisualZoomLevelLimits: () => {},
  setLayoutZoomLevelLimits: () => {},
  registerURLSchemeAsSecure: () => {},
  registerURLSchemeAsBypassingCSP: () => {},
  registerURLSchemeAsPrivileged: () => {},
  insertCSS: () => {},
  executeJavaScript: () => Promise.resolve(),
  on: () => {},
  removeListener: () => {},
}

// For require('electron')
module.exports = {
  ipcRenderer,
  shell,
  clipboard,
  nativeImage,
  remote,
  dialog: dialogShim,
  app,
  BrowserWindow,
  webFrame,
  screen: remote.screen,
  Menu: remote.Menu,
  MenuItem: remote.MenuItem,
  globalShortcut: remote.globalShortcut,
  powerSaveBlocker: remote.powerSaveBlocker,
}

// For require('@electron/remote') — the default export IS the remote object
module.exports.default = remote

// For require('fs') — also export all fs methods at top level
// Webpack alias for 'fs' and 'fs-extra' points here
// Code like: const fs = require('fs') will get this module
// then fs.readFileSync works because we export fsShim methods
Object.keys(fsShim).forEach(key => {
  if (!(key in module.exports)) {
    module.exports[key] = fsShim[key]
  }
})

// Also expose as named export
module.exports.fs = fsShim

// getCurrentWindow shorthand (some code imports this directly)
module.exports.getCurrentWindow = remote.getCurrentWindow

// Private API for web-preload.js
module.exports._cacheFile = _cacheFile
module.exports._cachePrefs = _cachePrefs
module.exports._setSocket = _setSocket
module.exports._preloadedFiles = preloadedFiles
module.exports._cachedPrefs = cachedPrefs
