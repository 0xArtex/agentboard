/**
 * electron-log-patch.js — Ensure storyboarder-electron-log.js works
 * 
 * storyboarder-electron-log.js does:
 *   function configureElectronLog (log) {
 *     log.transports.file.fileName = 'log.log'
 *     return log
 *   }
 *   module.exports = configureElectronLog(require('electron-log'))
 * 
 * The electron-log-shim.js already provides log.transports.file = { level: false }
 * Setting .fileName on it just adds a property — no crash.
 * 
 * This patch: no-op. Confirmed working with existing shim.
 */

module.exports = function applyElectronLogPatch () {
  // No patch needed — electron-log-shim handles this
}
