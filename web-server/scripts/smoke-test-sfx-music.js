/**
 * Ephemeral smoke test for AI sound effects + music generation.
 *
 * Covers:
 *   - tts.generateSoundEffect mock returns a valid WAV with sfx-shaped meta
 *   - tts.generateMusic mock returns a valid WAV with music-shaped meta
 *   - SFX waveform differs from speech waveform for the same string
 *   - Music waveform differs from SFX waveform for the same string
 *   - Mock providers are deterministic
 *   - validatePrompt rejects empty / oversized / non-string prompts
 *   - validateSfxDuration rejects out-of-range values
 *   - validateMusicLength rejects out-of-range values
 *   - POST /api/agent/generate-sfx end-to-end (mock provider)
 *     - happy path 201, asset row in board_assets with kind='audio:sfx'
 *     - kind=ambient → audio:ambient
 *     - missing prompt → 400 BAD_PROMPT
 *     - bad durationSeconds → 400 BAD_DURATION
 *     - missing boardUid → 400 BAD_REQUEST
 *   - POST /api/agent/generate-music end-to-end (mock provider)
 *     - happy path 201, asset row in board_assets with kind='audio:music'
 *     - bad musicLengthMs → 400 BAD_DURATION
 *   - Pricing: getPrice('generate-sfx') and getPrice('generate-music') resolve
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const Database = require('better-sqlite3');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-sfxm-'));
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

let fail = false;
function check(label, cond, extra) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (!cond) fail = true;
  console.log(`${mark}  ${label}${extra ? '  ' + extra : ''}`);
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
    // ── 1. Direct provider tests ──
    const tts = require('../services/tts');
    tts.resetProvider();

    // SFX
    const sfx1 = await tts.generateSoundEffect({ prompt: 'thunderclap rumble' });
    check('1a. sfx returns buffer', Buffer.isBuffer(sfx1.bytes));
    check('1a. sfx mime audio/wav', sfx1.mime === 'audio/wav');
    check('1a. sfx WAV header', sfx1.bytes.slice(0, 4).toString('ascii') === 'RIFF');
    check('1a. sfx WAVE marker', sfx1.bytes.slice(8, 12).toString('ascii') === 'WAVE');
    check('1a. sfx default duration 5s → 5000ms', sfx1.durationMs === 5000);
    check('1a. sfx providerMeta.kind = sfx', sfx1.providerMeta.kind === 'sfx');
    check('1a. sfx prompt echoed', sfx1.providerMeta.prompt === 'thunderclap rumble');

    // Deterministic
    const sfx1b = await tts.generateSoundEffect({ prompt: 'thunderclap rumble' });
    check('1b. sfx deterministic', sfx1b.bytes.equals(sfx1.bytes));

    // Different prompt → different bytes
    const sfx2 = await tts.generateSoundEffect({ prompt: 'gentle wind' });
    check('1c. different sfx prompt → different bytes', !sfx2.bytes.equals(sfx1.bytes));

    // Custom duration
    const sfxLong = await tts.generateSoundEffect({ prompt: 'thunderclap rumble', durationSeconds: 10 });
    check('1d. sfx custom duration 10s → 10000ms', sfxLong.durationMs === 10000);
    check('1d. sfx longer duration → larger buffer', sfxLong.bytes.length > sfx1.bytes.length);

    // promptInfluence echoed
    const sfxInfluence = await tts.generateSoundEffect({ prompt: 'rain', promptInfluence: 0.7 });
    check('1e. sfx promptInfluence echoed', sfxInfluence.providerMeta.promptInfluence === 0.7);

    // Music
    const m1 = await tts.generateMusic({ prompt: 'melancholic lo-fi piano' });
    check('2a. music returns buffer', Buffer.isBuffer(m1.bytes));
    check('2a. music mime audio/wav', m1.mime === 'audio/wav');
    check('2a. music WAV header', m1.bytes.slice(0, 4).toString('ascii') === 'RIFF');
    check('2a. music default 30000ms', m1.durationMs === 30000);
    check('2a. music providerMeta.kind = music', m1.providerMeta.kind === 'music');
    check('2a. music has rootHz', typeof m1.providerMeta.rootHz === 'number');

    const m1b = await tts.generateMusic({ prompt: 'melancholic lo-fi piano' });
    check('2b. music deterministic', m1b.bytes.equals(m1.bytes));

    const m2 = await tts.generateMusic({ prompt: 'epic orchestral cue' });
    check('2c. different music prompt → different bytes', !m2.bytes.equals(m1.bytes));

    // Custom length
    const mShort = await tts.generateMusic({ prompt: 'melancholic lo-fi piano', musicLengthMs: 10000 });
    check('2d. music custom 10s → 10000ms', mShort.durationMs === 10000);
    check('2d. music shorter length → smaller buffer', mShort.bytes.length < m1.bytes.length);

    // SFX vs music vs speech for the SAME prompt should differ
    const sameStr = 'thunder';
    const speechSame = await tts.generateSpeech({ text: sameStr });
    const sfxSame = await tts.generateSoundEffect({ prompt: sameStr });
    const musicSame = await tts.generateMusic({ prompt: sameStr });
    check('3a. speech ≠ sfx for same string', !speechSame.bytes.equals(sfxSame.bytes));
    check('3a. sfx ≠ music for same string', !sfxSame.bytes.equals(musicSame.bytes));
    check('3a. speech ≠ music for same string', !speechSame.bytes.equals(musicSame.bytes));

    // ── 4. Validation ──
    try { await tts.generateSoundEffect({ prompt: '' }); check('4a. empty sfx prompt rejected', false); }
    catch (e) { check('4a. empty sfx prompt → BAD_PROMPT', e.code === 'BAD_PROMPT'); }

    try { await tts.generateSoundEffect({ prompt: 'x'.repeat(2001) }); check('4b. oversized sfx prompt rejected', false); }
    catch (e) { check('4b. oversized sfx prompt → BAD_PROMPT', e.code === 'BAD_PROMPT'); }

    try { await tts.generateSoundEffect({ prompt: 42 }); check('4c. non-string sfx prompt rejected', false); }
    catch (e) { check('4c. non-string sfx prompt → BAD_PROMPT', e.code === 'BAD_PROMPT'); }

    try { await tts.generateSoundEffect({ prompt: 'rain', durationSeconds: 0.1 }); check('4d. too-short sfx duration rejected', false); }
    catch (e) { check('4d. too-short sfx duration → BAD_DURATION', e.code === 'BAD_DURATION'); }

    try { await tts.generateSoundEffect({ prompt: 'rain', durationSeconds: 50 }); check('4e. too-long sfx duration rejected', false); }
    catch (e) { check('4e. too-long sfx duration → BAD_DURATION', e.code === 'BAD_DURATION'); }

    try { await tts.generateSoundEffect({ prompt: 'rain', durationSeconds: 'NaN' }); check('4f. non-numeric duration rejected', false); }
    catch (e) { check('4f. non-numeric sfx duration → BAD_DURATION', e.code === 'BAD_DURATION'); }

    try { await tts.generateMusic({ prompt: '' }); check('4g. empty music prompt rejected', false); }
    catch (e) { check('4g. empty music prompt → BAD_PROMPT', e.code === 'BAD_PROMPT'); }

    try { await tts.generateMusic({ prompt: 'piano', musicLengthMs: 1000 }); check('4h. too-short music rejected', false); }
    catch (e) { check('4h. too-short music → BAD_DURATION', e.code === 'BAD_DURATION'); }

    try { await tts.generateMusic({ prompt: 'piano', musicLengthMs: 999_999 }); check('4i. too-long music rejected', false); }
    catch (e) { check('4i. too-long music → BAD_DURATION', e.code === 'BAD_DURATION'); }

    // ── 5. Pricing entries ──
    const pricing = require('../services/pricing');
    const sfxPrice = pricing.getPrice('generate-sfx');
    check('5a. generate-sfx price resolved', sfxPrice && sfxPrice.priceAtomic === '50000');
    const musicPrice = pricing.getPrice('generate-music');
    check('5b. generate-music price resolved', musicPrice && musicPrice.priceAtomic === '200000');

    // ── 6. Routes end-to-end ──
    await startServer();

    let r = await req('POST', '/api/agent/create-project', {
      title: 'SFX/Music Test',
      boards: [{ dialogue: 'a stormy night', duration: 5000 }],
    });
    check('6a. create project 201', r.status === 201);
    const project = r.body;
    const projectId = project.id;
    const boardUid = project.project.boards[0].uid;

    // generate-sfx happy path
    r = await req('POST', '/api/agent/generate-sfx', {
      projectId, boardUid,
      prompt: 'thunder rumbling in the distance',
    });
    check('6b. generate-sfx 201', r.status === 201);
    check('6b. response.kind = audio:sfx', r.body && r.body.kind === 'audio:sfx');
    check('6b. response has hash (64 hex)', r.body && typeof r.body.hash === 'string' && r.body.hash.length === 64);
    check('6b. response.provider = mock', r.body && r.body.provider === 'mock');
    check('6b. response.durationMs > 0', r.body && r.body.durationMs > 0);
    check('6b. response.prompt echoed', r.body && r.body.prompt === 'thunder rumbling in the distance');

    let row = db.prepare(
      "SELECT meta FROM board_assets WHERE board_uid = ? AND kind = 'audio:sfx'"
    ).get(boardUid);
    check('6c. audio:sfx row in db', row != null);
    let meta = row ? JSON.parse(row.meta) : null;
    check('6c. meta.kind = sfx', meta && meta.kind === 'sfx');
    check('6c. meta has prompt', meta && meta.prompt === 'thunder rumbling in the distance');
    check('6c. meta has durationSeconds', meta && typeof meta.durationSeconds === 'number');
    check('6c. meta has generatedAt', meta && typeof meta.generatedAt === 'number');

    // kind=ambient routes to audio:ambient
    r = await req('POST', '/api/agent/generate-sfx', {
      projectId, boardUid, kind: 'ambient',
      prompt: 'forest at night with crickets',
      durationSeconds: 8,
    });
    check('6d. ambient sfx 201', r.status === 201);
    check('6d. ambient kind = audio:ambient', r.body && r.body.kind === 'audio:ambient');

    // missing boardUid
    r = await req('POST', '/api/agent/generate-sfx', { projectId, prompt: 'rain' });
    check('6e. missing boardUid → 400', r.status === 400);
    check('6e. error code BAD_REQUEST', r.body && r.body.error && r.body.error.code === 'BAD_REQUEST');

    // empty prompt
    r = await req('POST', '/api/agent/generate-sfx', { projectId, boardUid, prompt: '' });
    check('6f. empty prompt → 400', r.status === 400);
    check('6f. error code BAD_PROMPT', r.body && r.body.error && r.body.error.code === 'BAD_PROMPT');

    // bad duration
    r = await req('POST', '/api/agent/generate-sfx', {
      projectId, boardUid, prompt: 'rain', durationSeconds: 100,
    });
    check('6g. bad duration → 400', r.status === 400);
    check('6g. error code BAD_DURATION', r.body && r.body.error && r.body.error.code === 'BAD_DURATION');

    // generate-music happy path
    r = await req('POST', '/api/agent/generate-music', {
      projectId, boardUid,
      prompt: 'melancholic piano with soft strings',
      musicLengthMs: 15000,
    });
    check('7a. generate-music 201', r.status === 201);
    check('7a. response.kind = audio:music', r.body && r.body.kind === 'audio:music');
    check('7a. response.provider = mock', r.body && r.body.provider === 'mock');
    check('7a. response.durationMs = 15000', r.body && r.body.durationMs === 15000);

    row = db.prepare(
      "SELECT meta FROM board_assets WHERE board_uid = ? AND kind = 'audio:music'"
    ).get(boardUid);
    check('7b. audio:music row in db', row != null);
    meta = row ? JSON.parse(row.meta) : null;
    check('7b. meta.kind = music', meta && meta.kind === 'music');
    check('7b. meta has prompt', meta && meta.prompt === 'melancholic piano with soft strings');
    check('7b. meta has musicLengthMs', meta && meta.musicLengthMs === 15000);

    // bad music length
    r = await req('POST', '/api/agent/generate-music', {
      projectId, boardUid, prompt: 'piano', musicLengthMs: 1000,
    });
    check('7c. bad musicLengthMs → 400', r.status === 400);
    check('7c. error code BAD_DURATION', r.body && r.body.error && r.body.error.code === 'BAD_DURATION');

    // missing boardUid
    r = await req('POST', '/api/agent/generate-music', { projectId, prompt: 'piano' });
    check('7d. missing boardUid → 400', r.status === 400);

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
