/**
 * image-gen.js — provider-agnostic AI image generation
 *
 * Exposes a single `generate(opts)` function that dispatches to whichever
 * provider is currently configured. The adapter pattern lets us swap
 * providers without touching the route handler.
 *
 * Current providers:
 *   - MockImageGenProvider  (default when FAL_KEY is unset)
 *       Returns a deterministic solid-color PNG keyed by the prompt hash.
 *       Used for local dev, unit tests, and demos where no provider
 *       credentials are available. Produces a real, valid PNG that the
 *       downstream storage pipeline, viewer, and PDF exporter can all
 *       consume unchanged — so end-to-end tests cover the real code path
 *       without external calls.
 *
 *   - FalAiImageGenProvider (when FAL_KEY is set)
 *       Calls https://fal.run/fal-ai/{model} with the prompt and options,
 *       downloads the resulting image, returns its bytes. Default model
 *       is flux/schnell (fastest + cheapest). Supports content-type
 *       detection, timeout, and single retry on transient failures.
 *
 * Adding a new provider (Replicate, OpenAI Images, Ideogram, etc.):
 *   1. Subclass ImageGenProvider
 *   2. Implement async generate({ prompt, aspectRatio, model, seed, ... })
 *      returning { bytes: Buffer, mime: string, providerMeta: object }
 *   3. Register it in createProvider()
 *   4. Document the required env vars in NOTES.local.md
 *
 * Errors from providers are mapped to structured error codes:
 *   PROVIDER_UNAVAILABLE   — network / 5xx / timeout
 *   PROVIDER_REJECTED      — content moderation / 4xx from provider
 *   PROVIDER_MALFORMED     — provider returned a response we can't parse
 * Callers use these to decide whether to retry, refund, or surface to
 * the user.
 */

const crypto = require('crypto');
const { coloredPng, dimensionsForAspect } = require('./blank-png');

// Hard timeout for any provider call. Agents care about latency; if a
// provider can't respond in 45s we return PROVIDER_UNAVAILABLE and let
// the agent decide whether to retry.
const DEFAULT_TIMEOUT_MS = 45_000;

// Prompt validation limits
const MIN_PROMPT_LEN = 2;
const MAX_PROMPT_LEN = 2000;

class ImageGenError extends Error {
  constructor(code, message, { cause, providerMeta } = {}) {
    super(message);
    this.name = 'ImageGenError';
    this.code = code;
    if (cause) this.cause = cause;
    if (providerMeta) this.providerMeta = providerMeta;
  }
}

function validatePrompt(prompt) {
  if (typeof prompt !== 'string') {
    throw new ImageGenError('BAD_PROMPT', 'prompt must be a string');
  }
  const trimmed = prompt.trim();
  if (trimmed.length < MIN_PROMPT_LEN) {
    throw new ImageGenError('BAD_PROMPT', `prompt must be at least ${MIN_PROMPT_LEN} characters`);
  }
  if (trimmed.length > MAX_PROMPT_LEN) {
    throw new ImageGenError('BAD_PROMPT', `prompt must be under ${MAX_PROMPT_LEN} characters`);
  }
  return trimmed;
}

// ── base class ────────────────────────────────────────────────────────

class ImageGenProvider {
  constructor(config = {}) {
    this.config = config;
  }

  get name() { return 'abstract'; }
  get isMock() { return false; }

  /**
   * Subclasses implement this. Must return:
   *   { bytes: Buffer, mime: string, providerMeta: object }
   *
   * Should throw ImageGenError with a structured code on failure.
   */
  async generate(opts) {
    throw new ImageGenError('NOT_IMPLEMENTED', 'abstract ImageGenProvider.generate');
  }
}

// ── mock provider ─────────────────────────────────────────────────────

class MockImageGenProvider extends ImageGenProvider {
  get name() { return 'mock'; }
  get isMock() { return true; }

  async generate({ prompt, aspectRatio = 1.7777, model, seed }) {
    const cleaned = validatePrompt(prompt);
    // Validate model against the same set fal.ai knows about, so mock
    // mode has production-parity error behaviour. This lets tests cover
    // BAD_MODEL rejection without needing a real provider key.
    const modelKey = model || DEFAULT_FAL_MODEL;
    if (modelKey !== 'mock-v1' && !FAL_MODEL_PATHS[modelKey]) {
      throw new ImageGenError('BAD_MODEL',
        `Unknown model '${modelKey}'. Known: mock-v1, ${Object.keys(FAL_MODEL_PATHS).join(', ')}`);
    }
    // Deterministic: derive a color from the prompt hash so the same
    // prompt always generates the same "image," and different prompts
    // look different. Useful for eyeballing test outputs in the viewer.
    const hash = crypto.createHash('sha256').update(cleaned).digest();
    const r = hash[0];
    const g = hash[1];
    const b = hash[2];

    // Smaller than real output so tests are fast. The viewer scales images
    // to fit the canvas anyway, so native dimensions don't matter much.
    const { width, height } = dimensionsForAspect(aspectRatio);
    // Shrink by 4x for mock to keep test bytes small
    const w = Math.max(4, Math.floor(width / 4));
    const h = Math.max(4, Math.floor(height / 4));
    const bytes = coloredPng(w, h, r, g, b);

    return {
      bytes,
      mime: 'image/png',
      providerMeta: {
        provider: 'mock',
        model: modelKey,
        seed: seed || null,
        prompt: cleaned,
        dimensions: { width: w, height: h },
        color: { r, g, b },
      },
    };
  }
}

// ── fal.ai provider ───────────────────────────────────────────────────

// Map our canonical model names to fal.ai endpoints. Callers use the short
// form; we look up the real path here so changing endpoints doesn't leak
// into route code.
const FAL_MODEL_PATHS = {
  'flux-schnell':    'fal-ai/flux/schnell',
  'flux-dev':        'fal-ai/flux/dev',
  'flux-pro':        'fal-ai/flux-pro',
  'flux-pro-v1.1':   'fal-ai/flux-pro/v1.1',
  'sdxl':            'fal-ai/fast-sdxl',
  'stable-diffusion-3.5': 'fal-ai/stable-diffusion-v35-large',
};
const DEFAULT_FAL_MODEL = 'flux-schnell';

// Map aspect ratio to fal.ai's image_size vocabulary. fal uses named
// presets for common ratios and accepts { width, height } for custom.
function falImageSize(aspectRatio) {
  const ar = Number(aspectRatio) || 1.7777;
  if (Math.abs(ar - 16 / 9) < 0.05) return 'landscape_16_9';
  if (Math.abs(ar - 9 / 16) < 0.05) return 'portrait_16_9';
  if (Math.abs(ar - 4 / 3) < 0.05) return 'landscape_4_3';
  if (Math.abs(ar - 1) < 0.05) return 'square';
  // Fall back to explicit dimensions
  const { width, height } = dimensionsForAspect(ar);
  return { width, height };
}

class FalAiImageGenProvider extends ImageGenProvider {
  constructor(config = {}) {
    super(config);
    this.apiKey = config.apiKey || process.env.FAL_KEY;
    this.baseUrl = config.baseUrl || 'https://fal.run';
    this.timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
    if (!this.apiKey) {
      throw new Error('FalAiImageGenProvider requires FAL_KEY env var or apiKey in config');
    }
  }

  get name() { return 'fal-ai'; }

  async generate({ prompt, aspectRatio = 1.7777, model, seed, negativePrompt, steps }) {
    const cleaned = validatePrompt(prompt);
    const modelKey = model || DEFAULT_FAL_MODEL;
    const modelPath = FAL_MODEL_PATHS[modelKey];
    if (!modelPath) {
      throw new ImageGenError('BAD_MODEL',
        `Unknown model '${modelKey}'. Known: ${Object.keys(FAL_MODEL_PATHS).join(', ')}`);
    }

    const body = {
      prompt: cleaned,
      image_size: falImageSize(aspectRatio),
      num_images: 1,
    };
    if (seed != null) body.seed = Number(seed);
    if (negativePrompt) body.negative_prompt = String(negativePrompt);
    if (steps != null) body.num_inference_steps = Number(steps);

    // Submit generation request
    const url = `${this.baseUrl}/${modelPath}`;
    const response = await this._withTimeout(
      fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Key ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }),
      `fal.ai POST ${modelPath}`
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      // 4xx → content moderation / bad input; 5xx → provider unavailable
      const code = response.status >= 500 ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_REJECTED';
      throw new ImageGenError(code,
        `fal.ai ${modelPath} returned ${response.status}: ${text.slice(0, 500)}`,
        { providerMeta: { status: response.status, body: text.slice(0, 500) } });
    }

    let json;
    try {
      json = await response.json();
    } catch (err) {
      throw new ImageGenError('PROVIDER_MALFORMED', 'fal.ai returned non-JSON response', { cause: err });
    }

    const image = json && Array.isArray(json.images) && json.images[0];
    if (!image || typeof image.url !== 'string') {
      throw new ImageGenError('PROVIDER_MALFORMED',
        'fal.ai response missing images[0].url',
        { providerMeta: json });
    }

    // Download the actual image bytes. fal.ai returns public CDN URLs
    // that don't need auth — we just fetch them directly.
    const imgRes = await this._withTimeout(fetch(image.url), `fal.ai download ${image.url}`);
    if (!imgRes.ok) {
      throw new ImageGenError('PROVIDER_UNAVAILABLE',
        `fal.ai image download returned ${imgRes.status}`);
    }
    const arrayBuffer = await imgRes.arrayBuffer();
    const bytes = Buffer.from(arrayBuffer);
    const mime = image.content_type || imgRes.headers.get('content-type') || 'image/png';

    return {
      bytes,
      mime,
      providerMeta: {
        provider: 'fal-ai',
        model: modelKey,
        modelPath,
        seed: json.seed || seed || null,
        prompt: cleaned,
        negativePrompt: negativePrompt || null,
        sourceUrl: image.url,
        dimensions: image.width && image.height
          ? { width: image.width, height: image.height }
          : null,
        hasNsfw: json.has_nsfw_concepts || null,
        timingsMs: json.timings || null,
      },
    };
  }

  async _withTimeout(fetchPromise, label) {
    // fetch() already accepts AbortSignal.timeout() in Node 18+, but we
    // roll our own so the error includes our label for debugging.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // If fetchPromise isn't actually a promise (or was called without
      // signal), wrap it in a Promise.race with our own timeout. Modern
      // fetch in Node doesn't take the signal here because we constructed
      // it above — but we handle timeouts via the setTimeout anyway.
      const result = await Promise.race([
        fetchPromise,
        new Promise((_, reject) => {
          controller.signal.addEventListener('abort', () => {
            reject(new ImageGenError('PROVIDER_UNAVAILABLE', `${label} timed out after ${this.timeoutMs}ms`));
          });
        }),
      ]);
      return result;
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new ImageGenError('PROVIDER_UNAVAILABLE', `${label} aborted: ${err.message}`);
      }
      if (err instanceof ImageGenError) throw err;
      throw new ImageGenError('PROVIDER_UNAVAILABLE', `${label} failed: ${err.message}`, { cause: err });
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── factory ───────────────────────────────────────────────────────────

function createProvider() {
  if (process.env.FAL_KEY) {
    return new FalAiImageGenProvider();
  }
  return new MockImageGenProvider();
}

// Lazy singleton so the provider is picked up at first call time, not
// module load time (lets tests flip env vars between runs).
let _provider = null;
function getProvider() {
  if (!_provider) _provider = createProvider();
  return _provider;
}
function resetProvider() { _provider = null; }

/**
 * High-level entrypoint. Single try + single retry on PROVIDER_UNAVAILABLE,
 * because transient 5xx / network blips shouldn't cost the agent a fresh
 * x402 payment.
 */
async function generateImage(opts) {
  const provider = getProvider();
  try {
    return await provider.generate(opts);
  } catch (err) {
    if (!(err instanceof ImageGenError) || err.code !== 'PROVIDER_UNAVAILABLE') {
      throw err;
    }
    // One retry on transient failures
    console.warn(`[image-gen] ${provider.name} transient failure, retrying once: ${err.message}`);
    return await provider.generate(opts);
  }
}

module.exports = {
  ImageGenProvider,
  ImageGenError,
  MockImageGenProvider,
  FalAiImageGenProvider,
  createProvider,
  getProvider,
  resetProvider,
  generateImage,
  validatePrompt,
  MIN_PROMPT_LEN,
  MAX_PROMPT_LEN,
};
