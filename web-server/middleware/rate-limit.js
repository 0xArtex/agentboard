/**
 * rate-limit.js — request-frequency + spend-cap middleware
 *
 * Two layered guards on top of x402:
 *
 *   1. frequencyLimiter(opts)
 *      Wraps express-rate-limit with sensible defaults. Keyed by agent
 *      token id if authenticated, otherwise by IP. Returns 429 with a
 *      standard Retry-After header when exceeded. Configurable window
 *      and max per route.
 *
 *   2. dailySpendLimiter(opts)
 *      Sums the amount_atomic of every 'served' or 'verified' payment
 *      this agent (or IP, if anonymous) has made in the last 24h and
 *      rejects with 429 when the total would exceed the cap. The point
 *      is "runaway bill protection" — even a legitimate agent that
 *      loops by accident shouldn't burn through arbitrary amounts of
 *      USDC overnight.
 *
 * Both middlewares are no-ops when their respective env vars are unset
 * so local dev + tests don't trip the limits. Production should set:
 *
 *   RATE_LIMIT_ENABLED=1
 *   SPEND_LIMIT_ENABLED=1
 *   SPEND_LIMIT_DAILY_ATOMIC=10000000   # $10 default daily cap
 */

const rateLimit = require('express-rate-limit');
let ipKeyGeneratorFn;
try {
  // express-rate-limit@7+ exports ipKeyGenerator which correctly masks
  // IPv6 suffixes to prevent bypass via suffix variation. Older versions
  // don't have it — fall back to req.ip directly in that case.
  ipKeyGeneratorFn = require('express-rate-limit').ipKeyGenerator;
} catch (e) {
  ipKeyGeneratorFn = null;
}
const { db } = require('../services/db');

// ── keying ────────────────────────────────────────────────────────────

function keyForRequest(req) {
  // Prefer the authenticated agent's token id when available — that way
  // the same wallet-holder can hit the service from multiple IPs without
  // being rate-limited.
  if (req.agent && req.agent.tokenId) return 'token:' + req.agent.tokenId;
  if (req.agent && req.agent.userId && req.agent.authenticated) return 'user:' + req.agent.userId;
  // Fall back to IP — use express-rate-limit's ipKeyGenerator helper
  // which correctly handles IPv6 by masking the bottom 64 bits, so a
  // single /64 client can't bypass by rotating suffix bits.
  if (ipKeyGeneratorFn) {
    return 'ip:' + ipKeyGeneratorFn(req);
  }
  return 'ip:' + (req.ip || req.connection.remoteAddress || 'unknown');
}

// ── frequency limiter ─────────────────────────────────────────────────

/**
 * Build a request-frequency limiter middleware.
 *
 * opts:
 *   windowMs     rolling window size (default 60_000 = 1 minute)
 *   max          max requests per key per window (default 30)
 *   message      custom JSON body on 429
 *
 * Returns a middleware. When RATE_LIMIT_ENABLED is unset, the returned
 * middleware is a no-op pass-through.
 */
function frequencyLimiter(opts = {}) {
  if (process.env.RATE_LIMIT_ENABLED !== '1') {
    return function noopLimiter(_req, _res, next) { return next(); };
  }

  return rateLimit({
    windowMs: opts.windowMs || 60_000,
    max: opts.max || 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: keyForRequest,
    handler: (req, res) => {
      res.status(429).json({
        error: {
          code: 'RATE_LIMITED',
          message: opts.message ||
            `Too many requests. Try again in a moment.`,
          limit: opts.max || 30,
          windowMs: opts.windowMs || 60_000,
        },
      });
    },
  });
}

// ── spend limiter ─────────────────────────────────────────────────────

const sumStmt = db.prepare(`
  SELECT COALESCE(SUM(CAST(amount_atomic AS INTEGER)), 0) AS total_atomic
    FROM payments
   WHERE created_at >= ?
     AND status IN ('served', 'verified')
     AND (
       (user_id IS NOT NULL AND user_id = ?) OR
       (user_id IS NULL AND payer = ?)
     )
`);

/**
 * Build a daily-spend-cap limiter middleware.
 *
 * opts:
 *   maxAtomic     max cumulative spend per agent per 24h (default $10 = 10_000_000)
 *   windowMs      rolling window (default 86_400_000 = 24h)
 *   message       custom JSON body
 *
 * Keyed by agent userId when authenticated, or by payer wallet address
 * for anonymous x402 callers. Sums amount_atomic from the payments table
 * — no extra storage needed.
 */
function dailySpendLimiter(opts = {}) {
  const enabled = process.env.SPEND_LIMIT_ENABLED === '1';
  const envMax = process.env.SPEND_LIMIT_DAILY_ATOMIC;
  const maxAtomic = BigInt(opts.maxAtomic || envMax || '10000000');
  const windowMs = opts.windowMs || 86_400_000;

  return function spendLimitMiddleware(req, res, next) {
    if (!enabled) return next();

    // We can only enforce this for callers we can identify. Anonymous
    // unauthenticated dev requests with no x402 payment get a free pass.
    const userId = req.agent && req.agent.authenticated ? req.agent.userId : null;
    const payer = req.x402Payment && req.x402Payment.payer
      ? req.x402Payment.payer
      : null;
    if (!userId && !payer) return next();

    const since = Date.now() - windowMs;
    const row = sumStmt.get(since, userId, payer);
    const currentTotal = BigInt(row ? row.total_atomic : 0);

    if (currentTotal >= maxAtomic) {
      return res.status(429).json({
        error: {
          code: 'SPEND_LIMIT_EXCEEDED',
          message: opts.message ||
            `Daily spend cap of ${maxAtomic.toString()} atomic units reached. ` +
            `Current: ${currentTotal.toString()}. Resets rolling over 24h.`,
          spentAtomic: currentTotal.toString(),
          limitAtomic: maxAtomic.toString(),
          windowMs,
        },
      });
    }
    return next();
  };
}

module.exports = {
  frequencyLimiter,
  dailySpendLimiter,
  keyForRequest,
};
