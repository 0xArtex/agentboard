/**
 * electron-log-shim.js — Browser replacement for electron-log
 * Maps to console methods with [electron-log] prefix for grep-ability
 */

const log = (...args) => console.log('[electron-log]', ...args)
log.info = (...args) => console.info('[electron-log]', ...args)
log.warn = (...args) => console.warn('[electron-log]', ...args)
log.error = (...args) => console.error('[electron-log]', ...args)
log.debug = (...args) => console.debug('[electron-log]', ...args)
log.verbose = (...args) => console.debug('[electron-log:verbose]', ...args)
log.silly = (...args) => console.debug('[electron-log:silly]', ...args)

// electron-log exposes transports
log.transports = {
  console: { level: 'debug' },
  file: { level: false },
  remote: { level: false },
}

// catchErrors no-op
log.catchErrors = () => {}

module.exports = log
module.exports.default = log
