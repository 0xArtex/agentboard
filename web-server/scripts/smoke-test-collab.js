/**
 * Ephemeral smoke test for Layer 4 — multi-agent collaboration.
 *
 * Covers:
 *   Task #39 — optimistic concurrency on board writes
 *     - rowToBoard returns version
 *     - New boards start at version 1
 *     - updateBoard bumps version on every metadata change
 *     - Asset writes (storeBoardAsset, storeLegacyAsset) do NOT bump version
 *     - Versioned update succeeds when expectedVersion matches
 *     - Versioned update fails with VERSION_MISMATCH when expectedVersion is stale
 *     - PUT /api/agent/board/:uid returns 409 + current state on conflict
 *     - set-metadata returns 207 on partial conflict, 200 on all-success, 409 on all-conflict
 *
 *   Task #40 — socket.io mutation broadcasts
 *     - Clients can join a project room via project:subscribe
 *     - broadcastToProject delivers to room members
 *     - Clients NOT subscribed to a project don't receive its events
 *     - board:update fires on PUT, board:add on create, asset:update on draw
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const Database = require('better-sqlite3');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-collab-'));
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
delete process.env.RATE_LIMIT_ENABLED;

function buildApp() {
  const modulesToReset = [
    '../services/image-gen',
    '../services/tts',
    '../services/x402',
    '../services/pricing',
    '../middleware/x402-gate',
    '../middleware/rate-limit',
    '../middleware/agent-auth',
    '../routes/agent',
  ];
  for (const m of modulesToReset) delete require.cache[require.resolve(m)];

  const express = require('express');
  const { Server: SocketIO } = require('socket.io');
  const { setupSocketHandler } = require('../services/socket-handler');

  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use(require('../middleware/agent-auth').agentAuthMiddleware);
  app.use('/api/agent', require('../routes/agent'));

  const server = http.createServer(app);
  const io = new SocketIO(server, { cors: { origin: '*' } });
  const socketHandler = setupSocketHandler(io);
  app.locals.socketHandler = socketHandler;

  return { app, server, io };
}

let server, port;
async function startServer() {
  return new Promise((resolve) => {
    const built = buildApp();
    server = built.server;
    server.listen(0, () => {
      port = server.address().port;
      resolve();
    });
  });
}
function stopServer() { return new Promise((r) => { server.close(() => r()); }); }

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
    await startServer();

    // ── Task #39: versioning ──
    console.log('── Task #39: optimistic concurrency ──');

    let r = await req('POST', '/api/agent/create-project', {
      title: 'Collab Test',
      boards: [{ dialogue: 'initial' }, { dialogue: 'second' }],
    });
    check('39a. create-project 201', r.status === 201);
    const project = r.json();
    const projectId = project.id;
    const [b1, b2] = project.project.boards;

    // Boards start at version 1
    check('39b. b1 starts at version 1', b1.version === 1);
    check('39b. b2 starts at version 1', b2.version === 1);

    // Update without expectedVersion: succeeds, version bumps
    r = await req('PUT', '/api/agent/board/' + b1.uid, {
      projectId, dialogue: 'updated once',
    });
    check('39c. unversioned update 200', r.status === 200);
    check('39c. version bumped to 2', r.json().board.version === 2);

    // Update with correct expectedVersion: succeeds, version → 3
    r = await req('PUT', '/api/agent/board/' + b1.uid, {
      projectId, dialogue: 'updated twice', expectedVersion: 2,
    });
    check('39d. versioned update success 200', r.status === 200);
    check('39d. version → 3', r.json().board.version === 3);

    // Update with stale expectedVersion: 409 with current state
    r = await req('PUT', '/api/agent/board/' + b1.uid, {
      projectId, dialogue: 'stale attempt', expectedVersion: 1,
    });
    check('39e. stale expectedVersion 409', r.status === 409);
    check('39e. 409 error code VERSION_MISMATCH',
      r.json().error.code === 'VERSION_MISMATCH');
    check('39e. 409 includes expectedVersion', r.json().error.expectedVersion === 1);
    check('39e. 409 includes currentVersion', r.json().error.currentVersion === 3);
    check('39e. 409 includes current board state',
      r.json().board && r.json().board.dialogue === 'updated twice');

    // After 409, refetch and retry with correct version → succeeds
    r = await req('PUT', '/api/agent/board/' + b1.uid, {
      projectId, dialogue: 'stale retry', expectedVersion: 3,
    });
    check('39f. retry with correct version 200', r.status === 200);
    check('39f. version → 4', r.json().board.version === 4);

    // Asset upload does NOT bump version
    const fakePng = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    r = await req('POST', '/api/agent/draw', {
      projectId, boardUid: b1.uid, layer: 'ink',
      imageBase64: fakePng.toString('base64'),
      mime: 'image/png',
    });
    check('39g. draw 201', r.status === 201);

    // Now fetch the board and verify version is still 4 (not bumped by draw)
    r = await req('GET', '/api/agent/project/' + projectId);
    const b1After = r.json().project.boards.find(b => b.uid === b1.uid);
    check('39h. version unchanged after asset write', b1After.version === 4);

    // set-metadata batch: partial conflict
    r = await req('POST', '/api/agent/set-metadata', {
      projectId,
      updates: [
        { boardUid: b1.uid, notes: 'new b1 notes', expectedVersion: 4 },  // valid
        { boardUid: b2.uid, notes: 'new b2 notes', expectedVersion: 99 }, // stale
      ],
    });
    check('39i. partial conflict = 207', r.status === 207);
    check('39i. 207 has 1 success, 1 conflict',
      r.json().boards.length === 1 && r.json().conflicts.length === 1);
    check('39i. conflict entry has current board',
      r.json().conflicts[0].currentBoard != null);

    // All successful batch
    const bothCurrent = (await req('GET', '/api/agent/project/' + projectId)).json().project.boards;
    const b1v = bothCurrent.find(b => b.uid === b1.uid).version;
    const b2v = bothCurrent.find(b => b.uid === b2.uid).version;
    r = await req('POST', '/api/agent/set-metadata', {
      projectId,
      updates: [
        { boardUid: b1.uid, notes: 'x', expectedVersion: b1v },
        { boardUid: b2.uid, notes: 'y', expectedVersion: b2v },
      ],
    });
    check('39j. all-success batch 200', r.status === 200);
    check('39j. no conflicts', r.json().conflicts.length === 0);

    // All-conflict batch
    r = await req('POST', '/api/agent/set-metadata', {
      projectId,
      updates: [
        { boardUid: b1.uid, notes: 'z', expectedVersion: 1 },
        { boardUid: b2.uid, notes: 'w', expectedVersion: 1 },
      ],
    });
    check('39k. all-conflict batch 409', r.status === 409);
    check('39k. no successful boards', r.json().boards.length === 0);
    check('39k. two conflicts', r.json().conflicts.length === 2);

    // ── Task #40: socket broadcasts ──
    console.log();
    console.log('── Task #40: socket mutation broadcasts ──');

    const { io: ioClient } = require('socket.io-client');

    // Client A subscribes to projectId
    // Client B subscribes to a DIFFERENT fake project id (should NOT see events)
    const clientA = ioClient(`http://localhost:${port}`, { transports: ['websocket'] });
    const clientB = ioClient(`http://localhost:${port}`, { transports: ['websocket'] });

    await Promise.all([
      new Promise(res => clientA.on('connect', res)),
      new Promise(res => clientB.on('connect', res)),
    ]);
    check('40a. both clients connected', clientA.connected && clientB.connected);

    // A subscribes to real project, B subscribes to a bogus project
    const aSubscribed = new Promise(res => clientA.once('project:subscribed', res));
    const bSubscribed = new Promise(res => clientB.once('project:subscribed', res));
    clientA.emit('project:subscribe', { projectId });
    clientB.emit('project:subscribe', { projectId: '99999999-9999-9999-9999-999999999999' });
    await Promise.all([aSubscribed, bSubscribed]);

    // Track events on both clients
    const aEvents = [];
    const bEvents = [];
    ['board:update', 'board:add', 'asset:update', 'board:metadata', 'board:delete'].forEach(ev => {
      clientA.on(ev, (data) => aEvents.push({ ev, data }));
      clientB.on(ev, (data) => bEvents.push({ ev, data }));
    });

    // Trigger a mutation: add a board
    r = await req('POST', '/api/agent/add-board', {
      projectId, dialogue: 'new board for broadcast test',
    });
    check('40b. add-board 201', r.status === 201);

    // Wait for events to propagate
    await new Promise(r => setTimeout(r, 100));
    check('40c. clientA received board:add', aEvents.some(e => e.ev === 'board:add'));
    check('40c. clientB did NOT receive board:add (wrong project)',
      bEvents.every(e => e.ev !== 'board:add'));

    // Trigger a metadata update
    const newBoard = r.json().board;
    const newBoardV = newBoard.version;
    r = await req('PUT', '/api/agent/board/' + newBoard.uid, {
      projectId, dialogue: 'broadcast update', expectedVersion: newBoardV,
    });
    check('40d. put board 200', r.status === 200);
    await new Promise(r => setTimeout(r, 100));
    check('40e. clientA received board:update',
      aEvents.some(e => e.ev === 'board:update' && e.data.board.uid === newBoard.uid));
    check('40f. clientB received no board:update',
      bEvents.every(e => e.ev !== 'board:update'));

    // Trigger an asset update
    r = await req('POST', '/api/agent/draw', {
      projectId, boardUid: newBoard.uid, layer: 'fill',
      imageBase64: fakePng.toString('base64'),
      mime: 'image/png',
    });
    check('40g. draw 201', r.status === 201);
    await new Promise(r => setTimeout(r, 100));
    check('40h. clientA received asset:update',
      aEvents.some(e => e.ev === 'asset:update' && e.data.boardUid === newBoard.uid));
    check('40i. clientB received no asset:update',
      bEvents.every(e => e.ev !== 'asset:update'));

    // Unsubscribe clientA; subsequent mutations should not reach it
    const aUnsub = new Promise(res => clientA.once('project:unsubscribed', res));
    clientA.emit('project:unsubscribe', { projectId });
    await aUnsub;

    const eventCountBefore = aEvents.length;
    r = await req('PUT', '/api/agent/board/' + newBoard.uid, {
      projectId, dialogue: 'after unsub', // no expectedVersion — unconditional
    });
    check('40j. post-unsub put 200', r.status === 200);
    await new Promise(r => setTimeout(r, 100));
    check('40k. clientA received NO more events after unsubscribe',
      aEvents.length === eventCountBefore);

    clientA.disconnect();
    clientB.disconnect();
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
