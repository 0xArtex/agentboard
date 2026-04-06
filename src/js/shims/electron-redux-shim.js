/**
 * electron-redux-shim.js — Browser replacement for electron-redux
 * 
 * In Electron, electron-redux syncs Redux stores between main and renderer processes.
 * In the browser, there's only one process, so this is a no-op pass-through.
 */

// The main export used in renderer: forwardToMain middleware
const forwardToMain = () => next => action => next(action)

// The main export used in main process: forwardToRenderer middleware 
const forwardToRenderer = () => next => action => next(action)

// replayActionMain / replayActionRenderer — store enhancers
const replayActionMain = next => (...args) => next(...args)
const replayActionRenderer = next => (...args) => next(...args)

// composeWithStateSync — Redux compose() replacement (no-op in browser, just composes)
const composeWithStateSync = (...funcs) => {
  if (funcs.length === 0) return arg => arg
  if (funcs.length === 1) return funcs[0]
  return funcs.reduce((a, b) => (...args) => a(b(...args)))
}

// stateSyncEnhancer — store enhancer (pass-through in browser)
const stateSyncEnhancer = (createStoreFunc) => (...args) => createStoreFunc(...args)

// Preload function (called in preload script)
const preload = () => {}

// getInitialStateRenderer — returns undefined (no cross-process state)
const getInitialStateRenderer = () => undefined

// triggerAlias — middleware
const triggerAlias = () => next => action => next(action)

module.exports = {
  forwardToMain,
  forwardToRenderer,
  replayActionMain,
  replayActionRenderer,
  composeWithStateSync,
  stateSyncEnhancer,
  preload,
  getInitialStateRenderer,
  triggerAlias,
  default: {
    forwardToMain,
    forwardToRenderer,
    replayActionMain,
    replayActionRenderer,
    composeWithStateSync,
    stateSyncEnhancer,
    preload,
    getInitialStateRenderer,
    triggerAlias,
  }
}
