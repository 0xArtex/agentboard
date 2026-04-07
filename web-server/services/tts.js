/**
 * tts.js — provider-agnostic AI audio generation
 *
 * Despite the legacy name, this module now covers THREE audio modes:
 *   - generate()              text-to-speech       → audio:narration
 *   - generateSoundEffect()   prompt-driven SFX    → audio:sfx
 *   - generateMusic()         prompt-driven music  → audio:music
 *
 * Same shape as image-gen.js:
 *   - Each method dispatches to the active provider
 *   - Mock adapter produces a valid audio file (deterministic WAVs that
 *     differ in waveform between speech / SFX / music so smoke tests can
 *     tell them apart)
 *   - ElevenLabs adapter is the real one, selected when ELEVENLABS_KEY is set
 *   - All methods return { bytes, mime, providerMeta, durationMs }
 *
 * Errors are mapped to the same structured codes as image-gen:
 *   BAD_TEXT, BAD_PROMPT, BAD_VOICE, BAD_MODEL, BAD_DURATION
 *   PROVIDER_UNAVAILABLE   — network / 5xx / timeout
 *   PROVIDER_REJECTED      — content moderation / 4xx from provider
 *   PROVIDER_MALFORMED     — provider returned a response we can't parse
 *
 * Adding a new audio provider (OpenAI TTS, Deepgram, Suno, etc.):
 *   1. Subclass TtsProvider
 *   2. Implement the three async methods (or throw NOT_IMPLEMENTED for
 *      capabilities the provider doesn't support)
 *   3. Register in createProvider()
 *   4. Document env vars in NOTES.local.md
 */

const crypto = require('crypto');

const DEFAULT_TIMEOUT_MS = 45_000;
const MIN_TEXT_LEN = 1;
const MAX_TEXT_LEN = 5000;

// Sound-effect prompts are short by nature ("thunderclap", "footsteps on
// gravel"). Music prompts can be longer ("a melancholic lo-fi piano piece
// over a soft kick drum"). The 4100 cap matches ElevenLabs' /v1/music
// limit; SFX prompts are well under this in practice.
const MIN_PROMPT_LEN = 1;
const MAX_PROMPT_LEN = 4100;

// SFX duration bounds — match ElevenLabs sound-generation API limits.
const MIN_SFX_DURATION_S = 0.5;
const MAX_SFX_DURATION_S = 22;
const DEFAULT_SFX_DURATION_S = 5;

// Music duration bounds — match ElevenLabs /v1/music API: 3s to 10min.
const MIN_MUSIC_LENGTH_MS = 3_000;
const MAX_MUSIC_LENGTH_MS = 600_000;
const DEFAULT_MUSIC_LENGTH_MS = 30_000;

class TtsError extends Error {
  constructor(code, message, { cause, providerMeta } = {}) {
    super(message);
    this.name = 'TtsError';
    this.code = code;
    if (cause) this.cause = cause;
    if (providerMeta) this.providerMeta = providerMeta;
  }
}

function validateText(text) {
  if (typeof text !== 'string') {
    throw new TtsError('BAD_TEXT', 'text must be a string');
  }
  const trimmed = text.trim();
  if (trimmed.length < MIN_TEXT_LEN) {
    throw new TtsError('BAD_TEXT', 'text must be non-empty');
  }
  if (trimmed.length > MAX_TEXT_LEN) {
    throw new TtsError('BAD_TEXT', `text must be under ${MAX_TEXT_LEN} characters`);
  }
  return trimmed;
}

function validatePrompt(prompt) {
  if (typeof prompt !== 'string') {
    throw new TtsError('BAD_PROMPT', 'prompt must be a string');
  }
  const trimmed = prompt.trim();
  if (trimmed.length < MIN_PROMPT_LEN) {
    throw new TtsError('BAD_PROMPT', 'prompt must be non-empty');
  }
  if (trimmed.length > MAX_PROMPT_LEN) {
    throw new TtsError('BAD_PROMPT', `prompt must be under ${MAX_PROMPT_LEN} characters`);
  }
  return trimmed;
}

function validateSfxDuration(seconds) {
  if (seconds == null) return DEFAULT_SFX_DURATION_S;
  const n = Number(seconds);
  if (!Number.isFinite(n)) {
    throw new TtsError('BAD_DURATION', 'durationSeconds must be a number');
  }
  if (n < MIN_SFX_DURATION_S || n > MAX_SFX_DURATION_S) {
    throw new TtsError('BAD_DURATION',
      `durationSeconds must be between ${MIN_SFX_DURATION_S} and ${MAX_SFX_DURATION_S}`);
  }
  return n;
}

function validateMusicLength(ms) {
  if (ms == null) return DEFAULT_MUSIC_LENGTH_MS;
  const n = Number(ms);
  if (!Number.isFinite(n)) {
    throw new TtsError('BAD_DURATION', 'musicLengthMs must be a number');
  }
  if (n < MIN_MUSIC_LENGTH_MS || n > MAX_MUSIC_LENGTH_MS) {
    throw new TtsError('BAD_DURATION',
      `musicLengthMs must be between ${MIN_MUSIC_LENGTH_MS} and ${MAX_MUSIC_LENGTH_MS}`);
  }
  return Math.round(n);
}

// ── base class ────────────────────────────────────────────────────────

class TtsProvider {
  constructor(config = {}) { this.config = config; }
  get name() { return 'abstract'; }
  get isMock() { return false; }
  async generate(opts) {
    throw new TtsError('NOT_IMPLEMENTED', 'abstract TtsProvider.generate');
  }
  async generateSoundEffect(opts) {
    throw new TtsError('NOT_IMPLEMENTED', 'abstract TtsProvider.generateSoundEffect');
  }
  async generateMusic(opts) {
    throw new TtsError('NOT_IMPLEMENTED', 'abstract TtsProvider.generateMusic');
  }
  async listVoices() {
    throw new TtsError('NOT_IMPLEMENTED', 'abstract TtsProvider.listVoices');
  }
}

// ── tiny WAV encoder for the mock ─────────────────────────────────────
//
// RIFF PCM mono WAV with a configurable duration and a deterministic
// waveform derived from the text hash. Produces valid audio that any
// player can render.
function buildWav(samples, sampleRate = 8000) {
  const numSamples = samples.length;
  const bitsPerSample = 16;
  const numChannels = 1;
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  const dataSize = numSamples * blockAlign;

  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);          // fmt chunk size
  buf.writeUInt16LE(1, 20);           // PCM
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i++) {
    buf.writeInt16LE(samples[i], 44 + i * 2);
  }
  return buf;
}

// ── mock provider ─────────────────────────────────────────────────────

class MockTtsProvider extends TtsProvider {
  get name() { return 'mock'; }
  get isMock() { return true; }

  async generate({ text, voice = 'mock-voice', model = 'mock-v1' }) {
    const cleaned = validateText(text);

    // Duration is a function of text length — roughly 60ms per character
    // (about the speed of "normal" speech). Bounded 0.2s → 5s so tests
    // stay fast but non-empty.
    const durationMs = Math.max(200, Math.min(5000, cleaned.length * 60));
    const sampleRate = 8000;
    const numSamples = Math.floor(sampleRate * durationMs / 1000);

    // Deterministic pseudo-waveform from the text hash. Not actual speech,
    // but it's audible content (varies between calls with different text)
    // rather than silence, so it's useful for eyeballing tests.
    const hash = crypto.createHash('sha256').update(cleaned + '|' + voice).digest();
    const freq = 200 + (hash[0] % 400);   // 200-600 Hz
    const amplitude = 3000;               // well below int16 max
    const samples = new Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;
      // Simple sine wave with a mild envelope
      const envelope = Math.sin(Math.PI * t / (durationMs / 1000));
      samples[i] = Math.round(amplitude * envelope * Math.sin(2 * Math.PI * freq * t));
    }

    return {
      bytes: buildWav(samples, sampleRate),
      mime: 'audio/wav',
      durationMs,
      providerMeta: {
        provider: 'mock',
        kind: 'speech',
        model,
        voice,
        text: cleaned,
        sampleRate,
        frequency: freq,
      },
    };
  }

  // Sound effect mock — band-limited noise burst with an attack/decay
  // envelope keyed by the prompt hash. Distinguishable from speech (which
  // is a clean sine) without needing a real DSP library.
  async generateSoundEffect({ prompt, durationSeconds, promptInfluence }) {
    const cleaned = validatePrompt(prompt);
    const seconds = validateSfxDuration(durationSeconds);
    const sampleRate = 8000;
    const numSamples = Math.floor(sampleRate * seconds);
    const hash = crypto.createHash('sha256').update('sfx|' + cleaned).digest();
    const seed = hash[0] * 256 + hash[1];
    // LCG for deterministic pseudo-random noise
    let s = seed || 1;
    const rand = () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return (s / 0x7fffffff) * 2 - 1;
    };
    const amplitude = 4000;
    const samples = new Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;
      // Sharp attack, exponential decay — feels like a one-shot SFX
      const envelope = Math.exp(-3 * t / seconds);
      samples[i] = Math.round(amplitude * envelope * rand());
    }
    return {
      bytes: buildWav(samples, sampleRate),
      mime: 'audio/wav',
      durationMs: Math.round(seconds * 1000),
      providerMeta: {
        provider: 'mock',
        kind: 'sfx',
        prompt: cleaned,
        durationSeconds: seconds,
        promptInfluence: promptInfluence != null ? Number(promptInfluence) : null,
        sampleRate,
      },
    };
  }

  // Mock voice list — returns a small handful of fake voices so smoke
  // tests can exercise the route without hitting a real provider.
  async listVoices() {
    return {
      voices: [
        { voiceId: 'mock-voice-1', name: 'Alex (mock)',  category: 'premade', isOwned: true,  description: 'Neutral male, mock' },
        { voiceId: 'mock-voice-2', name: 'Brielle (mock)', category: 'premade', isOwned: true,  description: 'Warm female, mock' },
        { voiceId: 'mock-voice-3', name: 'Kai (mock)',  category: 'cloned',  isOwned: true,  description: 'Cloned, mock' },
      ],
      defaultVoice: 'mock-voice-1',
    };
  }

  // Music mock — three sine waves stacked into a triad chord, modulated
  // by a slow LFO. Sounds vaguely musical, definitely not speech, and is
  // deterministic per prompt.
  async generateMusic({ prompt, musicLengthMs }) {
    const cleaned = validatePrompt(prompt);
    const lengthMs = validateMusicLength(musicLengthMs);
    const sampleRate = 8000;
    const numSamples = Math.floor(sampleRate * lengthMs / 1000);
    const hash = crypto.createHash('sha256').update('music|' + cleaned).digest();
    // Pick a root note in the 110-220 Hz range (A2 to A3) from the hash
    const root = 110 + (hash[0] % 110);
    // Major triad: root, +4 semitones, +7 semitones
    const f1 = root;
    const f2 = root * Math.pow(2, 4 / 12);
    const f3 = root * Math.pow(2, 7 / 12);
    const amplitude = 2000; // keep headroom — three voices summed
    const samples = new Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;
      const lfo = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.5 * t); // 0.5 Hz tremolo
      const v =
        Math.sin(2 * Math.PI * f1 * t) +
        Math.sin(2 * Math.PI * f2 * t) +
        Math.sin(2 * Math.PI * f3 * t);
      samples[i] = Math.round(amplitude * lfo * v);
    }
    return {
      bytes: buildWav(samples, sampleRate),
      mime: 'audio/wav',
      durationMs: lengthMs,
      providerMeta: {
        provider: 'mock',
        kind: 'music',
        prompt: cleaned,
        musicLengthMs: lengthMs,
        rootHz: root,
        sampleRate,
      },
    };
  }
}

// ── ElevenLabs provider ───────────────────────────────────────────────

const ELEVENLABS_DEFAULT_MODELS = new Set([
  'eleven_multilingual_v2',
  'eleven_turbo_v2_5',
  'eleven_turbo_v2',
  'eleven_monolingual_v1',
  'eleven_multilingual_v1',
  'eleven_flash_v2_5',
  'eleven_flash_v2',
]);
const DEFAULT_ELEVENLABS_MODEL = 'eleven_turbo_v2_5';
// Rachel is their canonical default voice; agents that want a different
// voice should pass voice_id explicitly.
const DEFAULT_ELEVENLABS_VOICE = '21m00Tcm4TlvDq8ikWAM';

class ElevenLabsTtsProvider extends TtsProvider {
  constructor(config = {}) {
    super(config);
    this.apiKey = config.apiKey || process.env.ELEVENLABS_KEY;
    this.baseUrl = config.baseUrl || 'https://api.elevenlabs.io';
    this.timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.defaultVoice = config.defaultVoice || process.env.ELEVENLABS_DEFAULT_VOICE || DEFAULT_ELEVENLABS_VOICE;
    // Cache of /v1/voices output, populated lazily. ~5min TTL.
    this._voicesCache = null;
    this._voicesCacheAt = 0;
    this._voicesCacheTtlMs = 5 * 60 * 1000;
    // Resolved owned voice for fallback when the configured default is
    // library-locked on the user's plan. Sticky for the process lifetime
    // so we don't re-discover it on every request after the first miss.
    this._fallbackVoice = null;
    if (!this.apiKey) {
      throw new Error('ElevenLabsTtsProvider requires ELEVENLABS_KEY env var or apiKey in config');
    }
  }

  get name() { return 'elevenlabs'; }

  // GET /v1/voices — returns the user's accessible voices.
  // ElevenLabs response shape: { voices: [{ voice_id, name, category, ... }] }
  // We normalize to { voiceId, name, category, isOwned, description }.
  // `isOwned` is true for voices the user can use on their current plan
  // (custom uploads, generated voices, voices they've added from the
  // library). Premade voices marked otherwise are library-locked.
  async listVoices() {
    const now = Date.now();
    if (this._voicesCache && now - this._voicesCacheAt < this._voicesCacheTtlMs) {
      return this._voicesCache;
    }

    const url = `${this.baseUrl}/v1/voices`;
    const response = await this._withTimeout(
      fetch(url, { method: 'GET', headers: { 'xi-api-key': this.apiKey } }),
      'elevenlabs GET /v1/voices'
    );
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const code = response.status >= 500 ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_REJECTED';
      throw new TtsError(code,
        `elevenlabs GET /v1/voices returned ${response.status}: ${text.slice(0, 300)}`);
    }
    let json;
    try { json = await response.json(); }
    catch (e) { throw new TtsError('PROVIDER_MALFORMED', `elevenlabs /v1/voices returned non-JSON: ${e.message}`); }

    const voices = (json.voices || []).map(v => ({
      voiceId: v.voice_id,
      name: v.name,
      category: v.category || 'unknown',     // 'premade' | 'cloned' | 'generated' | 'professional'
      // ElevenLabs sets `is_owner: true` for voices the user can actually
      // call on their current plan — custom uploads, voice clones, AND
      // premade voices the user has explicitly added to their account
      // from the voice library. Free-tier accounts that haven't added
      // any voice get is_owner=false on every voice, which means we
      // can't auto-fall-back; the helpful error in `generate()` points
      // them at the dashboard.
      isOwned: v.is_owner === true,
      description: v.description || '',
    }));

    const result = {
      voices,
      defaultVoice: this.defaultVoice,
    };
    this._voicesCache = result;
    this._voicesCacheAt = now;
    return result;
  }

  // Best-effort: pick a voice the user can actually use, prioritizing
  // anything they own. Used by the auto-fallback path when ElevenLabs
  // returns 402 / paid_plan_required for the default voice.
  async _pickFallbackVoice() {
    if (this._fallbackVoice) return this._fallbackVoice;
    const list = await this.listVoices().catch(() => null);
    if (!list || list.voices.length === 0) return null;
    const owned = list.voices.find(v => v.isOwned);
    const picked = owned || list.voices[0];
    this._fallbackVoice = picked.voiceId;
    return picked.voiceId;
  }

  // Single TTS call — used by both the main entrypoint AND the
  // auto-fallback retry. Returns the parsed result OR throws TtsError.
  async _ttsCall({ text, voiceId, modelId, stability, similarityBoost, style, speakerBoost }) {
    const body = {
      text,
      model_id: modelId,
      voice_settings: {
        stability: stability != null ? Number(stability) : 0.5,
        similarity_boost: similarityBoost != null ? Number(similarityBoost) : 0.75,
      },
    };
    if (style != null) body.voice_settings.style = Number(style);
    if (speakerBoost != null) body.voice_settings.use_speaker_boost = !!speakerBoost;

    const url = `${this.baseUrl}/v1/text-to-speech/${encodeURIComponent(voiceId)}`;
    const response = await this._withTimeout(
      fetch(url, {
        method: 'POST',
        headers: {
          'xi-api-key': this.apiKey,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg',
        },
        body: JSON.stringify(body),
      }),
      `elevenlabs POST ${voiceId}`
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const code = response.status >= 500 ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_REJECTED';
      // Detect the specific "library voice on free plan" error so the
      // caller can decide whether to fall back to a different voice.
      const isLibraryLocked = response.status === 402 || /paid_plan_required|library voices/i.test(text);
      // ElevenLabs free tier flags accounts as 'detected_unusual_activity'
      // after any sequence of suspicious-looking API calls (often the
      // first failed attempt is enough). Surface a specific message so
      // users know it's an account-state issue, not a code bug.
      const isUnusualActivity = response.status === 401 && /detected_unusual_activity|unusual activity/i.test(text);
      let message;
      if (isUnusualActivity) {
        message =
          `ElevenLabs flagged this account with 'detected_unusual_activity' (HTTP 401). ` +
          `This commonly happens to free accounts after a bad request. Log into ` +
          `https://elevenlabs.io/app/usage to clear the flag (you may need to verify ` +
          `email/phone), or upgrade to the Starter plan ($5/mo) which removes both this ` +
          `restriction AND the library-voice paywall. Original body: ${text.slice(0, 200)}`;
      } else {
        message = `elevenlabs returned ${response.status}: ${text.slice(0, 500)}`;
      }
      const err = new TtsError(code, message,
        { providerMeta: { status: response.status, body: text.slice(0, 500) } });
      err.libraryLocked = isLibraryLocked;
      err.unusualActivity = isUnusualActivity;
      throw err;
    }

    const arrayBuffer = await response.arrayBuffer();
    const bytes = Buffer.from(arrayBuffer);
    const mime = response.headers.get('content-type') || 'audio/mpeg';
    return { bytes, mime };
  }

  async generate({ text, voice, model, stability, similarityBoost, style, speakerBoost }) {
    const cleaned = validateText(text);
    const requestedVoice = voice || this.defaultVoice;
    if (!/^[A-Za-z0-9]{10,32}$/.test(requestedVoice)) {
      throw new TtsError('BAD_VOICE', `voice must be an ElevenLabs voice id (got '${requestedVoice}')`);
    }
    const modelId = model || DEFAULT_ELEVENLABS_MODEL;
    if (!ELEVENLABS_DEFAULT_MODELS.has(modelId)) {
      throw new TtsError('BAD_MODEL',
        `Unknown ElevenLabs model '${modelId}'. Known: ${[...ELEVENLABS_DEFAULT_MODELS].join(', ')}`);
    }

    let usedVoice = requestedVoice;
    let fellBack = false;
    let result;

    try {
      result = await this._ttsCall({
        text: cleaned, voiceId: requestedVoice, modelId,
        stability, similarityBoost, style, speakerBoost,
      });
    } catch (err) {
      // If the FAILURE was a library-voice-paid-plan rejection AND the
      // caller didn't explicitly pin a voice, try to fall back to one
      // the user actually owns. This avoids "first call always 402" for
      // free-tier users on day one. If the caller pinned a voice they
      // own and it still fails, no fallback — that's a real config error.
      if (err.libraryLocked && !voice) {
        const fb = await this._pickFallbackVoice();
        if (fb && fb !== requestedVoice) {
          console.warn(`[tts] elevenlabs default voice ${requestedVoice} is library-locked, falling back to ${fb}`);
          try {
            result = await this._ttsCall({
              text: cleaned, voiceId: fb, modelId,
              stability, similarityBoost, style, speakerBoost,
            });
            usedVoice = fb;
            fellBack = true;
          } catch (retryErr) {
            // The fallback also failed — surface a helpful error pointing
            // the user at the dashboard where they can add a voice.
            throw new TtsError('PROVIDER_REJECTED',
              `ElevenLabs rejected the default voice (library-locked on your plan) AND ` +
              `the auto-selected fallback '${fb}'. Add a voice to your account at ` +
              `https://elevenlabs.io/app/voice-library or upgrade your plan, then retry. ` +
              `Original error: ${retryErr.message}`);
          }
        } else {
          throw new TtsError('PROVIDER_REJECTED',
            `ElevenLabs rejected voice '${requestedVoice}' (library-locked on your plan) ` +
            `and no owned voices were found in your account. Add a voice at ` +
            `https://elevenlabs.io/app/voice-library or upgrade your plan, then retry.`);
        }
      } else {
        throw err;
      }
    }

    // ElevenLabs doesn't return duration in headers. Heuristic from text length.
    const durationMs = Math.round(cleaned.length * 60);

    return {
      bytes: result.bytes,
      mime: result.mime,
      durationMs,
      providerMeta: {
        provider: 'elevenlabs',
        kind: 'speech',
        model: modelId,
        voice: usedVoice,
        requestedVoice,
        fellBack,
        text: cleaned,
        byteSize: result.bytes.length,
        characterCost: cleaned.length,
      },
    };
  }

  // POST /v1/sound-generation
  // Body: { text, duration_seconds?, prompt_influence? }
  // Returns audio/mpeg.
  async generateSoundEffect({ prompt, durationSeconds, promptInfluence }) {
    const cleaned = validatePrompt(prompt);
    const seconds = validateSfxDuration(durationSeconds);

    const body = {
      text: cleaned,
      duration_seconds: seconds,
    };
    if (promptInfluence != null) {
      const pi = Number(promptInfluence);
      if (!Number.isFinite(pi) || pi < 0 || pi > 1) {
        throw new TtsError('BAD_PROMPT', 'promptInfluence must be a number between 0 and 1');
      }
      body.prompt_influence = pi;
    }

    const url = `${this.baseUrl}/v1/sound-generation`;
    const response = await this._withTimeout(
      fetch(url, {
        method: 'POST',
        headers: {
          'xi-api-key': this.apiKey,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg',
        },
        body: JSON.stringify(body),
      }),
      'elevenlabs POST sound-generation'
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const code = response.status >= 500 ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_REJECTED';
      throw new TtsError(code,
        `elevenlabs sound-generation returned ${response.status}: ${text.slice(0, 500)}`,
        { providerMeta: { status: response.status, body: text.slice(0, 500) } });
    }

    const arrayBuffer = await response.arrayBuffer();
    const bytes = Buffer.from(arrayBuffer);
    const mime = response.headers.get('content-type') || 'audio/mpeg';

    return {
      bytes,
      mime,
      durationMs: Math.round(seconds * 1000),
      providerMeta: {
        provider: 'elevenlabs',
        kind: 'sfx',
        prompt: cleaned,
        durationSeconds: seconds,
        promptInfluence: body.prompt_influence ?? null,
        byteSize: bytes.length,
      },
    };
  }

  // POST /v1/music
  // Body: {
  //   prompt: string (≤4100 chars),
  //   music_length_ms?: int (3000-600000),
  //   model_id?: 'music_v1',
  //   force_instrumental?: bool,
  // }
  // Returns audio/mpeg. The 'song-id' response header carries an ID we
  // log into providerMeta for later inpainting if the user enables it.
  async generateMusic({ prompt, musicLengthMs, modelId, forceInstrumental }) {
    const cleaned = validatePrompt(prompt);
    const lengthMs = validateMusicLength(musicLengthMs);

    const body = {
      prompt: cleaned,
      music_length_ms: lengthMs,
    };
    if (modelId) body.model_id = modelId;
    if (forceInstrumental != null) body.force_instrumental = !!forceInstrumental;

    const url = `${this.baseUrl}/v1/music`;
    const response = await this._withTimeout(
      fetch(url, {
        method: 'POST',
        headers: {
          'xi-api-key': this.apiKey,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg',
        },
        body: JSON.stringify(body),
      }),
      'elevenlabs POST music'
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const code = response.status >= 500 ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_REJECTED';
      throw new TtsError(code,
        `elevenlabs /v1/music returned ${response.status}: ${text.slice(0, 500)}`,
        { providerMeta: { status: response.status, body: text.slice(0, 500) } });
    }

    const arrayBuffer = await response.arrayBuffer();
    const bytes = Buffer.from(arrayBuffer);
    const mime = response.headers.get('content-type') || 'audio/mpeg';
    const songId = response.headers.get('song-id') || null;

    return {
      bytes,
      mime,
      durationMs: lengthMs,
      providerMeta: {
        provider: 'elevenlabs',
        kind: 'music',
        prompt: cleaned,
        musicLengthMs: lengthMs,
        modelId: body.model_id || 'music_v1',
        forceInstrumental: body.force_instrumental ?? false,
        songId,
        byteSize: bytes.length,
      },
    };
  }

  async _withTimeout(fetchPromise, label) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const result = await Promise.race([
        fetchPromise,
        new Promise((_, reject) => {
          controller.signal.addEventListener('abort', () => {
            reject(new TtsError('PROVIDER_UNAVAILABLE', `${label} timed out after ${this.timeoutMs}ms`));
          });
        }),
      ]);
      return result;
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new TtsError('PROVIDER_UNAVAILABLE', `${label} aborted: ${err.message}`);
      }
      if (err instanceof TtsError) throw err;
      throw new TtsError('PROVIDER_UNAVAILABLE', `${label} failed: ${err.message}`, { cause: err });
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── factory ───────────────────────────────────────────────────────────

function createProvider() {
  if (process.env.ELEVENLABS_KEY) {
    return new ElevenLabsTtsProvider();
  }
  return new MockTtsProvider();
}

let _provider = null;
function getProvider() {
  if (!_provider) _provider = createProvider();
  return _provider;
}
function resetProvider() { _provider = null; }

async function generateSpeech(opts) {
  const provider = getProvider();
  try {
    return await provider.generate(opts);
  } catch (err) {
    if (!(err instanceof TtsError) || err.code !== 'PROVIDER_UNAVAILABLE') {
      throw err;
    }
    console.warn(`[tts] ${provider.name} transient failure, retrying once: ${err.message}`);
    return await provider.generate(opts);
  }
}

async function generateSoundEffect(opts) {
  const provider = getProvider();
  try {
    return await provider.generateSoundEffect(opts);
  } catch (err) {
    if (!(err instanceof TtsError) || err.code !== 'PROVIDER_UNAVAILABLE') {
      throw err;
    }
    console.warn(`[tts] ${provider.name} sfx transient failure, retrying once: ${err.message}`);
    return await provider.generateSoundEffect(opts);
  }
}

async function generateMusic(opts) {
  const provider = getProvider();
  try {
    return await provider.generateMusic(opts);
  } catch (err) {
    if (!(err instanceof TtsError) || err.code !== 'PROVIDER_UNAVAILABLE') {
      throw err;
    }
    console.warn(`[tts] ${provider.name} music transient failure, retrying once: ${err.message}`);
    return await provider.generateMusic(opts);
  }
}

async function listVoices() {
  const provider = getProvider();
  return await provider.listVoices();
}

module.exports = {
  TtsProvider,
  TtsError,
  MockTtsProvider,
  ElevenLabsTtsProvider,
  createProvider,
  getProvider,
  resetProvider,
  generateSpeech,
  generateSoundEffect,
  generateMusic,
  listVoices,
  validateText,
  validatePrompt,
  validateSfxDuration,
  validateMusicLength,
  MIN_TEXT_LEN,
  MAX_TEXT_LEN,
  MIN_PROMPT_LEN,
  MAX_PROMPT_LEN,
  MIN_SFX_DURATION_S,
  MAX_SFX_DURATION_S,
  MIN_MUSIC_LENGTH_MS,
  MAX_MUSIC_LENGTH_MS,
};
