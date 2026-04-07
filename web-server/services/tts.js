/**
 * tts.js — provider-agnostic text-to-speech
 *
 * Same shape as image-gen.js:
 *   - `generate(opts)` dispatches to the active provider
 *   - Mock adapter produces a valid audio file (deterministic silent WAV)
 *   - ElevenLabs adapter is the real one, selected when ELEVENLABS_KEY is set
 *   - All providers return { bytes, mime, providerMeta, durationMs }
 *
 * Errors are mapped to the same structured codes as image-gen:
 *   BAD_TEXT, BAD_VOICE, BAD_MODEL
 *   PROVIDER_UNAVAILABLE   — network / 5xx / timeout
 *   PROVIDER_REJECTED      — content moderation / 4xx from provider
 *   PROVIDER_MALFORMED     — provider returned a response we can't parse
 *
 * Adding a new TTS provider (OpenAI TTS, Deepgram, PlayHT, etc.):
 *   1. Subclass TtsProvider
 *   2. Implement async generate({ text, voice, model, ... })
 *   3. Register in createProvider()
 *   4. Document env vars in NOTES.local.md
 */

const crypto = require('crypto');

const DEFAULT_TIMEOUT_MS = 45_000;
const MIN_TEXT_LEN = 1;
const MAX_TEXT_LEN = 5000;

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

// ── base class ────────────────────────────────────────────────────────

class TtsProvider {
  constructor(config = {}) { this.config = config; }
  get name() { return 'abstract'; }
  get isMock() { return false; }
  async generate(opts) {
    throw new TtsError('NOT_IMPLEMENTED', 'abstract TtsProvider.generate');
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
        model,
        voice,
        text: cleaned,
        sampleRate,
        frequency: freq,
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
    if (!this.apiKey) {
      throw new Error('ElevenLabsTtsProvider requires ELEVENLABS_KEY env var or apiKey in config');
    }
  }

  get name() { return 'elevenlabs'; }

  async generate({ text, voice, model, stability, similarityBoost, style, speakerBoost }) {
    const cleaned = validateText(text);
    const voiceId = voice || this.defaultVoice;
    if (!/^[A-Za-z0-9]{10,32}$/.test(voiceId)) {
      throw new TtsError('BAD_VOICE', `voice must be an ElevenLabs voice id (got '${voiceId}')`);
    }
    const modelId = model || DEFAULT_ELEVENLABS_MODEL;
    if (!ELEVENLABS_DEFAULT_MODELS.has(modelId)) {
      throw new TtsError('BAD_MODEL',
        `Unknown ElevenLabs model '${modelId}'. Known: ${[...ELEVENLABS_DEFAULT_MODELS].join(', ')}`);
    }

    const body = {
      text: cleaned,
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
      throw new TtsError(code,
        `elevenlabs returned ${response.status}: ${text.slice(0, 500)}`,
        { providerMeta: { status: response.status, body: text.slice(0, 500) } });
    }

    const arrayBuffer = await response.arrayBuffer();
    const bytes = Buffer.from(arrayBuffer);
    const mime = response.headers.get('content-type') || 'audio/mpeg';

    // ElevenLabs doesn't return duration in headers. We could decode
    // the mp3 to find it but that's more complexity than it's worth for
    // v1 — agents can compute it client-side from the audio itself if
    // they need exact timing. For the durationMs field we return a
    // heuristic based on text length (matches the mock behaviour).
    const durationMs = Math.round(cleaned.length * 60);

    return {
      bytes,
      mime,
      durationMs,
      providerMeta: {
        provider: 'elevenlabs',
        model: modelId,
        voice: voiceId,
        text: cleaned,
        byteSize: bytes.length,
        characterCost: cleaned.length,
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

module.exports = {
  TtsProvider,
  TtsError,
  MockTtsProvider,
  ElevenLabsTtsProvider,
  createProvider,
  getProvider,
  resetProvider,
  generateSpeech,
  validateText,
  MIN_TEXT_LEN,
  MAX_TEXT_LEN,
};
