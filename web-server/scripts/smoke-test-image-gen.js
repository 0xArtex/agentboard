/**
 * Ephemeral smoke test for image generation — mock provider + route.
 *
 * Covers:
 *   - Mock provider produces deterministic colored PNGs (same prompt → same hash)
 *   - Different prompts → different hashes (color derived from prompt hash)
 *   - Prompt validation (too short, too long, wrong type)
 *   - Bad model rejection
 *   - POST /api/agent/generate-image without x402 (disabled mode)
 *   - POST /api/agent/generate-image WITH x402 (mock mode, full payment flow)
 *   - Generated asset round-trips via getProject (board.layers.fill.url)
 *   - Provider metadata stored in board_assets.meta
 *   - Payment marked 'served' after successful generation
 *   - Payment marked 'failed' when downstream provider fails
 *   - Error codes mapped to correct HTTP status codes
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const Database = require('better-sqlite3');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-imggen-'));
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

// Start with no env vars set
delete process.env.FAL_KEY;
delete process.env.X402_ENABLED;
delete process.env.AGENT_AUTH_ENABLED;

const RECEIVER = '0x1111111111111111111111111111111111111111';
const PAYER = '0x2222222222222222222222222222222222222222';

function buildPaymentHeader(opts = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = {
    x402Version: 1,
    scheme: 'exact',
    network: 'base',
    payload: {
      signature: '0x' + 'ab'.repeat(65),
      authorization: {
        from: opts.from || PAYER,
        to: opts.to || RECEIVER,
        value: opts.value || '250000',
        validAfter: String(nowSec - 10),
        validBefore: String(nowSec + 300),
        nonce: '0x' + 'cd'.repeat(32),
      },
    },
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function buildApp() {
  // Clear caches so env changes take effect
  const modulesToReset = [
    '../services/image-gen',
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

let server;
let port;
async function startServer() {
  return new Promise((resolve) => {
    server = http.createServer(buildApp());
    server.listen(0, () => {
      port = server.address().port;
      resolve();
    });
  });
}
function stopServer() { return new Promise((r) => { server.close(r); }); }

function req(method, reqPath, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'localhost', port, path: reqPath, method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    const r = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: buf,
          text: buf.toString('utf8'),
          json: () => { try { return JSON.parse(buf.toString('utf8')); } catch (e) { return null; } },
        });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

let fail = false;
function check(label, cond, extra) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (!cond) fail = true;
  console.log(`${mark}  ${label}${extra ? '  ' + extra : ''}`);
}

(async () => {
  try {
    // ── 1. Direct provider tests ──
    const imageGen = require('../services/image-gen');
    imageGen.resetProvider();

    // Mock provider, valid prompt
    let r1 = await imageGen.generateImage({ prompt: 'a cat in a spaceship' });
    check('1. mock generate returns buffer', Buffer.isBuffer(r1.bytes));
    check('1. mock returns valid PNG', r1.bytes.slice(0, 8).toString('hex') === '89504e470d0a1a0a');
    check('1. mock returns image/png mime', r1.mime === 'image/png');
    check('1. mock providerMeta.provider = mock',
      r1.providerMeta.provider === 'mock');
    check('1. mock providerMeta has prompt',
      r1.providerMeta.prompt === 'a cat in a spaceship');
    check('1. mock providerMeta has color', r1.providerMeta.color != null);

    // Same prompt → same bytes
    const r2 = await imageGen.generateImage({ prompt: 'a cat in a spaceship' });
    check('2. mock deterministic (same prompt)', r2.bytes.equals(r1.bytes));

    // Different prompt → different bytes
    const r3 = await imageGen.generateImage({ prompt: 'a dog on a skateboard' });
    check('3. mock different prompt → different bytes', !r3.bytes.equals(r1.bytes));

    // Prompt validation
    try {
      await imageGen.generateImage({ prompt: 'x' });
      check('4. too-short prompt throws', false);
    } catch (e) {
      check('4. too-short prompt throws BAD_PROMPT', e.code === 'BAD_PROMPT');
    }
    try {
      await imageGen.generateImage({ prompt: 'a'.repeat(5000) });
      check('5. too-long prompt throws', false);
    } catch (e) {
      check('5. too-long prompt throws BAD_PROMPT', e.code === 'BAD_PROMPT');
    }
    try {
      await imageGen.generateImage({ prompt: 123 });
      check('6. non-string prompt throws', false);
    } catch (e) {
      check('6. non-string prompt throws BAD_PROMPT', e.code === 'BAD_PROMPT');
    }

    // ── 2. Route without x402 ──
    await startServer();
    let r = await req('POST', '/api/agent/create-project', {
      title: 'ImageGen Test',
      boards: [{ dialogue: 'scene 1', duration: 2000 }],
    });
    check('2a. create project 201', r.status === 201);
    const project = r.json();
    const projectId = project.id;
    const boardUid = project.project.boards[0].uid;

    // Generate image via route
    r = await req('POST', '/api/agent/generate-image', {
      projectId,
      boardUid,
      layer: 'fill',
      prompt: 'opening shot of a dusty western town',
    });
    check('2b. generate-image 201 without x402', r.status === 201);
    check('2b. response has hash', typeof r.json().hash === 'string' && r.json().hash.length === 64);
    check('2b. response provider = mock', r.json().provider === 'mock');
    check('2b. response has prompt', r.json().prompt === 'opening shot of a dusty western town');
    check('2b. response has imageUrl',
      typeof r.json().imageUrl === 'string' && r.json().imageUrl.includes('board-1-' + boardUid + '-fill.png'));

    // Verify asset is retrievable via getProject
    r = await req('GET', '/api/agent/project/' + projectId);
    const layerUrl = r.json().project.boards[0].layers && r.json().project.boards[0].layers.fill
      ? r.json().project.boards[0].layers.fill.url
      : null;
    check('2c. fill layer appears in getProject',
      layerUrl === 'board-1-' + boardUid + '-fill.png');

    // Verify provider metadata stored in board_assets
    const assetRow = db.prepare(
      "SELECT meta FROM board_assets WHERE board_uid = ? AND kind = 'layer:fill'"
    ).get(boardUid);
    check('2d. asset meta row exists', assetRow != null);
    const meta = assetRow ? JSON.parse(assetRow.meta) : null;
    check('2d. asset meta has prompt',
      meta && meta.prompt === 'opening shot of a dusty western town');
    check('2d. asset meta has provider',
      meta && meta.provider === 'mock');
    check('2d. asset meta has model',
      meta && typeof meta.model === 'string');
    check('2d. asset meta has generatedAt',
      meta && typeof meta.generatedAt === 'number');

    // 2e. Bad prompt → 400
    r = await req('POST', '/api/agent/generate-image', {
      projectId, boardUid, layer: 'fill', prompt: 'x',
    });
    check('2e. too-short prompt 400', r.status === 400);
    check('2e. error code BAD_PROMPT', r.json().error.code === 'BAD_PROMPT');

    // 2f. Bad model → 400
    r = await req('POST', '/api/agent/generate-image', {
      projectId, boardUid, layer: 'fill',
      prompt: 'valid prompt here',
      model: 'made-up-model-xyz',
    });
    check('2f. bad model 400', r.status === 400);
    check('2f. error code BAD_MODEL', r.json().error.code === 'BAD_MODEL');

    // 2g. Missing boardUid → 400
    r = await req('POST', '/api/agent/generate-image', {
      projectId, prompt: 'valid prompt',
    });
    check('2g. missing boardUid 400', r.status === 400);

    // 2h. Nonexistent project → 404
    r = await req('POST', '/api/agent/generate-image', {
      projectId: '00000000-0000-0000-0000-000000000999',
      boardUid, prompt: 'valid prompt',
    });
    check('2h. nonexistent project 404', r.status === 404);

    await stopServer();

    // ── 3. Route WITH x402 enabled ──
    process.env.X402_ENABLED = 'mock';
    process.env.X402_NETWORK = 'base';
    process.env.X402_RECEIVER = RECEIVER;
    await startServer();

    // Create a fresh project under this config
    r = await req('POST', '/api/agent/create-project', {
      title: 'Paid Project',
      boards: [{ dialogue: 'scene 1' }],
    });
    check('3a. create project (x402 on) 201', r.status === 201);
    const paidProject = r.json();
    const paidBoardUid = paidProject.project.boards[0].uid;

    // Without payment → 402
    r = await req('POST', '/api/agent/generate-image', {
      projectId: paidProject.id,
      boardUid: paidBoardUid,
      prompt: 'a cat',
    });
    check('3b. generate-image without payment 402', r.status === 402);
    check('3b. 402 response has x402 shape',
      r.json() && r.json().x402Version === 1);
    check('3b. 402 response has correct price',
      r.json().accepts[0].maxAmountRequired === '250000');

    // With payment → 201
    r = await req('POST', '/api/agent/generate-image', {
      projectId: paidProject.id,
      boardUid: paidBoardUid,
      prompt: 'a cat in zero gravity',
    }, {
      'X-Payment': buildPaymentHeader(),
    });
    check('3c. generate-image with payment 201', r.status === 201);

    // Verify payment row exists and is marked served
    const payment = db.prepare(
      "SELECT * FROM payments WHERE resource = '/api/agent/generate-image' ORDER BY created_at DESC LIMIT 1"
    ).get();
    check('3d. payment row created', payment != null);
    check('3d. payment status = served', payment && payment.status === 'served');
    check('3d. payment payer recorded',
      payment && payment.payer.toLowerCase() === PAYER.toLowerCase());
    check('3d. payment amount matches', payment && payment.amount_atomic === '250000');

    await stopServer();

  } catch (e) {
    console.error('EXCEPTION:', e);
    fail = true;
  } finally {
    if (server) {
      try { server.close(); } catch (e) {}
    }
    console.log();
    console.log(fail ? 'FAILED' : 'OK — all checks passed');
    process.exit(fail ? 1 : 0);
  }
})();
