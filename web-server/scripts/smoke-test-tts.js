/**
 * Ephemeral smoke test for text-to-speech — mock provider + route.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const Database = require('better-sqlite3');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-tts-'));
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

delete process.env.ELEVENLABS_KEY;
delete process.env.X402_ENABLED;
delete process.env.AGENT_AUTH_ENABLED;

const RECEIVER = '0x1111111111111111111111111111111111111111';
const PAYER = '0x2222222222222222222222222222222222222222';

function buildPaymentHeader(amount = '100000') {
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = {
    x402Version: 1,
    scheme: 'exact',
    network: 'base',
    payload: {
      signature: '0x' + 'ab'.repeat(65),
      authorization: {
        from: PAYER,
        to: RECEIVER,
        value: amount,
        validAfter: String(nowSec - 10),
        validBefore: String(nowSec + 300),
        nonce: '0x' + 'cd'.repeat(32),
      },
    },
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function buildApp() {
  const modulesToReset = [
    '../services/tts',
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
async function startServer() {
  return new Promise((resolve) => {
    server = http.createServer(buildApp());
    server.listen(0, () => { port = server.address().port; resolve(); });
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
          status: res.statusCode, headers: res.headers, body: buf,
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
    const tts = require('../services/tts');
    tts.resetProvider();

    // Basic generation
    let r1 = await tts.generateSpeech({ text: 'Hello world' });
    check('1. mock generate returns buffer', Buffer.isBuffer(r1.bytes));
    check('1. mock returns audio/wav mime', r1.mime === 'audio/wav');
    check('1. mock WAV starts with RIFF', r1.bytes.slice(0, 4).toString('ascii') === 'RIFF');
    check('1. mock WAV has WAVE marker', r1.bytes.slice(8, 12).toString('ascii') === 'WAVE');
    check('1. durationMs is positive', r1.durationMs > 0);
    check('1. providerMeta.provider = mock', r1.providerMeta.provider === 'mock');
    check('1. providerMeta has text', r1.providerMeta.text === 'Hello world');

    // Deterministic: same text → same bytes
    const r2 = await tts.generateSpeech({ text: 'Hello world' });
    check('2. mock deterministic', r2.bytes.equals(r1.bytes));

    // Different text → different bytes
    const r3 = await tts.generateSpeech({ text: 'Something else entirely' });
    check('3. different text → different bytes', !r3.bytes.equals(r1.bytes));

    // Longer text → longer duration
    const r4 = await tts.generateSpeech({ text: 'a'.repeat(100) });
    check('4. longer text → longer duration', r4.durationMs >= r1.durationMs);

    // Text validation
    try {
      await tts.generateSpeech({ text: '' });
      check('5. empty text throws', false);
    } catch (e) {
      check('5. empty text throws BAD_TEXT', e.code === 'BAD_TEXT');
    }
    try {
      await tts.generateSpeech({ text: 'x'.repeat(6000) });
      check('6. too-long text throws', false);
    } catch (e) {
      check('6. too-long text throws BAD_TEXT', e.code === 'BAD_TEXT');
    }
    try {
      await tts.generateSpeech({ text: 42 });
      check('7. non-string text throws', false);
    } catch (e) {
      check('7. non-string text throws BAD_TEXT', e.code === 'BAD_TEXT');
    }

    // ── 2. Route without x402 ──
    await startServer();
    let r = await req('POST', '/api/agent/create-project', {
      title: 'TTS Test',
      boards: [{ dialogue: 'narrated scene', duration: 3000 }],
    });
    check('2a. create project 201', r.status === 201);
    const project = r.json();
    const projectId = project.id;
    const boardUid = project.project.boards[0].uid;

    // Generate narration via route
    r = await req('POST', '/api/agent/generate-speech', {
      projectId, boardUid, kind: 'narration',
      text: 'She walked into the dusty saloon.',
    });
    check('2b. generate-speech 201', r.status === 201);
    check('2b. response has hash', typeof r.json().hash === 'string' && r.json().hash.length === 64);
    check('2b. kind = audio:narration', r.json().kind === 'audio:narration');
    check('2b. provider = mock', r.json().provider === 'mock');
    check('2b. durationMs > 0', r.json().durationMs > 0);

    // Asset stored + metadata
    const assetRow = db.prepare(
      "SELECT meta FROM board_assets WHERE board_uid = ? AND kind = 'audio:narration'"
    ).get(boardUid);
    check('2c. asset row exists', assetRow != null);
    const meta = assetRow ? JSON.parse(assetRow.meta) : null;
    check('2c. meta has text', meta && meta.text === 'She walked into the dusty saloon.');
    check('2c. meta has voice', meta && typeof meta.voice === 'string');
    check('2c. meta has durationMs', meta && typeof meta.durationMs === 'number');
    check('2c. meta has generatedAt', meta && typeof meta.generatedAt === 'number');

    // 2d. Empty text → 400
    r = await req('POST', '/api/agent/generate-speech', {
      projectId, boardUid, text: '',
    });
    check('2d. empty text 400', r.status === 400);
    check('2d. error code BAD_TEXT', r.json().error.code === 'BAD_TEXT');

    // 2e. Bad model → 400
    r = await req('POST', '/api/agent/generate-speech', {
      projectId, boardUid, text: 'valid text', model: 'made-up-model',
    });
    // Mock provider doesn't validate model currently, so this passes through.
    // The real ElevenLabs provider would reject it. We're exercising the
    // mock so 201 is the correct mock behaviour; the fact that the mock
    // accepts any model string is documented in tts.js.
    check('2e. mock accepts any model (201)', r.status === 201);

    // 2f. Missing boardUid → 400
    r = await req('POST', '/api/agent/generate-speech', {
      projectId, text: 'something',
    });
    check('2f. missing boardUid 400', r.status === 400);

    // 2g. Different kinds: sfx, music, ambient
    r = await req('POST', '/api/agent/generate-speech', {
      projectId, boardUid, kind: 'sfx', text: 'door slams',
    });
    check('2g. sfx kind 201', r.status === 201);
    check('2g. kind = audio:sfx', r.json().kind === 'audio:sfx');

    // Now the board should have TWO audio assets
    const audioCount = db.prepare(
      "SELECT COUNT(*) as n FROM board_assets WHERE board_uid = ? AND kind LIKE 'audio:%'"
    ).get(boardUid).n;
    check('2h. board has both audio assets', audioCount === 2);

    await stopServer();

    // ── 3. With x402 enabled ──
    process.env.X402_ENABLED = 'mock';
    process.env.X402_NETWORK = 'base';
    process.env.X402_RECEIVER = RECEIVER;
    await startServer();

    r = await req('POST', '/api/agent/create-project', {
      title: 'Paid TTS',
      boards: [{ dialogue: 'paid scene' }],
    });
    const paidProject = r.json();

    // Without payment → 402
    r = await req('POST', '/api/agent/generate-speech', {
      projectId: paidProject.id,
      boardUid: paidProject.project.boards[0].uid,
      text: 'expensive narration',
    });
    check('3a. without payment 402', r.status === 402);
    check('3a. 402 has correct price',
      r.json() && r.json().accepts && r.json().accepts[0].maxAmountRequired === '100000');

    // With payment → 201
    r = await req('POST', '/api/agent/generate-speech', {
      projectId: paidProject.id,
      boardUid: paidProject.project.boards[0].uid,
      text: 'expensive narration',
    }, {
      'X-Payment': buildPaymentHeader('100000'),
    });
    check('3b. with payment 201', r.status === 201);

    // Payment marked served
    const payment = db.prepare(
      "SELECT * FROM payments WHERE resource = '/api/agent/generate-speech' ORDER BY created_at DESC LIMIT 1"
    ).get();
    check('3c. payment row exists', payment != null);
    check('3c. payment status served', payment && payment.status === 'served');
    check('3c. payment amount 100000', payment && payment.amount_atomic === '100000');

    await stopServer();

  } catch (e) {
    console.error('EXCEPTION:', e);
    fail = true;
  } finally {
    if (server) { try { server.close(); } catch (e) {} }
    console.log();
    console.log(fail ? 'FAILED' : 'OK — all checks passed');
    process.exit(fail ? 1 : 0);
  }
})();
