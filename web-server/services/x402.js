/**
 * x402.js — HTTP 402 Payment Required plumbing (Coinbase x402 spec)
 *
 * This module is the only place in the codebase that knows about x402. It
 * exposes three concerns:
 *
 *   1. buildPaymentRequirements(opts)
 *      Constructs the JSON body returned with a 402 response, telling the
 *      client what payment to produce. Matches the Coinbase x402 spec shape
 *      so any standard x402 client (or facilitator) works with us.
 *
 *   2. verifyPayment(rawHeader, requirements)
 *      Decodes the X-PAYMENT header, validates its structure, and either
 *      (a) in mock mode: accepts structurally-valid payments without
 *          touching a chain — used for local dev and automated tests,
 *      (b) in facilitator mode: POSTs the payload to an x402 facilitator
 *          (e.g. Coinbase's hosted verifier) and trusts its decision,
 *      (c) in chain mode: directly verifies the EIP-3009 signature and
 *          submits the transferWithAuthorization call via viem.
 *
 *      Only (a) is fully wired in this module; (b) is hit by a HTTP POST
 *      that we stub in a comment so the deploy person can enable it
 *      with one env var; (c) throws "not implemented" and references
 *      NOTES.local.md for the wiring guide. We can ship and test the
 *      middleware + client flow end-to-end without a live wallet.
 *
 *   3. recordPayment(row)
 *      Inserts into the `payments` audit table. Always called before a
 *      gated request is served so we have a durable record of every
 *      charge. If recording fails the request fails — "no receipt, no
 *      service."
 */

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { db } = require('./db');

// Base mainnet USDC (the primary deploy target per NOTES.local.md).
// Base Sepolia and Solana can be added via env override when needed.
const DEFAULT_ASSETS = {
  'base':         { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', name: 'USD Coin', version: '2', decimals: 6 },
  'base-sepolia': { address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', name: 'USD Coin', version: '2', decimals: 6 },
};

const stmts = {
  insertPayment: db.prepare(`
    INSERT INTO payments
      (id, project_id, user_id, resource, scheme, network, asset,
       amount_atomic, amount_required, payer, pay_to, tx_hash, status,
       verification_mode, error, meta, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  updatePaymentStatus: db.prepare(`
    UPDATE payments SET status = ?, error = ? WHERE id = ?
  `),
  getPayment: db.prepare('SELECT * FROM payments WHERE id = ?'),
  listRecentForResource: db.prepare(`
    SELECT id, resource, status, amount_atomic, payer, created_at
      FROM payments
     WHERE resource = ?
     ORDER BY created_at DESC
     LIMIT ?
  `),
};

// ── config read from env ──────────────────────────────────────────────

function getConfig() {
  const enabled = process.env.X402_ENABLED;
  const network = process.env.X402_NETWORK || 'base';
  const asset = process.env.X402_ASSET || (DEFAULT_ASSETS[network] || DEFAULT_ASSETS['base']).address;
  const assetMeta = DEFAULT_ASSETS[network] || DEFAULT_ASSETS['base'];
  const payTo = process.env.X402_RECEIVER || '0x0000000000000000000000000000000000000000';
  const facilitatorUrl = process.env.X402_FACILITATOR_URL || null;

  let mode;
  if (!enabled || enabled === '0') mode = 'off';
  else if (enabled === 'mock') mode = 'mock';
  else if (facilitatorUrl) mode = 'facilitator';
  else mode = 'chain';

  return {
    enabled: mode !== 'off',
    mode,
    network,
    asset,
    assetName: assetMeta.name,
    assetVersion: assetMeta.version,
    assetDecimals: assetMeta.decimals,
    payTo,
    facilitatorUrl,
  };
}

function isEnabled() {
  return getConfig().enabled;
}

// ── requirements (the 402 response body) ──────────────────────────────

/**
 * Build an x402 payment requirements object for a route.
 *
 * opts:
 *   resource            full URL path (e.g. '/api/agent/generate-image')
 *   priceAtomic         cost in smallest token unit (string or number)
 *                       — for USDC this is 10^6 per dollar, so 25¢ = '250000'
 *   description         human-readable description shown to the payer
 *   maxTimeoutSeconds   how long the signature is valid (default 300)
 */
function buildPaymentRequirements(opts) {
  const cfg = getConfig();
  const priceAtomic = String(opts.priceAtomic);

  return {
    x402Version: 1,
    accepts: [
      {
        scheme: 'exact',
        network: cfg.network,
        maxAmountRequired: priceAtomic,
        resource: opts.resource,
        description: opts.description || '',
        mimeType: 'application/json',
        payTo: cfg.payTo,
        maxTimeoutSeconds: Number(opts.maxTimeoutSeconds || 300),
        asset: cfg.asset,
        outputSchema: opts.outputSchema || null,
        extra: {
          name: cfg.assetName,
          version: cfg.assetVersion,
        },
      },
    ],
    error: opts.error || 'Payment required',
  };
}

// ── payment header parsing ────────────────────────────────────────────

/**
 * Decode the X-PAYMENT header into the payload object. Per spec, the
 * header is a base64-encoded JSON blob of the shape:
 *
 *   {
 *     "x402Version": 1,
 *     "scheme": "exact",
 *     "network": "base",
 *     "payload": {
 *       "signature": "0x...",
 *       "authorization": {
 *         "from": "0x...", "to": "0x...", "value": "1000",
 *         "validAfter": "...", "validBefore": "...", "nonce": "..."
 *       }
 *     }
 *   }
 */
function decodePaymentHeader(raw) {
  if (!raw || typeof raw !== 'string') {
    throw Object.assign(new Error('missing X-PAYMENT header'), { code: 'MISSING' });
  }
  let json;
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    json = JSON.parse(decoded);
  } catch (e) {
    throw Object.assign(new Error('X-PAYMENT header is not valid base64 JSON'), { code: 'MALFORMED' });
  }
  return json;
}

/**
 * Shape-check a decoded payment payload against what x402 expects.
 * Throws with a .code if anything's off. Does NOT touch a chain.
 */
function structurallyValidate(payload, requirements) {
  if (!payload || typeof payload !== 'object') {
    throw Object.assign(new Error('payload is not an object'), { code: 'MALFORMED' });
  }
  if (payload.x402Version !== 1) {
    throw Object.assign(new Error(`unsupported x402Version ${payload.x402Version}`), { code: 'BAD_VERSION' });
  }

  const accept = requirements.accepts[0];
  if (payload.scheme !== accept.scheme) {
    throw Object.assign(new Error(`scheme mismatch (want ${accept.scheme}, got ${payload.scheme})`), { code: 'BAD_SCHEME' });
  }
  if (payload.network !== accept.network) {
    throw Object.assign(new Error(`network mismatch (want ${accept.network}, got ${payload.network})`), { code: 'BAD_NETWORK' });
  }

  const inner = payload.payload;
  if (!inner || typeof inner !== 'object') {
    throw Object.assign(new Error('payload.payload missing'), { code: 'MALFORMED' });
  }
  if (typeof inner.signature !== 'string' || inner.signature.length < 10) {
    throw Object.assign(new Error('signature missing or too short'), { code: 'BAD_SIGNATURE' });
  }

  const auth = inner.authorization;
  if (!auth || typeof auth !== 'object') {
    throw Object.assign(new Error('authorization missing'), { code: 'MALFORMED' });
  }
  if (typeof auth.from !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(auth.from)) {
    throw Object.assign(new Error('authorization.from not a 0x address'), { code: 'BAD_ADDRESS' });
  }
  if (typeof auth.to !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(auth.to)) {
    throw Object.assign(new Error('authorization.to not a 0x address'), { code: 'BAD_ADDRESS' });
  }

  // to must match our receiver
  if (auth.to.toLowerCase() !== accept.payTo.toLowerCase()) {
    throw Object.assign(
      new Error(`authorization.to '${auth.to}' does not match expected payTo '${accept.payTo}'`),
      { code: 'WRONG_RECEIVER' }
    );
  }

  const value = BigInt(auth.value);
  const required = BigInt(accept.maxAmountRequired);
  if (value < required) {
    throw Object.assign(
      new Error(`authorization.value ${value} below required ${required}`),
      { code: 'INSUFFICIENT' }
    );
  }

  // validBefore must be in the future
  const validBefore = Number(auth.validBefore);
  const now = Math.floor(Date.now() / 1000);
  if (Number.isFinite(validBefore) && validBefore < now) {
    throw Object.assign(new Error('authorization expired'), { code: 'EXPIRED' });
  }

  return { from: auth.from, to: auth.to, value: auth.value };
}

// ── verification backends ─────────────────────────────────────────────

async function verifyWithFacilitator(payload, requirements, cfg) {
  // Stubbed — when X402_FACILITATOR_URL is set in prod, we POST the
  // payment payload and requirements to the facilitator and trust its
  // "settled" response. Coinbase maintains a hosted facilitator at
  // facilitator.x402.org; we can swap in a URL to it here.
  //
  // See NOTES.local.md for the wiring instructions.
  throw Object.assign(
    new Error('facilitator verification not implemented — set X402_ENABLED=mock for testing, see NOTES.local.md'),
    { code: 'NOT_IMPLEMENTED' }
  );
}

async function verifyOnChain(payload, requirements, cfg) {
  // Direct on-chain verification path. Uses viem (or ethers) to:
  //   1. Recreate the EIP-712 typed data for transferWithAuthorization
  //   2. Verify the signature matches authorization.from
  //   3. Submit transferWithAuthorization() from a server-side signer
  //   4. Wait for confirmation
  //   5. Record tx_hash
  //
  // Not implemented yet — needs a real wallet and RPC to test. See
  // NOTES.local.md Layer 3 section.
  throw Object.assign(
    new Error('on-chain verification not implemented — set X402_ENABLED=mock for testing, see NOTES.local.md'),
    { code: 'NOT_IMPLEMENTED' }
  );
}

/**
 * Verify a payment and return { ok, details, mode } on success, or throw
 * with a .code on failure. `details` includes the payer address and value.
 */
async function verifyPayment(rawHeader, requirements) {
  const cfg = getConfig();
  if (!cfg.enabled) {
    throw Object.assign(new Error('x402 disabled'), { code: 'DISABLED' });
  }
  const payload = decodePaymentHeader(rawHeader);
  const details = structurallyValidate(payload, requirements);

  if (cfg.mode === 'mock') {
    return { ok: true, details, mode: 'mock', txHash: null };
  }
  if (cfg.mode === 'facilitator') {
    const result = await verifyWithFacilitator(payload, requirements, cfg);
    return { ok: true, details, mode: 'facilitator', txHash: result.txHash };
  }
  const result = await verifyOnChain(payload, requirements, cfg);
  return { ok: true, details, mode: 'chain', txHash: result.txHash };
}

// ── payment recording ─────────────────────────────────────────────────

function recordPayment({
  resource,
  scheme,
  network,
  asset,
  amountAtomic,
  amountRequired,
  payer,
  payTo,
  txHash,
  verificationMode,
  userId = null,
  projectId = null,
  meta = null,
}) {
  const id = uuidv4();
  stmts.insertPayment.run(
    id,
    projectId,
    userId,
    resource,
    scheme,
    network,
    asset,
    String(amountAtomic),
    String(amountRequired),
    payer || null,
    payTo,
    txHash || null,
    'verified',
    verificationMode,
    null,
    meta ? JSON.stringify(meta) : null,
    Date.now()
  );
  return id;
}

function markPaymentServed(paymentId) {
  stmts.updatePaymentStatus.run('served', null, paymentId);
}

function markPaymentFailed(paymentId, errorMessage) {
  stmts.updatePaymentStatus.run('failed', String(errorMessage).slice(0, 500), paymentId);
}

function getPayment(id) {
  return stmts.getPayment.get(id);
}

module.exports = {
  isEnabled,
  getConfig,
  buildPaymentRequirements,
  decodePaymentHeader,
  structurallyValidate,
  verifyPayment,
  recordPayment,
  markPaymentServed,
  markPaymentFailed,
  getPayment,
  DEFAULT_ASSETS,
};
