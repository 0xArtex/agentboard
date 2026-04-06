/**
 * noop-shim.js — No-op shim for Node/Electron modules not needed in browser
 * Used as webpack alias target for: child_process, chokidar, trash,
 * node-machine-id, ffmpeg-static, i18next-fs-backend, tmp,
 * electron-google-analytics, electron-updater, etc.
 */

const noop = () => {}
const noopObj = new Proxy({}, {
  get: (target, prop) => {
    if (prop === '__esModule') return false
    if (prop === 'default') return noopObj
    return noop
  }
})

module.exports = noopObj
module.exports.default = noopObj
