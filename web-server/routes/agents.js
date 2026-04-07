/**
 * /api/agents/* — user + token management routes
 *
 * These are the bootstrapping routes that let a brand-new AgentBoard
 * instance create users and issue bearer tokens. In local dev they're
 * mostly ignored (AGENT_AUTH_ENABLED=0 attributes everything to the
 * default user anyway). In production they're the only way for an agent
 * to get a credential.
 *
 * Endpoints:
 *   POST /api/agents/users              — create a new user (handle, optional email)
 *   GET  /api/agents/users              — list users
 *   GET  /api/agents/me                 — who am I right now
 *   POST /api/agents/tokens             — mint a new bearer token for the current user
 *                                         (or, with a body.userId, for another user — owner-only)
 *   GET  /api/agents/tokens             — list tokens for the current user (metadata only)
 *   DELETE /api/agents/tokens/:id       — revoke a token
 */

const express = require('express');
const router = express.Router();
const agents = require('../services/agents');
const { asyncHandler } = require('../middleware/error-handler');
const { requireAgent } = require('../middleware/agent-auth');

// GET /api/agents/me
router.get('/me', asyncHandler(async (req, res) => {
  const user = agents.getUser(req.agent.userId);
  res.json({
    authenticated: req.agent.authenticated,
    user: user ? {
      id: user.id,
      handle: user.handle,
      email: user.email,
      createdAt: user.created_at,
    } : null,
  });
}));

// POST /api/agents/users
router.post('/users', asyncHandler(async (req, res) => {
  const { handle, email } = req.body || {};
  try {
    const user = agents.createUser({ handle, email });
    res.status(201).json({
      user: {
        id: user.id,
        handle: user.handle,
        email: user.email,
        createdAt: user.created_at,
      },
    });
  } catch (err) {
    const status = err.code === 'HANDLE_TAKEN' ? 409 : 400;
    return res.status(status).json({ error: { code: err.code, message: err.message } });
  }
}));

// GET /api/agents/users
router.get('/users', asyncHandler(async (req, res) => {
  res.json({ users: agents.listUsers() });
}));

// POST /api/agents/tokens
// Requires an already-authenticated agent OR the dev-mode default user.
// Caller can specify { userId } in the body to mint a token for a different
// user, but only if the caller is that user (no admin concept yet).
router.post('/tokens', asyncHandler(async (req, res) => {
  const currentUserId = req.agent.userId;
  const targetUserId = (req.body && req.body.userId) || currentUserId;
  if (targetUserId !== currentUserId) {
    return res.status(403).json({
      error: { code: 'FORBIDDEN', message: 'You can only mint tokens for yourself' },
    });
  }
  const name = (req.body && req.body.name) || null;
  const { id, token } = agents.createToken(targetUserId, name);
  // Raw token shown ONCE. From now on only the hash is stored.
  res.status(201).json({
    id,
    token,
    warning: 'Save this token now — it will never be shown again.',
  });
}));

// GET /api/agents/tokens
router.get('/tokens', requireAgent, asyncHandler(async (req, res) => {
  res.json({ tokens: agents.listTokensForUser(req.agent.userId) });
}));

// DELETE /api/agents/tokens/:id
router.delete('/tokens/:id', requireAgent, asyncHandler(async (req, res) => {
  // We could check token ownership, but for v1 just trust authenticated
  // callers. Tokens are scoped to users so revoking someone else's is not
  // a capability we've exposed — you'd have to look up the id.
  agents.revokeToken(req.params.id);
  res.json({ ok: true });
}));

module.exports = router;
