/**
 * web-preload.js — Pre-loader for Storyboarder Web
 *
 * Connects socket.io, pre-fetches prefs and brush data,
 * and wires up the electron-shim globals before the main app loads.
 */

const io = require('socket.io-client')

// Import the shim internals we need to populate
const electronShim = require('./electron-shim')

const API_BASE = '/api'

/**
 * Pre-fetch preferences from the backend
 */
async function fetchPrefs () {
  try {
    const res = await window.fetch(API_BASE + '/prefs')
    if (res.ok) {
      const prefs = await res.json()
      electronShim._cachePrefs(prefs)
      return prefs
    }
  } catch (err) {
    console.warn('[web-preload] Could not fetch prefs:', err.message)
  }
  return {}
}

/**
 * Pre-fetch brush PNG data files used by the sketch pane
 */
async function fetchBrushes () {
  const brushFiles = [
    '/data/brushes/brush-pen.png',
    '/data/brushes/pencil.png',
    '/data/brushes/pencil2.png',
    '/data/brushes/charcoal.png',
    '/data/brushes/watercolor.png',
    '/data/brushes/eraser.png'
  ]

  const results = await Promise.allSettled(
    brushFiles.map(async (filePath) => {
      try {
        const res = await window.fetch(filePath)
        if (res.ok) {
          const blob = await res.blob()
          const reader = new FileReader()
          return new Promise((resolve) => {
            reader.onloadend = () => {
              electronShim._cacheFile(filePath, reader.result)
              resolve()
            }
            reader.readAsDataURL(blob)
          })
        }
      } catch (err) {
        console.warn('[web-preload] Could not fetch brush:', filePath, err.message)
      }
    })
  )
  return results
}

/**
 * Initialize socket.io connection to backend
 */
function connectSocket () {
  const socket = io(window.location.origin, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionAttempts: 10
  })

  socket.on('connect', () => {
    console.log('[web-preload] Socket.io connected:', socket.id)
  })

  socket.on('disconnect', (reason) => {
    console.warn('[web-preload] Socket.io disconnected:', reason)
  })

  socket.on('connect_error', (err) => {
    console.warn('[web-preload] Socket.io connection error:', err.message)
  })

  // Wire socket into electron-shim so ipcRenderer events route through it
  electronShim._setSocket(socket)

  return socket
}

/**
 * Main init — returns a promise that resolves when preloading is done.
 * The main app should await this before starting.
 */
function init () {
  return new Promise(async (resolve) => {
    console.log('[web-preload] Initializing...')

    // 1. Connect socket
    const socket = connectSocket()

    // 2. Pre-fetch data in parallel
    await Promise.allSettled([
      fetchPrefs(),
      fetchBrushes()
    ])

    console.log('[web-preload] Preload complete')
    resolve({ socket })
  })
}

module.exports = { init }
