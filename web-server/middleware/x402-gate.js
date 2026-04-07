/**
 * x402-gate.js — Express middleware factory for gating routes behind x402
 *
 * Usage:
 *
 *   const x402Gate = require('./middleware/x402-gate');
 *
 *   router.post('/expensive-thing',
 *     x402Gate({
 *       priceAtomic: '250000',            // 0.25 USDC
 *       description: 'Fal.ai image generation',
 *     }),
 *     async (req, res) => {
 *       // req.x402Payment = { id, payer, amount, mode }
 *       // By this point the payment is verified and recorded.
 *       // ...do the actual expensive work...
 *     }
 *   );
 *
 * Behaviour:
 *   - If X402_ENABLED is unset/0, the middleware is a no-op and just
 *     calls next(). Local dev + tests that don't set the env var
 *     pay nothing.
 *   - Otherwise, on every request:
 *     1. If no X-PAYMENT header, respond 402 with the requirements body
 *     2. If header present but invalid, respond 402 with the error + requirements
 *     3. If valid, record a 'verified' row in the payments table, stamp
 *        req.x402Payment = { id, details, mode }, and call next()
 *   - Routes that successfully complete should call req.x402Payment.markServed()
 *     to finalise the audit log to 'served' status. If the route throws
 *     or fails to deliver, the payment row stays in 'verified' (or can be
 *     flipped to 'failed' via req.x402Payment.markFailed(err)) so it's
 *     visible for reconciliation.
 *
 * The route's own error handler is responsible for calling markServed /
 * markFailed — this middleware can't know when the downstream work
 * succeeded.
 */

const x402 = require('../services/x402');

function x402Gate(opts = {}) {
  if (opts.priceAtomic == null) {
    throw new Error('x402Gate: priceAtomic is required');
  }
  // Accept either a static value or a function — function form lets the
  // caller re-read hot-reloadable pricing config per request instead of
  // baking the price in at route-definition time.
  const priceFn = typeof opts.priceAtomic === 'function'
    ? opts.priceAtomic
    : () => String(opts.priceAtomic);
  const descFn = typeof opts.description === 'function'
    ? opts.description
    : () => String(opts.description || '');

  return async function x402Middleware(req, res, next) {
    // Fast path: gating off entirely
    if (!x402.isEnabled()) {
      return next();
    }

    const priceAtomic = priceFn(req);
    const description = descFn(req);

    const resource = req.originalUrl.split('?')[0];
    const requirements = x402.buildPaymentRequirements({
      resource,
      priceAtomic,
      description,
    });

    const header = req.headers['x-payment'];

    // No header → 402 with requirements
    if (!header) {
      res.status(402).json(requirements);
      return;
    }

    // Verify
    let result;
    try {
      result = await x402.verifyPayment(header, requirements);
    } catch (err) {
      // Any error from verification → 402 with error details + requirements
      res.status(402).json({
        ...requirements,
        error: `${err.code || 'INVALID_PAYMENT'}: ${err.message}`,
      });
      return;
    }

    // Record the payment before serving. If recording throws, bail
    // hard — we can't serve a paid resource without a durable record.
    let paymentId;
    try {
      paymentId = x402.recordPayment({
        resource,
        scheme: 'exact',
        network: x402.getConfig().network,
        asset: x402.getConfig().asset,
        amountAtomic: result.details.value,
        amountRequired: priceAtomic,
        payer: result.details.from,
        payTo: result.details.to,
        txHash: result.txHash,
        verificationMode: result.mode,
        userId: req.agent && req.agent.authenticated ? req.agent.userId : null,
      });
    } catch (err) {
      console.error('[x402] recordPayment failed:', err);
      return res.status(500).json({
        error: { code: 'PAYMENT_RECORD_FAILED', message: 'Could not persist payment record' },
      });
    }

    // Stamp the request with the payment context + helpers for the
    // downstream route to finalise status
    req.x402Payment = {
      id: paymentId,
      payer: result.details.from,
      amount: result.details.value,
      mode: result.mode,
      markServed: () => x402.markPaymentServed(paymentId),
      markFailed: (err) => x402.markPaymentFailed(paymentId, err && err.message || String(err)),
    };

    return next();
  };
}

module.exports = x402Gate;
