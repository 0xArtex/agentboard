/**
 * alchemancy-patch.js — Defensive patches for alchemancy sketch pane
 *
 * 1. Cursor.renderCursor: guard against this.lastPointer being undefined
 *    (happens before first pointer move / before brush fully initialized).
 * 2. Util.pixelsToCanvas: wrap in try/catch to swallow "offset is out of
 *    bounds" when the empty default board has no real dimensions.
 */

module.exports = function applyAlchemancyPatch () {
  let alch
  try {
    alch = require('alchemancy')
  } catch (e) {
    console.warn('[web-patches/alchemancy] alchemancy not loadable yet:', e.message)
    return
  }

  // --- 1. Cursor.renderCursor guard ---
  try {
    const SketchPane = alch.SketchPane
    // Cursor class isn't exported directly — grab it via a temp instance's prototype.
    // Safer: monkey-patch after first instance is created by hooking SketchPane.prototype.
    // The cursor is created in SketchPane constructor; patch via a getter.
    // Simpler approach: patch SketchPane.prototype so wherever cursor is used we wrap it.
    // But renderCursor lives on Cursor instances. We patch by intercepting assignment.
    const origSketchPane = SketchPane
    // Walk up once an instance is built — patch its cursor's prototype.
    const patchCursor = (cursor) => {
      if (!cursor || cursor.__patched) return
      const proto = Object.getPrototypeOf(cursor)
      if (!proto || proto.__patched) { cursor.__patched = true; return }
      const orig = proto.renderCursor
      proto.renderCursor = function (e) {
        try {
          // lazy-init lastPointer if missing (alchemancy bug: declared but never assigned in constructor)
          if (!this.lastPointer || typeof this.lastPointer.set !== 'function') {
            try {
              const PIXI = require('pixi.js')
              this.lastPointer = new PIXI.Point(0, 0)
            } catch (pxErr) {
              // fallback: plain object with set() method
              this.lastPointer = { x: 0, y: 0, set: function(x, y) { this.x = x; this.y = y } }
            }
          }
          if (!e || typeof e.x !== 'number' || typeof e.y !== 'number') return
          return orig.call(this, e)
        } catch (err) {
          // swallow — cursor is cosmetic
        }
      }
      proto.__patched = true
      cursor.__patched = true
    }

    // Install a setter on SketchPane.prototype that patches cursor the moment it's assigned.
    // This runs in the constructor: `this.cursor = new Cursor(this)`.
    Object.defineProperty(SketchPane.prototype, 'cursor', {
      configurable: true,
      enumerable: true,
      get: function () { return this._cursor },
      set: function (c) {
        this._cursor = c
        try { patchCursor(c) } catch (e) {}
      }
    })
    
    // Also patch on setBrush and resize as a safety net
    const origSetBrush = SketchPane.prototype.setBrush
    if (origSetBrush) {
      SketchPane.prototype.setBrush = function (...a) {
        try { patchCursor(this.cursor) } catch (e) {}
        return origSetBrush.apply(this, a)
      }
    }
    const origResize = SketchPane.prototype.resize
    if (origResize) {
      SketchPane.prototype.resize = function (...a) {
        try { patchCursor(this.cursor) } catch (e) {}
        return origResize.apply(this, a)
      }
    }
    console.log('[web-patches/alchemancy] Cursor.renderCursor guard installed')
  } catch (err) {
    console.warn('[web-patches/alchemancy] cursor patch failed:', err.message)
  }

  // --- 2. Util.pixelsToCanvas defensive wrap ---
  try {
    const Util = alch.util
    if (Util && Util.pixelsToCanvas) {
      const orig = Util.pixelsToCanvas
      Util.pixelsToCanvas = function (pixels, width, height) {
        try {
          if (!width || !height || width <= 0 || height <= 0) {
            const c = document.createElement('canvas')
            c.width = Math.max(1, width | 0)
            c.height = Math.max(1, height | 0)
            return c
          }
          const expected = width * height * 4
          if (pixels && pixels.length && pixels.length !== expected) {
            // mismatched buffer — return blank canvas rather than crashing
            const c = document.createElement('canvas')
            c.width = width
            c.height = height
            return c
          }
          return orig.call(this, pixels, width, height)
        } catch (err) {
          console.warn('[web-patches/alchemancy] pixelsToCanvas swallowed:', err.message)
          const c = document.createElement('canvas')
          c.width = Math.max(1, width | 0)
          c.height = Math.max(1, height | 0)
          return c
        }
      }
      console.log('[web-patches/alchemancy] pixelsToCanvas guard installed')
    }
  } catch (err) {
    console.warn('[web-patches/alchemancy] pixelsToCanvas patch failed:', err.message)
  }
}
