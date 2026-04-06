/**
 * electron-is-dev-shim.js — Browser replacement for electron-is-dev
 */

const isDev = (typeof process !== 'undefined' && process.env && process.env.NODE_ENV === 'development') || false

module.exports = isDev
module.exports.default = isDev
