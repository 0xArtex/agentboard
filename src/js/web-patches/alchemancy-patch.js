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
  //
  // Guards against two failure modes:
  //
  //  1. width/height being zero or negative — the original would crash in
  //     createImageData on the empty default board.
  //
  //  2. pixel buffer length disagreeing with width*height*4. Storyboarder's
  //     boardFileImageSize returns [900 * aspectRatio, 900] which, for the
  //     default 1.7777 aspect, gives a fractional width of 1599.93. PIXI's
  //     RenderTexture.create rounds *up* to 1600 for GPU alignment, so
  //     extract.pixels yields a 1600×900 buffer (5,760,000 bytes) while a
  //     naive floor(1599.93)*900*4 check computes 5,756,400 — off by one
  //     row's worth of pixels. We used to treat that mismatch as corruption
  //     and return a blank canvas, which silently destroyed every drawing
  //     the user made.
  //
  //     Fix: trust the buffer. Height is always an integer (900), so the
  //     actual width is just `pixels.length / (height * 4)`. Use that to
  //     delegate to the original with dimensions that *match* the data PIXI
  //     handed us, regardless of how the caller rounded. If the derived
  //     width doesn't come out as a clean integer then the buffer really is
  //     malformed and we fall back to a blank.
  try {
    const Util = alch.util
    if (Util && Util.pixelsToCanvas) {
      const orig = Util.pixelsToCanvas
      Util.pixelsToCanvas = function (pixels, width, height) {
        let w = Math.max(0, Math.round(width || 0))
        let h = Math.max(0, Math.round(height || 0))
        try {
          if (w <= 0 || h <= 0) {
            const c = document.createElement('canvas')
            c.width = Math.max(1, w)
            c.height = Math.max(1, h)
            return c
          }

          // Reconcile dimensions with the actual pixel buffer PIXI produced.
          if (pixels && pixels.length) {
            const expected = w * h * 4
            if (pixels.length !== expected) {
              // Try to derive width from the buffer assuming height is right.
              const derivedW = pixels.length / (h * 4)
              if (Number.isInteger(derivedW) && derivedW > 0) {
                w = derivedW
              } else {
                console.warn(
                  '[web-patches/alchemancy] pixelsToCanvas buffer size unrecoverable',
                  'expected', expected, 'got', pixels.length,
                  'for nominal', w + 'x' + h
                )
                const c = document.createElement('canvas')
                c.width = w
                c.height = h
                return c
              }
            }
          }

          return orig.call(this, pixels, w, h)
        } catch (err) {
          console.warn('[web-patches/alchemancy] pixelsToCanvas swallowed:', err.message)
          const c = document.createElement('canvas')
          c.width = Math.max(1, w)
          c.height = Math.max(1, h)
          return c
        }
      }
      console.log('[web-patches/alchemancy] pixelsToCanvas guard installed')
    }
  } catch (err) {
    console.warn('[web-patches/alchemancy] pixelsToCanvas patch failed:', err.message)
  }
}
