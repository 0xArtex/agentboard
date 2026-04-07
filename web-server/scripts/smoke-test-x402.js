/**
 * Ephemeral smoke test for x402 middleware + service.
 *
 * Covers:
 *   - Disabled mode: middleware passes through with no payment
 *   - Mock mode: requires payment, rejects missing header, rejects
 *     malformed payloads, accepts valid ones
 *   - Amount enforcement: insufficient value rejected
 *   - Wrong receiver rejected
 *   - Expired authorization rejected
 *   - Successful flow records a row in the payments table
 *   - markServed / markFailed update the audit status
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const Database = require('better-sqlite3');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-x402-'));
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

// Test receiver
const RECEIVER = '0x1111111111111111111111111111111111111111';
const PAYER = '0x2222222222222222222222222222222222222222';

// Helper to build an x402 X-PAYMENT header value (base64 JSON)
function buildPaymentHeader(opts = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = {
    x402Version: 1,
    scheme: opts.scheme || 'exact',
    network: opts.network || 'base',
    payload: {
      signature: opts.signature || '0x' + 'ab'.repeat(65),
      authorization: {
        from: opts.from || PAYER,
        to: opts.to || RECEIVER,
        value: opts.value || '250000',
        validAfter: String(opts.validAfter != null ? opts.validAfter : nowSec - 10),
        validBefore: String(opts.validBefore != null ? opts.validBefore : nowSec + 300),
        nonce: opts.nonce || ('0x' + 'cd'.repeat(32)),
      },
    },
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

// Build a tiny test Express app with a gated route
function buildApp() {
  // Clear module caches so the middleware re-reads env vars
  delete require.cache[require.resolve('../middleware/x402-gate')];
  delete require.cache[require.resolve('../services/x402')];
  const x402Gate = require('../middleware/x402-gate');

  const express = require('express');
  const app = express();
  app.use(express.json());

  app.get('/api/agent/expensive', x402Gate({
    priceAtomic: '250000',
    description: 'Expensive demo thing',
  }), (req, res) => {
    if (req.x402Payment) req.x402Payment.markServed();
    res.json({
      ok: true,
      message: 'here is your expensive thing',
      payment: req.x402Payment ? {
        id: req.x402Payment.id,
        payer: req.x402Payment.payer,
        amount: req.x402Payment.amount,
        mode: req.x402Payment.mode,
      } : null,
    });
  });

  return app;
}

let server;
let port;

function req(method, reqPath, headers) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'localhost', port, path: reqPath, method,
      headers: headers || {},
    };
    const r = http.request(opts, (res) => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: out ? JSON.parse(out) : null }); }
        catch (e) { resolve({ status: res.statusCode, body: out }); }
      });
    });
    r.on('error', reject);
    r.end();
  });
}

async function startServer() {
  return new Promise((resolve) => {
    server = http.createServer(buildApp());
    server.listen(0, () => {
      port = server.address().port;
      resolve();
    });
  });
}

function stopServer() {
  return new Promise((resolve) => { server.close(resolve); });
}

let fail = false;
function check(label, cond, extra) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (!cond) fail = true;
  console.log(`${mark}  ${label}${extra ? '  ' + extra : ''}`);
}

(async () => {
  try {
    // ── 1. Disabled mode — pass through with no payment ──
    delete process.env.X402_ENABLED;
    await startServer();
    let r = await req('GET', '/api/agent/expensive');
    check('1. disabled mode: 200 without payment', r.status === 200);
    check('1. disabled mode: no payment context on req',
      r.body.payment === null);
    await stopServer();

    // ── 2. Mock mode with configured receiver ──
    process.env.X402_ENABLED = 'mock';
    process.env.X402_NETWORK = 'base';
    process.env.X402_RECEIVER = RECEIVER;
    await startServer();

    // 2a. No header → 402 with requirements body
    r = await req('GET', '/api/agent/expensive');
    check('2a. mock mode: 402 without header', r.status === 402);
    check('2a. 402 body has x402Version', r.body && r.body.x402Version === 1);
    check('2a. 402 body has accepts[0]', Array.isArray(r.body && r.body.accepts) && r.body.accepts.length === 1);
    check('2a. accepts[0] has correct price',
      r.body.accepts[0].maxAmountRequired === '250000');
    check('2a. accepts[0] has correct receiver',
      r.body.accepts[0].payTo === RECEIVER);
    check('2a. accepts[0] has correct resource',
      r.body.accepts[0].resource === '/api/agent/expensive');
    check('2a. accepts[0] has asset address', /^0x[0-9a-fA-F]{40}$/.test(r.body.accepts[0].asset));

    // 2b. Garbage header → 402 with error
    r = await req('GET', '/api/agent/expensive', { 'X-Payment': 'not-base64!!' });
    check('2b. garbage header: 402', r.status === 402);
    check('2b. garbage header: error mentions code',
      typeof r.body.error === 'string' && r.body.error.length > 0);

    // 2c. Valid header → 200
    r = await req('GET', '/api/agent/expensive', {
      'X-Payment': buildPaymentHeader(),
    });
    check('2c. valid payment: 200', r.status === 200);
    check('2c. response includes payment id',
      r.body.payment && typeof r.body.payment.id === 'string');
    check('2c. mode = mock', r.body.payment && r.body.payment.mode === 'mock');
    check('2c. payer recorded',
      r.body.payment && r.body.payment.payer.toLowerCase() === PAYER.toLowerCase());

    // 2d. Wrong receiver → 402 / WRONG_RECEIVER
    r = await req('GET', '/api/agent/expensive', {
      'X-Payment': buildPaymentHeader({ to: '0x' + '9'.repeat(40) }),
    });
    check('2d. wrong receiver: 402', r.status === 402);
    check('2d. wrong receiver: error code', /WRONG_RECEIVER/.test(r.body.error || ''));

    // 2e. Insufficient amount → 402 / INSUFFICIENT
    r = await req('GET', '/api/agent/expensive', {
      'X-Payment': buildPaymentHeader({ value: '100' }),
    });
    check('2e. insufficient: 402', r.status === 402);
    check('2e. insufficient: error code', /INSUFFICIENT/.test(r.body.error || ''));

    // 2f. Expired authorization → 402 / EXPIRED
    r = await req('GET', '/api/agent/expensive', {
      'X-Payment': buildPaymentHeader({
        validAfter: Math.floor(Date.now() / 1000) - 3600,
        validBefore: Math.floor(Date.now() / 1000) - 10,
      }),
    });
    check('2f. expired: 402', r.status === 402);
    check('2f. expired: error code', /EXPIRED/.test(r.body.error || ''));

    // 2g. Bad scheme → 402 / BAD_SCHEME
    r = await req('GET', '/api/agent/expensive', {
      'X-Payment': buildPaymentHeader({ scheme: 'made-up' }),
    });
    check('2g. bad scheme: 402', r.status === 402);
    check('2g. bad scheme: error code', /BAD_SCHEME/.test(r.body.error || ''));

    // 2h. Bad address format → 402 / BAD_ADDRESS
    r = await req('GET', '/api/agent/expensive', {
      'X-Payment': buildPaymentHeader({ from: 'not-an-address' }),
    });
    check('2h. bad address: 402', r.status === 402);

    // ── 3. Payment audit log ──
    // After the successful request in 2c, there should be one row in payments.
    const rows = db.prepare('SELECT * FROM payments ORDER BY created_at').all();
    check('3. audit log has exactly one successful payment',
      rows.length === 1, `count=${rows.length}`);
    if (rows[0]) {
      check('3. payment status=served (markServed ran)',
        rows[0].status === 'served');
      check('3. payment resource correct',
        rows[0].resource === '/api/agent/expensive');
      check('3. payment amount matches',
        rows[0].amount_atomic === '250000');
      check('3. payment verification_mode=mock',
        rows[0].verification_mode === 'mock');
      check('3. payment payer recorded',
        rows[0].payer.toLowerCase() === PAYER.toLowerCase());
    }

    // ── 4. markFailed flow ──
    // Hit the endpoint successfully, then manually flip the most recent
    // payment to 'failed' via the service to verify that path.
    r = await req('GET', '/api/agent/expensive', { 'X-Payment': buildPaymentHeader() });
    check('4a. second successful request 200', r.status === 200);
    const paymentId = r.body.payment.id;
    const x402 = require('../services/x402');
    x402.markPaymentFailed(paymentId, 'downstream provider returned 500');
    const updated = x402.getPayment(paymentId);
    check('4b. markPaymentFailed updates status',
      updated.status === 'failed');
    check('4b. error message stored',
      updated.error === 'downstream provider returned 500');

    await stopServer();

  } catch (e) {
    console.error('EXCEPTION:', e);
    fail = true;
  } finally {
    if (server) server.close(() => {});
    console.log();
    console.log(fail ? 'FAILED' : 'OK — all checks passed');
    process.exit(fail ? 1 : 0);
  }
})();
