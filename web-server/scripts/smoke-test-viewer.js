/**
 * Ephemeral smoke test for the /view/:projectId viewer.
 * Run: node scripts/smoke-test-viewer.js
 *
 * Spins up an isolated DB + Express instance, creates a project with
 * boards, optionally uploads a fake layer image, hits /view/:id, and
 * asserts the HTML contains the expected content.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const Database = require('better-sqlite3');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-viewer-'));
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
app.use('/view', require('../routes/view'));
app.locals.socketHandler = { broadcast: () => {} };

const server = app.listen(0, async () => {
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
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: out,
        }));
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
    // 1. Create a project with 2 boards + a title
    let r = await req('POST', '/api/agent/create-project', {
      title: 'Test Story',
      aspectRatio: 1.7777,
      boards: [
        { dialogue: 'The protagonist awakens.', action: 'eyes flutter open', duration: 2500 },
        { dialogue: 'She sees the intruder.', action: 'gasp', notes: 'tight on face', duration: 3000 },
      ],
    });
    const r1 = JSON.parse(r.body);
    const projectId = r1.id;
    const [b1, b2] = r1.project.boards;
    check('create-project 201', r.status === 201);
    check('got 2 boards', r1.project.boards.length === 2);

    // 2. Upload a fake PNG to board 1's ink layer so there's content to render
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

    // 3. Hit /view/:id
    r = await req('GET', '/view/' + projectId);
    check('view 200', r.status === 200);
    check('view content-type html', /text\/html/.test(r.headers['content-type']));
    check('view has <title>', /<title>[^<]*Test Story[^<]*AgentBoard<\/title>/.test(r.body));
    check('view has board count header', r.body.includes('2 boards'));
    check('view inlines the data blob', r.body.includes('const DATA = '));
    check('view shows dialogue 1', r.body.includes('The protagonist awakens.'));
    check('view shows dialogue 2', r.body.includes('She sees the intruder.'));
    check('view shows action', r.body.includes('eyes flutter open'));
    check('view shows notes', r.body.includes('tight on face'));
    check('view references ink layer url',
      r.body.includes('/web/projects/' + projectId + '/images/board-1-' + b1.uid + '-ink.png'));
    check('view uses aspect ratio', r.body.includes('1.7777'));

    // 4. 404 on nonexistent project
    r = await req('GET', '/view/00000000-0000-0000-0000-000000000999');
    check('view nonexistent 404', r.status === 404);
    check('view nonexistent has error html',
      /not\s+found/i.test(r.body));

    // 5. 400 on malformed id
    r = await req('GET', '/view/not-a-uuid');
    check('view bad id 400', r.status === 400);

    // 6. Empty-board project
    r = await req('POST', '/api/agent/create-project', { title: 'Empty' });
    const r6 = JSON.parse(r.body);
    r = await req('GET', '/view/' + r6.id);
    check('empty project view 200', r.status === 200);
    check('empty project shows empty state', r.body.includes('no boards yet'));

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
