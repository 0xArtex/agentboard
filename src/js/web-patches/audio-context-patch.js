/**
 * audio-context-patch.js — resume Tone.js's AudioContext on first user gesture
 *
 * Browsers create the shared AudioContext in `suspended` state and refuse to
 * start it until a user gesture explicitly resumes it. Tone.js builds its
 * global context at module load time (during main-window's import chain), so
 * by the time the user actually clicks anywhere, Tone has already been
 * complaining for a while:
 *
 *   The AudioContext was not allowed to start. It must be resumed (or
 *   created) after a user gesture on the page.
 *
 * The Phase 2 fix in audio-file-control-view.js handled the recording path
 * (Recorder.initialize() resumes inside the record-button click), but the
 * sfx playback path (sound effects on tool change, save, etc.) and any other
 * Tone consumer still hit the warning.
 *
 * This patch installs one-shot capture-phase listeners on document for
 * pointerdown and keydown. The first time either fires, we lazily require
 * Tone and resume its context, then remove ourselves. Capture phase ensures
 * we run before app handlers that might depend on a running context.
 */

function applyAudioContextPatch () {
  let resumed = false

  const tryResume = () => {
    if (resumed) return
    resumed = true
    document.removeEventListener('pointerdown', tryResume, true)
    document.removeEventListener('keydown', tryResume, true)

    let Tone
    try {
      Tone = require('tone')
    } catch (err) {
      // Tone hasn't been loaded yet — nothing to resume. The recorder path
      // calls its own resume in Recorder.initialize() so we're still safe.
      return
    }

    const ctx = Tone && Tone.context && (Tone.context.rawContext || Tone.context)
    if (!ctx || typeof ctx.resume !== 'function') return
    if (ctx.state !== 'suspended') return

    ctx.resume().then(
      () => console.log('[web-patches/audio-context] Tone.context resumed'),
      (err) => console.warn('[web-patches/audio-context] Tone.context.resume() failed', err)
    )
  }

  document.addEventListener('pointerdown', tryResume, true)
  document.addEventListener('keydown', tryResume, true)
  console.log('[web-patches/audio-context] Gesture handler installed')
}

module.exports = applyAudioContextPatch
