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
const imageStyles = require('./image-styles');

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

  async generate({ prompt, aspectRatio = 1.7777, model, seed, references = [] }) {
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
        referenceCount: references.length,
      },
    };
  }
}

// ── fal.ai provider ───────────────────────────────────────────────────

// Map our canonical model names to fal.ai endpoints. Callers use the short
// form; we look up the real path here so changing endpoints doesn't leak
// into route code. Update paths here if fal.ai rearranges their URL scheme
// — nothing else in the system needs to know.
const FAL_MODEL_PATHS = {
  // ── classic Flux family (text-only) ──
  'flux-schnell':    'fal-ai/flux/schnell',
  'flux-dev':        'fal-ai/flux/dev',
  'flux-pro':        'fal-ai/flux-pro',
  'flux-pro-v1.1':   'fal-ai/flux-pro/v1.1',
  'flux-pro-ultra':  'fal-ai/flux-pro/v1.1-ultra',

  // ── Flux Kontext family (reference-image guided) ──
  // Use these when the agent passes reference images via `style:` presets
  // with a non-empty references[] array. Kontext models accept image_url
  // (single) or image_urls (multi) in the request body and steer the
  // output to match the reference aesthetic.
  'flux-kontext':       'fal-ai/flux-pro/kontext',
  'flux-kontext-max':   'fal-ai/flux-pro/kontext/max',
  'flux-kontext-multi': 'fal-ai/flux-pro/kontext/multi',

  // ── Flux 2 Pro (latest generation flagship) ──
  // Slug confirmed against fal.ai docs: fal-ai/flux-2-pro (no sub-path).
  'flux-2-pro':      'fal-ai/flux-2-pro',

  // ── non-Flux alternatives ──
  'sdxl':            'fal-ai/fast-sdxl',
  'stable-diffusion-3.5': 'fal-ai/stable-diffusion-v35-large',

  // Z-Image Turbo — cheap, fast draft-quality text-to-image. The "low"
  // quality tier. Lightweight, no reference image support, no inference
  // step tuning. Standard fal sync body shape (prompt, image_size, seed,
  // negative_prompt, num_images).
  'z-image-turbo':   'fal-ai/z-image/turbo',

  // Seedream 5.0 Lite (ByteDance) — top quality tier. Slower and more
  // expensive than flux-2-pro, used for final-render quality. The path
  // includes an explicit /text-to-image suffix that other fal models
  // don't — verified from fal's official docs page for seedream v5 lite.
  // Accepts { prompt } at minimum; other body fields are model-specific
  // and we pass the standard ones (image_size, seed, negative_prompt)
  // which fal ignores gracefully if unsupported.
  'seedream-v5-lite': 'fal-ai/bytedance/seedream/v5/lite/text-to-image',
};
// flux-2-pro is the flagship text-to-image model: highest quality,
// prompt adherence, and typography. It's the right default for a
// storyboard tool where the human will actually look at every frame.
// Callers who want cheaper/faster can still pass model:"flux-schnell"
// explicitly. Style presets override this via `preferredModel`.
const DEFAULT_FAL_MODEL = 'flux-2-pro';

// ── quality tier → model resolution ───────────────────────────────────
//
// Project-level quality setting lets callers pick a tier without having
// to know specific model names. Three tiers:
//
//   low    — draft-speed, cheapest. Used for quick iteration, thumbnails,
//            when the agent is still exploring composition.
//   medium — balanced (default). Good quality, reasonable cost.
//   high   — flagship render. Used for final panels.
//
// Resolution priority inside generateImage():
//   1. explicit opts.model (takes precedence over everything)
//   2. style preset's preferredModel (if a style was passed)
//   3. explicit opts.quality (per-call override)
//   4. project.meta.quality (set when the storyboard was created)
//   5. DEFAULT_FAL_MODEL (flux-2-pro)
//
const QUALITY_TO_MODEL = {
  low:    'z-image-turbo',
  medium: 'flux-2-pro',
  high:   'seedream-v5-lite',
};

/**
 * Turn a quality tier string into a model key. Returns null if the
 * quality value is absent or unrecognized so the caller can fall through
 * to the next resolution rule.
 */
function modelForQuality(quality) {
  if (!quality) return null;
  return QUALITY_TO_MODEL[String(quality).toLowerCase()] || null;
}

// Models that accept reference images via image_url / image_urls in the
// request body. When the caller passes references but picks a model NOT
// in this set, we auto-promote to flux-kontext-multi so references don't
// get silently dropped.
const FAL_MODELS_WITH_REFERENCES = new Set([
  'flux-kontext',
  'flux-kontext-max',
  'flux-kontext-multi',
]);

// Of those, which accept MULTIPLE references via image_urls (array).
// Single-reference models use image_url (scalar).
const FAL_MODELS_WITH_MULTI_REFERENCES = new Set([
  'flux-kontext-multi',
]);

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

  async generate({ prompt, aspectRatio = 1.7777, model, seed, negativePrompt, steps, references = [] }) {
    const cleaned = validatePrompt(prompt);
    let modelKey = model || DEFAULT_FAL_MODEL;

    // If the caller provided references but chose a model that doesn't
    // support them, auto-promote to flux-kontext-multi so the references
    // actually take effect. We log the promotion so this is visible in
    // server logs but don't error — it's a user-friendly fix, not a bug.
    if (references.length > 0 && !FAL_MODELS_WITH_REFERENCES.has(modelKey)) {
      console.log(
        `[fal-ai] model '${modelKey}' doesn't accept references — ` +
        `auto-promoting to 'flux-kontext-multi' (${references.length} refs)`
      );
      modelKey = 'flux-kontext-multi';
    }
    // Single-reference kontext model with multiple refs → promote to multi.
    if (references.length > 1 && modelKey === 'flux-kontext') {
      modelKey = 'flux-kontext-multi';
    }
    // Zero refs on the multi-reference model → fall back to a text-only model.
    if (references.length === 0 && FAL_MODELS_WITH_REFERENCES.has(modelKey)) {
      // Keep the caller's intent if they explicitly picked kontext — just
      // call it without references. fal.ai's kontext accepts empty image_urls.
    }

    const modelPath = FAL_MODEL_PATHS[modelKey];
    if (!modelPath) {
      throw new ImageGenError('BAD_MODEL',
        `Unknown model '${modelKey}'. Known: ${Object.keys(FAL_MODEL_PATHS).join(', ')}`);
    }

    const body = {
      prompt: cleaned,
      num_images: 1,
      // Always set image_size — without it, kontext models default to the
      // reference image's shape, which produces wrong-aspect-ratio outputs
      // when the bundled refs and the target board don't match (and weird
      // composite layouts when multiple refs of different shapes are sent).
      // The route always supplies aspectRatio (falling back to the project's
      // own aspectRatio), so this is reliably available.
      image_size: falImageSize(aspectRatio),
    };
    if (seed != null) body.seed = Number(seed);
    if (negativePrompt) body.negative_prompt = String(negativePrompt);
    if (steps != null) body.num_inference_steps = Number(steps);

    // Attach reference images if provided. Kontext-multi accepts an array;
    // single-reference kontext accepts a scalar. Each reference can be a
    // data URI string OR an { dataUri } object from image-styles.resolveStyle.
    if (references.length > 0) {
      const refUrls = references.map(r => typeof r === 'string' ? r : r.dataUri);
      if (FAL_MODELS_WITH_MULTI_REFERENCES.has(modelKey)) {
        body.image_urls = refUrls;
      } else {
        body.image_url = refUrls[0];
      }
    }

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

    // Most fal models return { images: [{ url, width, height, content_type }] }
    // but a few newer ones (e.g. seedream v5 lite) return { image: { url } }
    // or just { url }. Accept all three shapes so adding a new model
    // doesn't require a special-case parser.
    let image = null;
    if (json && Array.isArray(json.images) && json.images[0]) {
      image = json.images[0];
    } else if (json && json.image && typeof json.image.url === 'string') {
      image = json.image;
    } else if (json && typeof json.url === 'string') {
      image = { url: json.url };
    }
    if (!image || typeof image.url !== 'string') {
      throw new ImageGenError('PROVIDER_MALFORMED',
        `fal.ai ${modelPath} response missing image url (keys: ${json ? Object.keys(json).join(',') : 'none'})`,
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
        model: modelKey,           // may have been promoted if references forced a kontext model
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
        referenceCount: references.length,
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
 * High-level entrypoint. Handles style preset resolution, quality-tier
 * resolution, then dispatches to the active provider with a single retry
 * on PROVIDER_UNAVAILABLE.
 *
 * Resolution order for the final model (first match wins):
 *   1. opts.model                    — explicit model override
 *   2. style.preferredModel          — set via `opts.style` preset
 *   3. modelForQuality(opts.quality) — per-call quality tier override
 *   4. modelForQuality(opts.projectQuality) — project-level default
 *   5. DEFAULT_FAL_MODEL             — hardcoded fallback (flux-2-pro)
 *
 * opts.style — name of a style preset from config/image-styles.json.
 * opts.quality — 'low' | 'medium' | 'high' per-call override.
 * opts.projectQuality — 'low' | 'medium' | 'high' the project's setting.
 */
async function generateImage(opts) {
  let finalOpts = { ...opts };
  let resolvedQualityTier = null;

  if (opts.style) {
    let style;
    try {
      style = imageStyles.resolveStyle(opts.style);
    } catch (err) {
      // Re-throw as ImageGenError so the route handler maps it to 400
      throw new ImageGenError(
        err.code || 'BAD_STYLE',
        err.message,
        { cause: err }
      );
    }
    finalOpts.prompt = imageStyles.composePrompt(style, opts.prompt);
    // Only override model if the caller didn't pin one explicitly.
    if (!opts.model && style.preferredModel) {
      finalOpts.model = style.preferredModel;
    }
    // Merge negative prompts: user > style
    if (!opts.negativePrompt && style.negativePrompt) {
      finalOpts.negativePrompt = style.negativePrompt;
    }
    // Pass reference images through — the fal provider picks the right
    // body shape (image_url vs image_urls) based on the model.
    finalOpts.references = style.references;
    finalOpts._resolvedStyle = {
      name: style.name,
      title: style.title,
      referenceCount: style.references.length,
    };
  }

  // Quality tier resolution — only applies if we still don't have a model
  // pinned from opts.model or style.preferredModel. The per-call override
  // wins over the project-level setting.
  if (!finalOpts.model) {
    const tier = opts.quality || opts.projectQuality;
    const qModel = modelForQuality(tier);
    if (qModel) {
      finalOpts.model = qModel;
      resolvedQualityTier = String(tier).toLowerCase();
    }
  }

  const provider = getProvider();
  try {
    const result = await provider.generate(finalOpts);
    // Surface the resolved style in providerMeta so the caller can see
    // which preset (if any) was applied.
    if (finalOpts._resolvedStyle && result.providerMeta) {
      result.providerMeta.style = finalOpts._resolvedStyle;
    }
    // Surface the resolved quality tier (if any) so agents can confirm
    // which tier actually picked the model. Null when nothing set the
    // model through a quality tier (either it was pinned directly, or
    // the fallback DEFAULT_FAL_MODEL was used).
    if (resolvedQualityTier && result.providerMeta) {
      result.providerMeta.quality = resolvedQualityTier;
    }
    return result;
  } catch (err) {
    if (!(err instanceof ImageGenError) || err.code !== 'PROVIDER_UNAVAILABLE') {
      throw err;
    }
    // One retry on transient failures
    console.warn(`[image-gen] ${provider.name} transient failure, retrying once: ${err.message}`);
    return await provider.generate(finalOpts);
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
  modelForQuality,
  MIN_PROMPT_LEN,
  MAX_PROMPT_LEN,
  // Re-export so routes don't need to require both modules
  styles: imageStyles,
  FAL_MODEL_PATHS,
  FAL_MODELS_WITH_REFERENCES,
  QUALITY_TO_MODEL,
  DEFAULT_FAL_MODEL,
};
