/**
 * electron-remote-shim.js — Shim for require('@electron/remote')
 * 
 * When code does: const remote = require('@electron/remote')
 * It expects the remote object directly (with .require, .app, .dialog, etc.)
 * NOT the full electron module exports.
 */
const electronShim = require('../electron-shim')

// Export the remote object directly
module.exports = electronShim.remote || electronShim

// Also support: const { app, dialog } = require('@electron/remote')
if (electronShim.remote) {
  Object.keys(electronShim.remote).forEach(key => {
    module.exports[key] = electronShim.remote[key]
  })
}
