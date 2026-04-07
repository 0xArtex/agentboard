/**
 * Ephemeral smoke test for the agent drawing engine.
 *
 * Covers:
 *   - draw-engine direct: every brush type produces a non-empty PNG
 *   - every shape type renders without throwing
 *   - dimensions match the requested aspect ratio
 *   - overlay mode actually composites on top of an existing layer
 *     (verified by drawing on a colored base and checking that the
 *      base color is still present where strokes don't cover)
 *   - replace mode starts from a blank/transparent canvas
 *   - validation: bad coords / bad brush / out-of-bounds / oversized arrays
 *     all rejected with BAD_DRAW
 *   - routes end-to-end:
 *       create project → draw shapes → asset persisted with correct meta
 *       draw strokes → asset persisted
 *       overlay mode hits the existing-layer load path
 *       BAD_DRAW errors return 400 with the right code
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const Database = require('better-sqlite3');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-draw-'));
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

delete process.env.X402_ENABLED;
delete process.env.AGENT_AUTH_ENABLED;
delete process.env.FAL_KEY;
delete process.env.ELEVENLABS_KEY;

let fail = false;
function check(label, cond, extra) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (!cond) fail = true;
  console.log(`${mark}  ${label}${extra ? '  ' + extra : ''}`);
}

function isPng(buf) {
  return Buffer.isBuffer(buf)
    && buf.length > 100
    && buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a';
}

// Decode the IHDR chunk of a PNG to get its width × height. Used to
// verify the engine produces the right canvas dimensions for an aspect.
function pngDimensions(buf) {
  // PNG header is 8 bytes, then IHDR chunk: 4-byte length, 4-byte type,
  // 4-byte width, 4-byte height. So width is at offset 16, height at 20.
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function buildApp() {
  const modulesToReset = [
    '../services/draw-engine',
    '../services/x402',
    '../middleware/x402-gate',
    '../middleware/agent-auth',
    '../routes/agent',
  ];
  for (const m of modulesToReset) delete require.cache[require.resolve(m)];
  const express = require('express');
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use(require('../middleware/agent-auth').agentAuthMiddleware);
  app.use('/api/agent', require('../routes/agent'));
  app.locals.socketHandler = { broadcast: () => {} };
  return app;
}

let server, port;
function startServer() {
  return new Promise((resolve) => {
    server = http.createServer(buildApp());
    server.listen(0, () => { port = server.address().port; resolve(); });
  });
}
function stopServer() { return new Promise((r) => { server.close(r); }); }

function req(method, reqPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'localhost', port, path: reqPath, method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    const r = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch (_) {}
        resolve({ status: res.statusCode, body: json, raw: buf });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  try {
    // ── 1. Direct draw-engine tests ──
    const eng = require('../services/draw-engine');

    // Dimension correctness for different aspect ratios
    check('1a. dims 16:9 → 1920x1080',
      JSON.stringify(eng.dimensionsForAspect(1.7777)) === JSON.stringify({ width: 1920, height: 1080 }));
    check('1a. dims 9:16 → 1080x1920',
      JSON.stringify(eng.dimensionsForAspect(0.5625)) === JSON.stringify({ width: 1080, height: 1920 }));
    check('1a. dims 1:1 → 1920x1920',
      JSON.stringify(eng.dimensionsForAspect(1.0)) === JSON.stringify({ width: 1920, height: 1920 }));

    // Bad aspect ratio
    try {
      eng.dimensionsForAspect(-1);
      check('1b. negative aspect rejected', false);
    } catch (e) {
      check('1b. negative aspect → BAD_DRAW', e.code === 'BAD_DRAW');
    }

    // ── 2. Every brush produces a valid PNG ──
    for (const brush of ['pencil', 'pen', 'ink', 'marker', 'eraser']) {
      const png = await eng.renderStrokes({
        aspectRatio: 1.7777,
        strokes: [{ brush, points: [[0.1, 0.5], [0.5, 0.4], [0.9, 0.5]], size: 6 }],
      });
      check(`2. brush ${brush} → valid PNG`, isPng(png));
      const dims = pngDimensions(png);
      check(`2. brush ${brush} → 1920x1080`, dims.width === 1920 && dims.height === 1080);
    }

    // ── 3. Every shape type renders ──
    const allShapes = [
      { type: 'line',     from: [0.1, 0.1], to: [0.9, 0.9], stroke: '#000', strokeWidth: 4 },
      { type: 'circle',   center: [0.5, 0.5], radius: 0.15, stroke: '#cc0000', strokeWidth: 6 },
      { type: 'rect',     topLeft: [0.2, 0.2], size: [0.6, 0.4], stroke: '#000', strokeWidth: 4 },
      { type: 'arrow',    from: [0.1, 0.9], to: [0.9, 0.1], stroke: '#0066cc', strokeWidth: 6 },
      { type: 'text',     position: [0.5, 0.05], text: 'TEST', fontSize: 0.06, fill: '#000', align: 'center' },
      { type: 'polyline', points: [[0.1,0.5],[0.3,0.4],[0.5,0.5],[0.7,0.6],[0.9,0.5]], stroke: '#000', strokeWidth: 5 },
      { type: 'polygon',  points: [[0.4,0.3],[0.6,0.3],[0.55,0.5],[0.45,0.5]], stroke: '#000', fill: '#ffaa00' },
      { type: 'bezier',   from: [0.1,0.5], cp1: [0.3,0.1], cp2: [0.7,0.9], to: [0.9,0.5], stroke: '#aa00aa', strokeWidth: 5 },
    ];
    for (const shape of allShapes) {
      const png = await eng.renderShapes({ aspectRatio: 1.7777, shapes: [shape] });
      check(`3. shape ${shape.type} → valid PNG`, isPng(png));
    }

    // All shapes together in one render
    const composite = await eng.renderShapes({ aspectRatio: 1.7777, shapes: allShapes });
    check('3z. all 8 shapes composite → valid PNG', isPng(composite));

    // ── 4. Validation rejects garbage ──
    const badCases = [
      { strokes: [{ brush: 'pencil', points: [[1.5, 0.5]] }], label: '4a. x>1 → BAD_DRAW' },
      { strokes: [{ brush: 'pencil', points: [[0.5, -0.1]] }], label: '4b. y<0 → BAD_DRAW' },
      { strokes: [{ brush: 'unknown', points: [[0.5, 0.5]] }], label: '4c. bad brush → BAD_DRAW' },
      { strokes: [{ brush: 'pencil', points: [] }], label: '4d. empty points → BAD_DRAW' },
      { strokes: [], label: '4e. empty strokes array → BAD_DRAW' },
      { strokes: [{ brush: 'pencil', points: [[0.5, 0.5]], size: 500 }], label: '4f. oversized brush → BAD_DRAW' },
      { strokes: [{ brush: 'pencil', points: [[0.5, 0.5]], opacity: 2 }], label: '4g. opacity>1 → BAD_DRAW' },
    ];
    for (const tc of badCases) {
      let threw = false;
      try {
        await eng.renderStrokes({ aspectRatio: 1.7777, strokes: tc.strokes });
      } catch (e) {
        threw = e instanceof eng.DrawError && e.code === 'BAD_DRAW';
      }
      check(tc.label, threw);
    }

    // Bad shape
    try {
      await eng.renderShapes({ aspectRatio: 1.7777, shapes: [{ type: 'donut', center: [0.5, 0.5] }] });
      check('4h. unknown shape type → BAD_DRAW', false);
    } catch (e) {
      check('4h. unknown shape type → BAD_DRAW', e instanceof eng.DrawError && e.code === 'BAD_DRAW');
    }

    // ── 5. Overlay mode actually composites ──
    // Create a base image: solid red 1920x1080, then overlay a blue stroke.
    // Verify the result has both red AND blue pixels (indicating compositing).
    const { createCanvas } = require('@napi-rs/canvas');
    const baseCanvas = createCanvas(1920, 1080);
    const baseCtx = baseCanvas.getContext('2d');
    baseCtx.fillStyle = '#ff0000';
    baseCtx.fillRect(0, 0, 1920, 1080);
    const basePng = baseCanvas.toBuffer('image/png');

    const overlaid = await eng.renderShapes({
      aspectRatio: 1.7777,
      mode: 'overlay',
      baseImage: basePng,
      shapes: [{ type: 'circle', center: [0.5, 0.5], radius: 0.1, fill: '#0000ff' }],
    });
    check('5a. overlay → valid PNG', isPng(overlaid));

    // Decode the result and check pixels at known locations
    const resultImg = await require('@napi-rs/canvas').loadImage(overlaid);
    const probe = createCanvas(1920, 1080);
    const probeCtx = probe.getContext('2d');
    probeCtx.drawImage(resultImg, 0, 0);
    // Top-left corner should still be red (background showing through)
    const cornerPixel = probeCtx.getImageData(50, 50, 1, 1).data;
    check('5b. overlay preserves base outside drawn region (red corner)',
      cornerPixel[0] > 200 && cornerPixel[1] < 50 && cornerPixel[2] < 50);
    // Center should be blue (the new circle)
    const centerPixel = probeCtx.getImageData(960, 540, 1, 1).data;
    check('5c. overlay places new shape in center (blue)',
      centerPixel[0] < 50 && centerPixel[1] < 50 && centerPixel[2] > 200);

    // Replace mode on the same shape — center is blue, corner is transparent
    const replaced = await eng.renderShapes({
      aspectRatio: 1.7777,
      mode: 'replace',
      shapes: [{ type: 'circle', center: [0.5, 0.5], radius: 0.1, fill: '#0000ff' }],
    });
    const replacedImg = await require('@napi-rs/canvas').loadImage(replaced);
    probeCtx.clearRect(0, 0, 1920, 1080);
    probeCtx.drawImage(replacedImg, 0, 0);
    const corner2 = probeCtx.getImageData(50, 50, 1, 1).data;
    check('5d. replace mode → corner is transparent', corner2[3] === 0);

    // Eraser strokes in overlay mode actually remove pixels
    const erased = await eng.renderStrokes({
      aspectRatio: 1.7777,
      mode: 'overlay',
      baseImage: basePng,
      strokes: [{ brush: 'eraser', size: 100, points: [[0.5, 0.5]] }],
    });
    const erasedImg = await require('@napi-rs/canvas').loadImage(erased);
    probeCtx.clearRect(0, 0, 1920, 1080);
    probeCtx.drawImage(erasedImg, 0, 0);
    const erasedCenter = probeCtx.getImageData(960, 540, 1, 1).data;
    check('5e. eraser overlay → center pixel is transparent', erasedCenter[3] === 0);

    // ── 6. Routes end-to-end ──
    await startServer();

    let r = await req('POST', '/api/agent/create-project', {
      title: 'Draw Test',
      aspectRatio: 1.7777,
      boards: [{ dialogue: 'a panel to draw on' }],
    });
    check('6a. create project 201', r.status === 201);
    const project = r.body;
    const projectId = project.id;
    const boardUid = project.project.boards[0].uid;

    // draw-shapes happy path
    r = await req('POST', '/api/agent/draw-shapes', {
      projectId, boardUid,
      shapes: [
        { type: 'rect', topLeft: [0.05, 0.05], size: [0.9, 0.9], stroke: '#000', strokeWidth: 6 },
        { type: 'circle', center: [0.5, 0.5], radius: 0.15, stroke: '#cc0000', strokeWidth: 6 },
        { type: 'text', position: [0.5, 0.05], text: 'WIDE SHOT', fontSize: 0.05, fill: '#000', align: 'center' },
      ],
    });
    check('6b. draw-shapes 201', r.status === 201);
    check('6b. response.kind = layer:fill', r.body && r.body.kind === 'layer:fill');
    check('6b. response.shapeCount = 3', r.body && r.body.shapeCount === 3);
    check('6b. hash is 64 hex', r.body && typeof r.body.hash === 'string' && r.body.hash.length === 64);

    // Asset persisted with meta
    let assetRow = db.prepare(
      "SELECT meta FROM board_assets WHERE board_uid = ? AND kind = 'layer:fill'"
    ).get(boardUid);
    check('6c. layer:fill row in db', assetRow != null);
    let meta = assetRow ? JSON.parse(assetRow.meta) : null;
    check('6c. meta.source = draw-shapes', meta && meta.source === 'draw-shapes');
    check('6c. meta.shapeCount = 3', meta && meta.shapeCount === 3);
    check('6c. meta.mode = replace', meta && meta.mode === 'replace');

    // draw-strokes happy path on a different layer
    r = await req('POST', '/api/agent/draw-strokes', {
      projectId, boardUid,
      layer: 'pencil',
      strokes: [
        { brush: 'pencil', color: '#222', size: 5, points: [[0.1, 0.5], [0.3, 0.4], [0.5, 0.5], [0.7, 0.6], [0.9, 0.5]] },
        { brush: 'ink',    color: '#000', size: 8, points: [[0.2, 0.7], [0.5, 0.7], [0.8, 0.7]] },
      ],
    });
    check('6d. draw-strokes 201', r.status === 201);
    check('6d. response.kind = layer:pencil', r.body && r.body.kind === 'layer:pencil');
    check('6d. response.strokeCount = 2', r.body && r.body.strokeCount === 2);

    assetRow = db.prepare(
      "SELECT meta FROM board_assets WHERE board_uid = ? AND kind = 'layer:pencil'"
    ).get(boardUid);
    check('6e. layer:pencil row in db', assetRow != null);
    meta = assetRow ? JSON.parse(assetRow.meta) : null;
    check('6e. meta.source = draw-strokes', meta && meta.source === 'draw-strokes');

    // Overlay mode on existing fill layer (we just drew shapes there)
    r = await req('POST', '/api/agent/draw-shapes', {
      projectId, boardUid,
      mode: 'overlay',
      shapes: [
        { type: 'arrow', from: [0.2, 0.8], to: [0.8, 0.2], stroke: '#00aa00', strokeWidth: 8 },
      ],
    });
    check('6f. overlay draw-shapes 201', r.status === 201);
    check('6f. response.mode = overlay', r.body && r.body.mode === 'overlay');

    // The fill layer should now have BOTH the original shapes AND the arrow.
    // Just check that the row was updated (new hash) and meta says overlay.
    assetRow = db.prepare(
      "SELECT meta FROM board_assets WHERE board_uid = ? AND kind = 'layer:fill'"
    ).get(boardUid);
    meta = assetRow ? JSON.parse(assetRow.meta) : null;
    check('6f. asset meta updated to overlay mode', meta && meta.mode === 'overlay');

    // ── 7. Route validation errors ──
    r = await req('POST', '/api/agent/draw-shapes', {
      projectId, boardUid,
      shapes: [{ type: 'circle', center: [1.5, 0.5], radius: 0.1 }],
    });
    check('7a. out-of-bounds coord → 400', r.status === 400);
    check('7a. error code = BAD_DRAW', r.body && r.body.error && r.body.error.code === 'BAD_DRAW');

    r = await req('POST', '/api/agent/draw-shapes', {
      projectId, boardUid,
      shapes: [{ type: 'donut', center: [0.5, 0.5] }],
    });
    check('7b. unknown shape type → 400', r.status === 400);
    check('7b. error code = BAD_DRAW', r.body && r.body.error && r.body.error.code === 'BAD_DRAW');

    r = await req('POST', '/api/agent/draw-shapes', { projectId, shapes: [] });
    check('7c. missing boardUid → 400', r.status === 400);

    r = await req('POST', '/api/agent/draw-shapes', { projectId, boardUid, shapes: [] });
    check('7d. empty shapes array → 400', r.status === 400);

    r = await req('POST', '/api/agent/draw-strokes', {
      projectId, boardUid,
      strokes: [{ brush: 'unknown-brush', points: [[0.5, 0.5]] }],
    });
    check('7e. unknown brush → 400 BAD_DRAW',
      r.status === 400 && r.body && r.body.error && r.body.error.code === 'BAD_DRAW');

    r = await req('POST', '/api/agent/draw-shapes', {
      projectId, boardUid,
      mode: 'invalid',
      shapes: [{ type: 'line', from: [0, 0], to: [1, 1] }],
    });
    check('7f. invalid mode → 400', r.status === 400);

    await stopServer();
  } catch (e) {
    console.error('EXCEPTION:', e);
    fail = true;
    if (server) await stopServer().catch(() => {});
  } finally {
    console.log();
    console.log(fail ? 'FAILED' : 'OK — all checks passed');
    process.exit(fail ? 1 : 0);
  }
})();
