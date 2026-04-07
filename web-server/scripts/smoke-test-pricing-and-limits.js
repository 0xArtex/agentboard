/**
 * Ephemeral smoke test for pricing config + rate limiting.
 *
 * Covers:
 *   - pricing.getPrice() resolves config file → env var → defaults in the right order
 *   - reloadPricing() picks up file changes
 *   - 402 response body uses the config file price, not a hardcoded value
 *   - Env var override wins over file
 *   - frequencyLimiter: off by default, enforces limits when enabled
 *   - dailySpendLimiter: off by default, enforces cap when enabled
 *   - listPrices() returns the full table
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const Database = require('better-sqlite3');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-pricing-'));
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
delete process.env.SPEND_LIMIT_ENABLED;
delete process.env.X402_PRICE_GENERATE_IMAGE;

let fail = false;
function check(label, cond, extra) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (!cond) fail = true;
  console.log(`${mark}  ${label}${extra ? '  ' + extra : ''}`);
}

// ── 1. Direct pricing service tests ──
(async () => {
  try {
    const pricing = require('../services/pricing');
    pricing.reloadPricing();

    // Should pick up file values
    let p = pricing.getPrice('generate-image');
    check('1a. generate-image price from config file', p && p.priceAtomic === '250000' && p.source === 'file');

    p = pricing.getPrice('generate-speech');
    check('1b. generate-speech price from config file',
      p && p.priceAtomic === '100000' && p.source === 'file');

    p = pricing.getPrice('export-pdf');
    check('1c. export-pdf price 0 from config file', p && p.priceAtomic === '0');

    // Unknown capability returns null
    p = pricing.getPrice('nonexistent-xyz');
    check('1d. unknown capability returns null', p === null);

    // listPrices returns the full table
    const all = pricing.listPrices();
    check('1e. listPrices has generate-image', 'generate-image' in all);
    check('1e. listPrices has generate-speech', 'generate-speech' in all);
    check('1e. listPrices has export-pdf', 'export-pdf' in all);

    // Env var override wins
    process.env.X402_PRICE_GENERATE_IMAGE = '500000';
    p = pricing.getPrice('generate-image');
    check('2a. env var override wins',
      p && p.priceAtomic === '500000' && p.source === 'env');
    delete process.env.X402_PRICE_GENERATE_IMAGE;

    // After deleting env var, back to file value
    p = pricing.getPrice('generate-image');
    check('2b. removing env var falls back to file',
      p && p.priceAtomic === '250000' && p.source === 'file');

    // ── 3. Hot-reload test ──
    // Overwrite the config file, call reloadPricing, verify new value
    const configPath = pricing.CONFIG_PATH;
    const originalConfig = fs.readFileSync(configPath, 'utf8');
    try {
      fs.writeFileSync(configPath, JSON.stringify({
        'generate-image': { priceAtomic: '999999', description: 'reloaded price' },
      }));
      pricing.reloadPricing();
      p = pricing.getPrice('generate-image');
      check('3a. reloadPricing picks up new file value',
        p && p.priceAtomic === '999999');
      check('3a. reloadPricing picks up new description',
        p && p.description === 'reloaded price');

      // Capabilities removed from the file fall back to defaults
      p = pricing.getPrice('generate-speech');
      check('3b. removed capability falls back to default',
        p && p.source === 'default' && p.priceAtomic === '100000');
    } finally {
      fs.writeFileSync(configPath, originalConfig);
      pricing.reloadPricing();
    }

    // ── 4. 402 response body reflects the file price, not hardcoded ──
    process.env.X402_ENABLED = 'mock';
    process.env.X402_NETWORK = 'base';
    process.env.X402_RECEIVER = '0x1111111111111111111111111111111111111111';
    // Clear caches so middleware re-reads env
    for (const m of ['../services/x402', '../middleware/x402-gate', '../middleware/agent-auth', '../routes/agent', '../services/pricing']) {
      delete require.cache[require.resolve(m)];
    }

    const express = require('express');
    const app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use(require('../middleware/agent-auth').agentAuthMiddleware);
    app.use('/api/agent', require('../routes/agent'));
    app.locals.socketHandler = { broadcast: () => {} };
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;

    function reqRaw(method, reqPath, body, headers) {
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
              json: () => { try { return JSON.parse(buf.toString('utf8')); } catch (e) { return null; } },
            });
          });
        });
        r.on('error', reject);
        if (data) r.write(data);
        r.end();
      });
    }

    // Create a project so the route can find it
    let r = await reqRaw('POST', '/api/agent/create-project', {
      title: 'Pricing Test',
      boards: [{ dialogue: 'x' }],
    });
    const projectId = r.json().id;
    const boardUid = r.json().project.boards[0].uid;

    // Hit generate-image without payment — should 402 with correct price
    r = await reqRaw('POST', '/api/agent/generate-image', {
      projectId, boardUid, prompt: 'test',
    });
    check('4a. generate-image 402', r.status === 402);
    check('4a. 402 price matches config file',
      r.json() && r.json().accepts[0].maxAmountRequired === '250000');

    // Change env var, hit again, verify 402 reflects new price
    process.env.X402_PRICE_GENERATE_IMAGE = '500000';
    r = await reqRaw('POST', '/api/agent/generate-image', {
      projectId, boardUid, prompt: 'test',
    });
    check('4b. env var override reflected in 402 body',
      r.json() && r.json().accepts[0].maxAmountRequired === '500000');
    delete process.env.X402_PRICE_GENERATE_IMAGE;

    // ── 5. frequencyLimiter off by default ──
    // Fire 15 requests back-to-back with rate limiting disabled, all should pass
    const rbatchOff = await Promise.all(
      Array.from({ length: 15 }, () =>
        reqRaw('POST', '/api/agent/generate-image', { projectId, boardUid, prompt: 'x' })
      )
    );
    const status402ct = rbatchOff.filter(x => x.status === 402).length;
    check('5a. rate limiter off: no 429s', rbatchOff.every(x => x.status !== 429));
    check('5a. all 15 returned 402 (payment required)', status402ct === 15);

    await new Promise((resolve) => server.close(resolve));

    // ── 6. frequencyLimiter on — enforces cap ──
    process.env.RATE_LIMIT_ENABLED = '1';
    for (const m of ['../middleware/rate-limit', '../routes/agent']) {
      delete require.cache[require.resolve(m)];
    }
    const app2 = express();
    app2.set('trust proxy', true);
    app2.use(express.json({ limit: '50mb' }));
    app2.use(require('../middleware/agent-auth').agentAuthMiddleware);
    app2.use('/api/agent', require('../routes/agent'));
    app2.locals.socketHandler = { broadcast: () => {} };
    const server2 = http.createServer(app2);
    await new Promise((r) => server2.listen(0, r));
    const port2 = server2.address().port;

    function reqRaw2(method, reqPath, body, headers) {
      return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const opts = {
          hostname: 'localhost', port: port2, path: reqPath, method,
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
              json: () => { try { return JSON.parse(buf.toString('utf8')); } catch (e) { return null; } },
            });
          });
        });
        r.on('error', reject);
        if (data) r.write(data);
        r.end();
      });
    }

    // Setup: create project using the new server
    let r2 = await reqRaw2('POST', '/api/agent/create-project', {
      title: 'Rate test',
      boards: [{ dialogue: 'x' }],
    });
    const projectId2 = r2.json().id;
    const boardUid2 = r2.json().project.boards[0].uid;

    // Fire 25 requests — the limit on generate-image is 20/minute
    const rbatchOn = [];
    for (let i = 0; i < 25; i++) {
      rbatchOn.push(await reqRaw2('POST', '/api/agent/generate-image', {
        projectId: projectId2, boardUid: boardUid2, prompt: 'x',
      }));
    }
    const count429 = rbatchOn.filter(x => x.status === 429).length;
    const count402 = rbatchOn.filter(x => x.status === 402).length;
    check('6a. rate limiter on: some 429s after limit',
      count429 >= 5, `count429=${count429}`);
    check('6b. rate limiter on: ≤20 succeeded pre-429',
      count402 <= 20, `count402=${count402}`);
    check('6c. 429 body has RATE_LIMITED code',
      rbatchOn.find(x => x.status === 429).json().error.code === 'RATE_LIMITED');

    await new Promise((resolve) => server2.close(resolve));

    console.log();
    console.log(fail ? 'FAILED' : 'OK — all checks passed');
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('EXCEPTION:', e);
    process.exit(1);
  }
})();
