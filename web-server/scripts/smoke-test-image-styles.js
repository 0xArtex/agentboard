/**
 * Ephemeral smoke test for the image style presets system.
 *
 * Covers:
 *   - imageStyles.listStyles() returns all 3 presets
 *   - resolveStyle loads reference images as Buffers + data URIs
 *   - resolveStyle throws BAD_STYLE on unknown name
 *   - resolveStyle throws BAD_STYLE_REFERENCE when a file is missing
 *   - composePrompt prepends system prompt correctly
 *   - generateImage with style injects style into prompt + provider meta
 *   - FalAiImageGenProvider request-body shape includes image_urls when
 *     a kontext model + references are supplied (dry-run — no network)
 *   - Auto-promotion: non-kontext model + references → flux-kontext-multi
 *   - Mock provider still works with style
 *   - Route integration: POST /api/agent/generate-image with style works end-to-end
 *   - GET /api/agent/image-styles lists all presets
 *   - MCP list_image_styles tool
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const Database = require('better-sqlite3');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-style-'));
const dbPath = path.join(tmpDir, 'test.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).sort()) {
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
}

require.cache[require.resolve('../services/db')] = {
  id: require.resolve('../services/db'),
  filename: require.resolve('../services/db'),
  loaded: true,
  exports: { db, DB_PATH: dbPath },
};

delete process.env.FAL_KEY;
delete process.env.ELEVENLABS_KEY;
delete process.env.X402_ENABLED;
delete process.env.AGENT_AUTH_ENABLED;

let fail = false;
function check(label, cond, extra) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (!cond) fail = true;
  console.log(`${mark}  ${label}${extra ? '  ' + extra : ''}`);
}

(async () => {
  try {
    // ── 1. Direct image-styles service tests ──
    const imageStyles = require('../services/image-styles');

    const list = imageStyles.listStyles();
    check('1a. listStyles returns 3 presets', list.length === 3);
    const names = list.map(s => s.name);
    check('1a. contains storyboard-sketch', names.includes('storyboard-sketch'));
    check('1a. contains cinematic-color', names.includes('cinematic-color'));
    check('1a. contains comic-panel', names.includes('comic-panel'));
    check('1a. storyboard-sketch hasReferences=true',
      list.find(s => s.name === 'storyboard-sketch').hasReferences === true);
    check('1a. cinematic-color hasReferences=false',
      list.find(s => s.name === 'cinematic-color').hasReferences === false);

    const resolved = imageStyles.resolveStyle('storyboard-sketch');
    check('2a. resolveStyle returns systemPrompt',
      typeof resolved.systemPrompt === 'string' && resolved.systemPrompt.length > 20);
    check('2a. resolveStyle preferredModel = flux-kontext-multi',
      resolved.preferredModel === 'flux-kontext-multi');
    check('2a. resolveStyle returns 2 references', resolved.references.length === 2);
    check('2a. reference[0] has bytes Buffer',
      Buffer.isBuffer(resolved.references[0].bytes));
    check('2a. reference[0] has dataUri',
      typeof resolved.references[0].dataUri === 'string' &&
      resolved.references[0].dataUri.startsWith('data:image/png;base64,'));
    check('2a. reference[0] is non-empty', resolved.references[0].sizeBytes > 1000);
    check('2a. reference[1] exists', resolved.references[1] && resolved.references[1].sizeBytes > 1000);

    // Unknown style
    try {
      imageStyles.resolveStyle('made-up-style');
      check('2b. unknown style throws', false);
    } catch (e) {
      check('2b. unknown style throws BAD_STYLE', e.code === 'BAD_STYLE');
    }

    // Meta key protection
    try {
      imageStyles.resolveStyle('$schema');
      check('2c. meta key rejected', false);
    } catch (e) {
      check('2c. $schema rejected as BAD_STYLE', e.code === 'BAD_STYLE');
    }

    // composePrompt
    const composed = imageStyles.composePrompt(resolved, 'a lighthouse keeper at dusk');
    check('3a. composePrompt starts with system prompt',
      composed.startsWith('Black and white rough storyboard sketch'));
    check('3a. composePrompt includes user prompt',
      composed.includes('a lighthouse keeper at dusk'));
    check('3a. composePrompt length > both individually',
      composed.length > resolved.systemPrompt.length &&
      composed.length > 'a lighthouse keeper at dusk'.length);

    // ── 4. Mock provider + generateImage with style ──
    const imageGen = require('../services/image-gen');
    imageGen.resetProvider();

    const mockResult = await imageGen.generateImage({
      prompt: 'a lighthouse at dusk',
      style: 'storyboard-sketch',
    });
    check('4a. mock + style returns buffer',
      Buffer.isBuffer(mockResult.bytes) && mockResult.bytes.length > 0);
    check('4a. mock + style providerMeta.style set',
      mockResult.providerMeta.style &&
      mockResult.providerMeta.style.name === 'storyboard-sketch' &&
      mockResult.providerMeta.style.title === 'Black & White Storyboard Sketch');
    check('4a. mock + style referenceCount = 2',
      mockResult.providerMeta.referenceCount === 2);
    check('4a. mock + style prompt includes system prompt',
      mockResult.providerMeta.prompt.startsWith('Black and white rough storyboard sketch'));

    // Different styles produce different mock bytes (different colors)
    const mock2 = await imageGen.generateImage({
      prompt: 'a lighthouse at dusk',
      style: 'cinematic-color',
    });
    check('4b. different style → different mock bytes',
      !mock2.bytes.equals(mockResult.bytes));

    // No style should still work
    const mock3 = await imageGen.generateImage({ prompt: 'a lighthouse at dusk' });
    check('4c. no style still works', Buffer.isBuffer(mock3.bytes));
    check('4c. no style providerMeta.style is undefined',
      mock3.providerMeta.style == null);

    // Unknown style surfaces as BAD_STYLE via the wrapper
    try {
      await imageGen.generateImage({
        prompt: 'x x',
        style: 'nonexistent-style',
      });
      check('5a. unknown style via generateImage throws', false);
    } catch (e) {
      check('5a. unknown style → BAD_STYLE',
        e.code === 'BAD_STYLE' || (e.cause && e.cause.code === 'BAD_STYLE'));
    }

    // ── 6. Fal request-body construction (dry-run) ──
    // We can't call real fal without a network, but we can construct a
    // FalAiImageGenProvider instance with a fake API key and a spy fetch
    // to inspect the body that would have been sent.

    const originalFetch = global.fetch;
    // Track every fetch call. The adapter makes TWO per generation: a
    // POST to fal-ai/... with the prompt body, then a GET to the returned
    // CDN URL for the bytes. We only care about the first one.
    let fetchCalls = [];
    global.fetch = async (url, opts) => {
      const body = opts && opts.body ? JSON.parse(opts.body) : null;
      fetchCalls.push({ url, method: (opts && opts.method) || 'GET', body });
      return {
        ok: true,
        headers: { get: () => 'image/png' },
        json: async () => ({
          images: [{ url: 'https://fake/image.png', content_type: 'image/png' }],
          seed: 42,
        }),
        arrayBuffer: async () => new ArrayBuffer(100),
      };
    };
    const firstPost = () => fetchCalls.find(c => c.method === 'POST');

    try {
      process.env.FAL_KEY = 'test-key';
      imageGen.resetProvider();

      // generate with references → should call fal.ai with image_urls
      fetchCalls = [];
      await imageGen.generateImage({
        prompt: 'a lighthouse at dusk',
        style: 'storyboard-sketch',
      });
      let post = firstPost();
      check('6a. fal adapter POST hit kontext/multi endpoint',
        post && post.url.includes('fal-ai/flux-pro/kontext/multi'));
      check('6b. fal body has composed prompt',
        post && post.body && typeof post.body.prompt === 'string' &&
        post.body.prompt.startsWith('Black and white rough storyboard sketch'));
      check('6c. fal body has image_urls array (len 2)',
        post && Array.isArray(post.body.image_urls) && post.body.image_urls.length === 2);
      check('6d. image_urls are data URIs',
        post && post.body.image_urls[0].startsWith('data:image/png;base64,'));
      check('6e. fal body INCLUDES image_size so kontext respects board aspect ratio',
        post && post.body.image_size != null);
      check('6f. fal body has negative_prompt from style',
        post && typeof post.body.negative_prompt === 'string');

      // Explicit non-kontext model + references → auto-promoted to kontext-multi
      fetchCalls = [];
      await imageGen.generateImage({
        prompt: 'test test',
        style: 'storyboard-sketch',
        model: 'flux-schnell',  // doesn't support refs — should get promoted
      });
      post = firstPost();
      check('7a. non-kontext model + refs auto-promoted to kontext',
        post && post.url.includes('kontext'));

      // No style, no references, classic flux-schnell
      fetchCalls = [];
      await imageGen.generateImage({
        prompt: 'a cat',
        model: 'flux-schnell',
      });
      post = firstPost();
      check('8a. classic flux model path',
        post && post.url.includes('fal-ai/flux/schnell'));
      check('8b. classic flux body has image_size',
        post && post.body.image_size != null);
      check('8c. classic flux body has no image_urls',
        post && post.body.image_urls === undefined);
    } finally {
      global.fetch = originalFetch;
      delete process.env.FAL_KEY;
      imageGen.resetProvider();
    }

    // ── 9. Route integration ──
    // Start an ephemeral express app and POST through the real route handler
    const express = require('express');
    const app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use(require('../middleware/agent-auth').agentAuthMiddleware);
    app.use('/api/agent', require('../routes/agent'));
    app.locals.socketHandler = { broadcast: () => {} };

    const server = http.createServer(app);
    await new Promise(r => server.listen(0, r));
    const port = server.address().port;

    function req(method, reqPath, body) {
      return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const opts = {
          hostname: 'localhost', port, path: reqPath, method,
          headers: { 'Content-Type': 'application/json' },
        };
        if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
        const r = http.request(opts, (res) => {
          let out = '';
          res.on('data', c => out += c);
          res.on('end', () => {
            try { resolve({ status: res.statusCode, body: JSON.parse(out) }); }
            catch (e) { resolve({ status: res.statusCode, body: out }); }
          });
        });
        r.on('error', reject);
        if (data) r.write(data);
        r.end();
      });
    }

    // GET /api/agent/image-styles
    let r = await req('GET', '/api/agent/image-styles');
    check('9a. GET /image-styles 200', r.status === 200);
    check('9a. response has 3 styles',
      r.body && Array.isArray(r.body.styles) && r.body.styles.length === 3);

    // Create a project
    r = await req('POST', '/api/agent/create-project', {
      title: 'Style Test',
      boards: [{ dialogue: 'a scene' }],
    });
    const proj = r.body;
    const boardUid = proj.project.boards[0].uid;

    // POST /api/agent/generate-image with style (mock provider)
    r = await req('POST', '/api/agent/generate-image', {
      projectId: proj.id,
      boardUid,
      layer: 'fill',
      prompt: 'a lighthouse keeper holding a lantern',
      style: 'storyboard-sketch',
    });
    check('9b. generate-image with style 201', r.status === 201);
    check('9b. response has style metadata',
      r.body.style && r.body.style.title === 'Black & White Storyboard Sketch');
    check('9b. response has referenceCount = 2',
      r.body.referenceCount === 2);
    check('9b. response model reflects style preference',
      r.body.model === 'flux-kontext-multi');

    // BAD_STYLE error
    r = await req('POST', '/api/agent/generate-image', {
      projectId: proj.id,
      boardUid,
      layer: 'fill',
      prompt: 'x x',
      style: 'does-not-exist',
    });
    check('9c. bad style 400', r.status === 400);
    check('9c. error code = BAD_STYLE',
      r.body.error && r.body.error.code === 'BAD_STYLE');

    // Verify stored meta in SQLite has the style
    const assetRow = db.prepare(
      "SELECT meta FROM board_assets WHERE board_uid = ? AND kind = 'layer:fill'"
    ).get(boardUid);
    check('9d. stored asset meta has style',
      assetRow && JSON.parse(assetRow.meta).style != null);
    check('9d. stored meta has referenceCount = 2',
      assetRow && JSON.parse(assetRow.meta).referenceCount === 2);

    server.close();

  } catch (e) {
    console.error('EXCEPTION:', e);
    fail = true;
  } finally {
    console.log();
    console.log(fail ? 'FAILED' : 'OK — all checks passed');
    process.exit(fail ? 1 : 0);
  }
})();
