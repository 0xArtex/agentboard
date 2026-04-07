/**
 * Ephemeral smoke test for /api/agent/export/pdf.
 * Verifies the PDF is valid, non-empty, and contains one page per board.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const Database = require('better-sqlite3');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-pdf-'));
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

  function request(method, reqPath, body) {
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
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: buf,
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

  try {
    // 1. Create a project with 3 boards
    let r = await request('POST', '/api/agent/create-project', {
      title: 'PDF Test Story',
      aspectRatio: 1.7777,
      boards: [
        { dialogue: 'First board dialogue.', action: 'opens door', duration: 2500 },
        { dialogue: 'Second board line.', action: 'turns', notes: 'tight on eyes', duration: 1800 },
        { dialogue: 'Third beat.', action: 'exits frame', duration: 3000 },
      ],
    });
    check('create-project 201', r.status === 201);
    const project = r.json();
    const projectId = project.id;
    const [b1] = project.project.boards;

    // 2. Upload a tiny real PNG so one board has an actual image
    //    (4x4 RGBA fully transparent, valid PNG)
    const tinyPng = Buffer.from(
      '89504e470d0a1a0a0000000d494844520000000400000004080600000' +
      '0a9f1' +
      '9e7e0000000e4944415478da6300010000000500010d0a2db40000000049454e44ae426082',
      'hex'
    );
    r = await request('POST', '/api/agent/draw', {
      projectId, boardUid: b1.uid, layer: 'ink',
      imageBase64: tinyPng.toString('base64'),
      mime: 'image/png',
    });
    check('draw 201', r.status === 201);

    // 3. POST /api/agent/export/pdf
    r = await request('POST', '/api/agent/export/pdf', { projectId });
    check('pdf export 200', r.status === 200);
    check('pdf content-type', /application\/pdf/.test(r.headers['content-type']));
    check('pdf content-disposition attachment',
      /attachment/.test(r.headers['content-disposition']));
    check('pdf filename derived from title',
      /PDF_Test_Story\.pdf/.test(r.headers['content-disposition'] || ''));
    check('pdf non-empty', r.body.length > 1000, `size=${r.body.length}`);
    check('pdf has %PDF header', r.body.slice(0, 4).toString() === '%PDF');
    check('pdf has %%EOF trailer', r.body.slice(-6).toString().includes('%%EOF'));

    // Count /Type /Page entries as a rough page count — should be >=3 for 3 boards
    const pageCount = (r.body.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
    check('pdf has 3 pages', pageCount === 3, `got=${pageCount}`);

    // 4. GET variant
    r = await request('GET', '/api/agent/export/pdf/' + projectId);
    check('pdf GET variant 200', r.status === 200);
    check('pdf GET content-type', /application\/pdf/.test(r.headers['content-type']));
    check('pdf GET non-empty', r.body.length > 1000);

    // 5. Empty project (no boards) — still produces a valid PDF
    r = await request('POST', '/api/agent/create-project', { title: 'Empty PDF' });
    const emptyId = r.json().id;
    r = await request('POST', '/api/agent/export/pdf', { projectId: emptyId });
    check('empty project pdf 200', r.status === 200);
    check('empty project pdf non-empty', r.body.length > 500);
    check('empty project pdf is a valid pdf', r.body.slice(0, 4).toString() === '%PDF');

    // 6. 404 for nonexistent project
    r = await request('POST', '/api/agent/export/pdf', {
      projectId: '00000000-0000-0000-0000-000000000999',
    });
    check('pdf export 404', r.status === 404);

    // 7. Write one PDF to disk so you can open and eyeball it if you want
    const outPath = path.join(tmpDir, 'sample.pdf');
    r = await request('POST', '/api/agent/export/pdf', { projectId });
    fs.writeFileSync(outPath, r.body);
    console.log('    wrote sample PDF to:', outPath);

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
