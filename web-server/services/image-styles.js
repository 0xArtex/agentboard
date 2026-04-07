/**
 * image-styles.js — named style presets for AI image generation
 *
 * Loads config/image-styles.json at module import and exposes a resolver
 * that turns a style name into:
 *   { systemPrompt, references[], preferredModel, negativePrompt }
 *
 * References are loaded from disk and returned as { path, dataUri } so
 * the caller can pass them directly to providers that accept either a
 * filesystem path, a data URI, or upload-first flows.
 *
 * Hot-reload via fs.watch, matching the pattern of services/pricing.js.
 * The config file is human-editable, so an operator can add a new style
 * on a running server without a restart:
 *   1. Edit web-server/config/image-styles.json
 *   2. (optional) drop new reference images in web-server/assets/reference-images/
 *   3. Next request with the new style name picks it up
 */

const path = require('path');
const fs = require('fs');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'image-styles.json');
const WEB_SERVER_ROOT = path.join(__dirname, '..');

let _cache = null;
let _watching = false;
let _resolvedCache = new Map(); // style name → resolved object with byte-loaded references

// ── loading ──────────────────────────────────────────────────────────

function loadRawConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      console.warn('[image-styles] config file is not an object, ignoring');
      return {};
    }
    return parsed;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[image-styles] failed to load ${CONFIG_PATH}: ${err.message}`);
    }
    return {};
  }
}

function startWatcher() {
  if (_watching) return;
  _watching = true;
  try {
    fs.watch(path.dirname(CONFIG_PATH), (_event, filename) => {
      if (filename && filename === path.basename(CONFIG_PATH)) {
        _cache = loadRawConfig();
        _resolvedCache.clear();
        console.log('[image-styles] config reloaded');
      }
    });
  } catch (err) {
    console.warn(`[image-styles] fs.watch failed, hot-reload disabled: ${err.message}`);
  }
}

function ensureLoaded() {
  if (_cache === null) {
    _cache = loadRawConfig();
    startWatcher();
  }
  return _cache;
}

function reloadStyles() {
  _cache = loadRawConfig();
  _resolvedCache.clear();
  return _cache;
}

// ── resolution ───────────────────────────────────────────────────────

/**
 * List every style name known to the config. Meta keys ($schema,
 * $description) are filtered out.
 */
function listStyles() {
  const cfg = ensureLoaded();
  return Object.keys(cfg)
    .filter(k => !k.startsWith('$'))
    .map(name => ({
      name,
      title: (cfg[name] && cfg[name].name) || name,
      description: (cfg[name] && cfg[name].description) || '',
      preferredModel: (cfg[name] && cfg[name].preferredModel) || null,
      hasReferences: !!(cfg[name] && Array.isArray(cfg[name].references) && cfg[name].references.length),
    }));
}

function hasStyle(name) {
  if (!name || typeof name !== 'string') return false;
  if (name.startsWith('$')) return false;
  return !!(ensureLoaded()[name]);
}

/**
 * Resolve a style name to a usable object with the reference images
 * loaded into memory as Buffers + data URIs. Throws with a structured
 * error code if the style doesn't exist or a reference file is missing.
 *
 * Cached per style name so hot reloads are cheap.
 */
function resolveStyle(name) {
  if (!name || typeof name !== 'string') {
    throw Object.assign(new Error('resolveStyle: name required'), { code: 'BAD_STYLE' });
  }
  if (name.startsWith('$')) {
    throw Object.assign(new Error(`resolveStyle: '${name}' is not a style`), { code: 'BAD_STYLE' });
  }

  if (_resolvedCache.has(name)) return _resolvedCache.get(name);

  const cfg = ensureLoaded();
  const preset = cfg[name];
  if (!preset) {
    const known = Object.keys(cfg).filter(k => !k.startsWith('$'));
    throw Object.assign(
      new Error(`Unknown style '${name}'. Known: ${known.join(', ')}`),
      { code: 'BAD_STYLE' }
    );
  }

  // Load reference images from disk
  const references = [];
  for (const relPath of (preset.references || [])) {
    const absPath = path.isAbsolute(relPath) ? relPath : path.join(WEB_SERVER_ROOT, relPath);
    if (!fs.existsSync(absPath)) {
      throw Object.assign(
        new Error(`Style '${name}' references missing file: ${relPath}`),
        { code: 'BAD_STYLE_REFERENCE', path: absPath }
      );
    }
    const bytes = fs.readFileSync(absPath);
    // Infer mime from extension
    const ext = path.extname(absPath).toLowerCase();
    const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
               : ext === '.webp' ? 'image/webp'
               : ext === '.gif' ? 'image/gif'
               : 'image/png';
    references.push({
      path: absPath,
      relPath,
      bytes,
      mime,
      dataUri: `data:${mime};base64,${bytes.toString('base64')}`,
      sizeBytes: bytes.length,
    });
  }

  const resolved = {
    name,
    title: preset.name || name,
    description: preset.description || '',
    systemPrompt: preset.systemPrompt || '',
    negativePrompt: preset.negativePrompt || '',
    references,
    preferredModel: preset.preferredModel || null,
  };
  _resolvedCache.set(name, resolved);
  return resolved;
}

/**
 * Combine a style preset with a user prompt. Returns the final prompt
 * that goes to the model — system prompt first, then user prompt.
 *
 * We front-load the style so the model's attention is primed by the
 * aesthetic guidance before it sees the scene content. Based on
 * empirical testing with Flux Kontext, this ordering produces more
 * consistent results than appending the style to the end.
 */
function composePrompt(resolvedStyle, userPrompt) {
  if (!resolvedStyle) return userPrompt;
  const sys = (resolvedStyle.systemPrompt || '').trim();
  const user = (userPrompt || '').trim();
  if (!sys) return user;
  if (!user) return sys;
  return `${sys}. ${user}`;
}

module.exports = {
  listStyles,
  hasStyle,
  resolveStyle,
  composePrompt,
  reloadStyles,
  CONFIG_PATH,
};
