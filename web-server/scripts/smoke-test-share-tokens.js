/**
 * Ephemeral smoke test for share tokens + gated viewer.
 *
 * Covers:
 *   - POST /api/agent/share/:id mints a token and returns viewUrl
 *   - GET /api/agent/share/:id/tokens lists them
 *   - DELETE revokes
 *   - TTL expiry works
 *   - Wrong project rejection
 *   - Gated /view/:id accepts valid tokens and rejects invalid ones
 *   - Non-gated mode still works without tokens (default)
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const Database = require('better-sqlite3');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-share-'));
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
delete process.env.PUBLIC_VIEW_REQUIRES_TOKEN;

const express = require('express');
const { agentAuthMiddleware } = require('../middleware/agent-auth');

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use(agentAuthMiddleware);
  app.use('/api/agent', require('../routes/agent'));
  // Re-require view.js because it reads env vars at registration time
  delete require.cache[require.resolve('../routes/view')];
  app.use('/view', require('../routes/view'));
  app.locals.socketHandler = { broadcast: () => {} };
  return app;
}

let currentApp = buildApp();
const server = http.createServer((req, res) => currentApp(req, res));

server.listen(0, async () => {
  const port = server.address().port;

  function request(method, reqPath, body, headers) {
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

  try {
    // ── setup ──
    let r = await request('POST', '/api/agent/create-project', {
      title: 'Share Test',
      boards: [{ dialogue: 'test', duration: 2000 }],
    });
    check('create-project 201', r.status === 201);
    const projectId = r.json().id;

    // Second project for cross-project rejection test
    r = await request('POST', '/api/agent/create-project', { title: 'Other' });
    const otherProjectId = r.json().id;

    // ── 1. Dev mode (gating OFF) — public view works without token ──
    r = await request('GET', '/view/' + projectId);
    check('1. dev mode view 200 no token', r.status === 200);

    // ── 2. Mint a share token ──
    r = await request('POST', '/api/agent/share/' + projectId, {
      permission: 'view',
      name: 'Client Preview',
    });
    check('2. mint share token 201', r.status === 201);
    const rawToken = r.json().token;
    check('2. token is a string', typeof rawToken === 'string' && rawToken.length > 10);
    check('2. response includes viewUrl with ?t=',
      typeof r.json().viewUrl === 'string' && r.json().viewUrl.includes('?t=' + encodeURIComponent(rawToken)));
    check('2. response warns about one-time display',
      /never be shown again/i.test(r.json().warning || ''));
    const tokenId = r.json().id;

    // ── 3. List tokens ──
    r = await request('GET', '/api/agent/share/' + projectId + '/tokens');
    check('3. list tokens 200', r.status === 200);
    check('3. tokens list has one',
      Array.isArray(r.json().tokens) && r.json().tokens.length === 1);
    check('3. token metadata only (no raw value)',
      r.json().tokens[0].permission === 'view' &&
      !('token' in r.json().tokens[0]));
    check('3. token name preserved', r.json().tokens[0].name === 'Client Preview');

    // ── 4. Enable gating and test access control ──
    process.env.PUBLIC_VIEW_REQUIRES_TOKEN = '1';
    currentApp = buildApp();

    // Anonymous without token → 403
    r = await request('GET', '/view/' + projectId);
    check('4a. gated view no token 403', r.status === 403);
    check('4a. forbidden page mentions private', /private/i.test(r.text));

    // Anonymous with valid token → 200
    r = await request('GET', '/view/' + projectId + '?t=' + encodeURIComponent(rawToken));
    check('4b. gated view valid token 200', r.status === 200);

    // Anonymous with invalid token → 403
    r = await request('GET', '/view/' + projectId + '?t=garbage123');
    check('4c. gated view bad token 403', r.status === 403);

    // Token for WRONG project → 403
    r = await request('GET', '/view/' + otherProjectId + '?t=' + encodeURIComponent(rawToken));
    check('4d. gated view cross-project token 403', r.status === 403);

    // ── 5. Back to dev mode ──
    delete process.env.PUBLIC_VIEW_REQUIRES_TOKEN;
    currentApp = buildApp();
    r = await request('GET', '/view/' + projectId);
    check('5. dev mode again no token 200', r.status === 200);

    // ── 6. TTL expiry ──
    // Mint a token that expires in 50ms, wait 120ms, verify it's dead
    process.env.PUBLIC_VIEW_REQUIRES_TOKEN = '1';
    currentApp = buildApp();

    r = await request('POST', '/api/agent/share/' + projectId, {
      permission: 'view',
      ttlMs: 50,
    });
    check('6a. mint expiring token 201', r.status === 201);
    const shortToken = r.json().token;

    r = await request('GET', '/view/' + projectId + '?t=' + encodeURIComponent(shortToken));
    check('6b. fresh expiring token works 200', r.status === 200);

    await new Promise(resolve => setTimeout(resolve, 120));
    r = await request('GET', '/view/' + projectId + '?t=' + encodeURIComponent(shortToken));
    check('6c. expired token 403', r.status === 403);

    // ── 7. Revoke ──
    delete process.env.PUBLIC_VIEW_REQUIRES_TOKEN;
    currentApp = buildApp();

    r = await request('DELETE', '/api/agent/share/' + projectId + '/tokens/' + tokenId);
    check('7a. revoke 200', r.status === 200);

    // After revoke, the token must fail validation in gated mode
    process.env.PUBLIC_VIEW_REQUIRES_TOKEN = '1';
    currentApp = buildApp();
    r = await request('GET', '/view/' + projectId + '?t=' + encodeURIComponent(rawToken));
    check('7b. revoked token 403', r.status === 403);

    // ── 8. Revoke unknown token ID ──
    r = await request('DELETE', '/api/agent/share/' + projectId + '/tokens/00000000-0000-0000-0000-000000000999');
    check('8. revoke unknown 404', r.status === 404);

    // ── 9. Invalid permission value ──
    r = await request('POST', '/api/agent/share/' + projectId, { permission: 'superuser' });
    check('9. invalid permission 400', r.status === 400);

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
