/**
 * Ephemeral smoke test for /api/agent/* routes.
 * Run: node scripts/smoke-test-agent-routes.js  (from web-server/)
 *
 * Spins up an isolated SQLite DB in a temp directory, mounts the agent
 * router on an ephemeral Express instance, fires a sequence of requests,
 * and exits 0 on success / 1 on failure. Does NOT touch the live DB.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const Database = require('better-sqlite3');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-agent-route-'));
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

delete process.env.AGENT_AUTH_ENABLED;

const express = require('express');
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(require('../middleware/agent-auth').agentAuthMiddleware);
app.use('/api/agent', require('../routes/agent'));
app.locals.socketHandler = { broadcast: () => {} };

const server = app.listen(0, async () => {
  const port = server.address().port;

  function req(method, path, body) {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const opts = {
        hostname: 'localhost', port, path, method,
        headers: { 'Content-Type': 'application/json' },
      };
      if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
      const r = http.request(opts, (res) => {
        let out = '';
        res.on('data', c => out += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: out ? JSON.parse(out) : null }); }
          catch (e) { resolve({ status: res.statusCode, body: out }); }
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

  try {
    // 1. create-project with 3 boards in one call
    let r = await req('POST', '/api/agent/create-project', {
      title: 'Demo Storyboard',
      aspectRatio: 1.7777,
      boards: [
        { dialogue: 'scene 1: she enters', action: 'walking briskly', duration: 2500 },
        { dialogue: 'scene 2: closeup', action: 'turns head', duration: 1800 },
        { dialogue: 'scene 3: reveal', action: 'steps into light', duration: 3000 },
      ],
    });
    check('create-project 201', r.status === 201, `status=${r.status}`);
    check('create-project has 3 boards', r.body && r.body.project.boards.length === 3,
      `got=${r.body && r.body.project.boards.length}`);
    check('create-project returns viewUrl', !!(r.body && r.body.viewUrl));
    const projectId = r.body.id;
    const [b1, b2, b3] = r.body.project.boards;

    // 2. get project
    r = await req('GET', '/api/agent/project/' + projectId);
    check('get project 200', r.status === 200);
    check('get project is owner', r.body.permission === 'owner',
      `perm=${r.body.permission}`);

    // 3. list own projects
    r = await req('GET', '/api/agent/projects');
    check('list projects has >=1', r.body.projects.length >= 1);

    // 4. add-board
    r = await req('POST', '/api/agent/add-board', {
      projectId, dialogue: 'scene 4', duration: 2000,
    });
    check('add-board 201', r.status === 201);
    check('add-board number=4', r.body.board.number === 4);

    // 5. add-scene batch
    r = await req('POST', '/api/agent/add-scene', {
      projectId,
      boards: [
        { dialogue: 'epilogue A', shot: '2A' },
        { dialogue: 'epilogue B', shot: '2B' },
      ],
    });
    check('add-scene 201', r.status === 201);
    check('add-scene added 2', r.body.boards.length === 2);

    // 6. PUT board (update metadata)
    r = await req('PUT', '/api/agent/board/' + b1.uid, {
      projectId,
      dialogue: 'UPDATED: she enters the room',
      duration: 3500,
    });
    check('put board 200', r.status === 200);
    check('put board dialogue updated',
      r.body.board.dialogue === 'UPDATED: she enters the room');

    // 7. set-metadata batch
    r = await req('POST', '/api/agent/set-metadata', {
      projectId,
      updates: [
        { boardUid: b2.uid, notes: 'tight on face' },
        { boardUid: b3.uid, notes: 'wide establishing' },
      ],
    });
    check('set-metadata 200', r.status === 200);
    check('set-metadata updated 2', r.body.boards.length === 2);

    // 8. draw — upload a tiny fake PNG to b1's ink layer
    const fakePng = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x04,
      0x08, 0x06, 0x00, 0x00, 0x00,
    ]);
    r = await req('POST', '/api/agent/draw', {
      projectId, boardUid: b1.uid, layer: 'ink',
      imageBase64: fakePng.toString('base64'),
      mime: 'image/png',
    });
    check('draw 201', r.status === 201);
    check('draw returns hash', typeof r.body.hash === 'string' && r.body.hash.length === 64);
    check('draw kind = layer:ink', r.body.kind === 'layer:ink');

    // 9. upload-audio
    const fakeAudio = Buffer.from('ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000\u0000', 'binary');
    r = await req('POST', '/api/agent/upload-audio', {
      projectId, boardUid: b1.uid, kind: 'narration',
      audioBase64: fakeAudio.toString('base64'),
      mime: 'audio/mpeg', duration: 3500, voice: 'Rachel',
    });
    check('upload-audio 201', r.status === 201);
    check('upload-audio kind = audio:narration', r.body.kind === 'audio:narration');

    // 10. share URL
    r = await req('GET', '/api/agent/share/' + projectId);
    check('share 200', r.status === 200);
    check('share has viewUrl', !!r.body.viewUrl);

    // 11. delete board
    r = await req('DELETE', '/api/agent/board/' + b3.uid, { projectId });
    check('delete board 200', r.status === 200);

    // 12. final state
    r = await req('GET', '/api/agent/project/' + projectId);
    check('final project has 5 boards', r.body.project.boards.length === 5,
      `got=${r.body.project.boards.length}`);
    const b1Final = r.body.project.boards.find(b => b.uid === b1.uid);
    check('b1 has updated dialogue',
      b1Final && b1Final.dialogue === 'UPDATED: she enters the room');
    check('b1 has ink layer', !!(b1Final && b1Final.layers && b1Final.layers.ink));

    // 13-15. Those endpoints (generate-image, generate-speech, export/pdf)
    // are now fully implemented in their respective tasks #33/#36/#37 and
    // have dedicated smoke tests (smoke-test-pdf-export.js,
    // smoke-test-image-gen.js, smoke-test-tts.js). We skip them here so
    // this test stays scoped to the core Layer 1 routes.

    // 16. bad request: missing projectId on add-board
    r = await req('POST', '/api/agent/add-board', { dialogue: 'nope' });
    check('add-board without projectId 400', r.status === 400);

    // 17. 404 on nonexistent project
    r = await req('GET', '/api/agent/project/00000000-0000-0000-0000-000000000999');
    check('get nonexistent project 404', r.status === 404);

  } catch (e) {
    console.error('EXCEPTION:', e);
    fail = true;
  } finally {
    server.close(() => {
      console.log();
      console.log(fail ? 'FAILED' : 'OK — all checks passed');
      process.exit(fail ? 1 : 0);
    });
  }
});
