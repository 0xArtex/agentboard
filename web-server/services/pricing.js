/**
 * pricing.js — reloadable x402 pricing config
 *
 * Route handlers don't hardcode prices — they ask this module what to
 * charge for a given capability by name ('generate-image', 'generate-speech',
 * etc). Prices live in web-server/config/x402-pricing.json and can be
 * changed without redeploying:
 *
 *   1. Edit config/x402-pricing.json
 *   2. fs.watch() picks up the change within ~100ms
 *   3. Next request to the gated route picks up the new price
 *
 * Defaults:
 *   - If the file is missing or unreadable, falls back to hardcoded
 *     DEFAULT_PRICES so the server still boots.
 *   - If a specific capability is missing from the file, falls back to
 *     the default for that capability.
 *   - Env var overrides (X402_PRICE_<CAPABILITY>) always win over the
 *     file — useful for deploy-time tuning without committing config.
 *
 * Price format: atomic USDC units (10^6 per dollar). "250000" = $0.25.
 * Strings rather than numbers so we never lose precision on large
 * values.
 */

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'x402-pricing.json');

// Fallback defaults — used when the config file is missing AND no env
// var override is set. These match the values the route handlers used
// before this config layer existed.
const DEFAULT_PRICES = {
  'generate-image':  { priceAtomic: '250000', description: 'AI image generation' },
  'generate-speech': { priceAtomic: '100000', description: 'AI text-to-speech' },
  'export-pdf':      { priceAtomic: '0',      description: 'Storyboard PDF export' },
};

let _cache = null;
let _watching = false;

function loadFromDisk() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      console.warn('[pricing] config file is not an object, using defaults');
      return null;
    }
    return parsed;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[pricing] failed to load ${CONFIG_PATH}: ${err.message}`);
    }
    return null;
  }
}

function ensureCache() {
  if (_cache !== null) return _cache;
  _cache = loadFromDisk() || {};
  startWatcher();
  return _cache;
}

function startWatcher() {
  if (_watching) return;
  _watching = true;
  try {
    fs.watch(path.dirname(CONFIG_PATH), (_event, filename) => {
      if (filename && filename === path.basename(CONFIG_PATH)) {
        const next = loadFromDisk();
        if (next) {
          _cache = next;
          console.log('[pricing] config reloaded');
        }
      }
    });
  } catch (err) {
    // fs.watch is best-effort — if it fails (e.g. the config dir doesn't
    // exist), we just won't hot-reload. Explicit reloadPricing() still
    // works.
    console.warn(`[pricing] fs.watch failed, hot-reload disabled: ${err.message}`);
  }
}

/**
 * Force a reload from disk. Used by tests and by the deploy process after
 * a config push.
 */
function reloadPricing() {
  _cache = loadFromDisk() || {};
  return _cache;
}

/**
 * Get the pricing entry for a capability name. Resolution order:
 *   1. X402_PRICE_<CAPABILITY> env var (uppercase, dashes → underscores)
 *   2. config file
 *   3. DEFAULT_PRICES
 *
 * Returns { priceAtomic, description } or null if the capability is
 * completely unknown.
 */
function getPrice(capability) {
  const envKey = 'X402_PRICE_' + capability.toUpperCase().replace(/-/g, '_');
  const envOverride = process.env[envKey];
  if (envOverride) {
    return {
      priceAtomic: String(envOverride),
      description: (ensureCache()[capability] || DEFAULT_PRICES[capability] || {}).description || capability,
      source: 'env',
    };
  }
  const cached = ensureCache()[capability];
  if (cached && cached.priceAtomic != null) {
    return {
      priceAtomic: String(cached.priceAtomic),
      description: cached.description || capability,
      source: 'file',
    };
  }
  const def = DEFAULT_PRICES[capability];
  if (def) {
    return {
      priceAtomic: def.priceAtomic,
      description: def.description,
      source: 'default',
    };
  }
  return null;
}

/**
 * List every capability we know about, with its current effective price.
 * Used by an admin route + smoke tests.
 */
function listPrices() {
  const known = new Set([
    ...Object.keys(DEFAULT_PRICES),
    ...Object.keys(ensureCache()),
  ]);
  const out = {};
  for (const name of known) {
    out[name] = getPrice(name);
  }
  return out;
}

module.exports = {
  getPrice,
  listPrices,
  reloadPricing,
  CONFIG_PATH,
  DEFAULT_PRICES,
};
