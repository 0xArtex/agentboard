/**
 * agent-auth.js — bearer token → req.agent
 *
 * Reads `Authorization: Bearer <token>` off every incoming request and
 * stamps `req.agent = { userId, handle, tokenId, authenticated: true }` if
 * the token resolves.
 *
 * Behaviour depends on AGENT_AUTH_ENABLED:
 *
 *   0 (dev, default)
 *     - Unauthenticated requests are allowed and attributed to the
 *       built-in 'default' user. `req.agent.authenticated = false`.
 *     - Requests WITH a valid token still resolve to the token's user.
 *     - Invalid tokens are ignored (fall through to default).
 *     - Lets local dev work without token plumbing.
 *
 *   1 (production)
 *     - Read-only routes (GET) still allow anonymous access attributed
 *       to the default user. Public shareable views work without auth.
 *     - Mutations (POST/PUT/DELETE/PATCH) require a valid token; missing
 *       or invalid tokens get 401.
 *
 * Individual routes can layer on `requireAgent` or `requirePermission` to
 * enforce tighter rules (e.g. "only the project owner can delete").
 */

const agents = require('../services/agents');

const DEFAULT_USER_ID = agents.DEFAULT_USER_ID;

function isMutation(req) {
  const m = req.method.toUpperCase();
  return m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE';
}

function extractBearer(req) {
  const auth = req.headers['authorization'];
  if (!auth || typeof auth !== 'string') return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function agentAuthMiddleware(req, res, next) {
  const authEnabled = process.env.AGENT_AUTH_ENABLED === '1';
  const rawToken = extractBearer(req);

  if (rawToken) {
    const resolved = agents.resolveToken(rawToken);
    if (resolved) {
      req.agent = {
        userId: resolved.userId,
        handle: resolved.handle,
        tokenId: resolved.tokenId,
        authenticated: true,
      };
      return next();
    }
    // Invalid token — treat as anonymous in dev, reject in prod
    if (authEnabled) {
      return res.status(401).json({
        error: { code: 'INVALID_TOKEN', message: 'Bearer token is invalid or revoked' },
      });
    }
    // fall through to anonymous
  }

  // No token (or invalid one in dev)
  if (authEnabled && isMutation(req)) {
    return res.status(401).json({
      error: {
        code: 'AUTH_REQUIRED',
        message: 'This route requires a Bearer token. See /api/agent/tokens to create one.',
      },
    });
  }

  // Anonymous access — attribute to the default user so downstream code
  // has a consistent shape.
  req.agent = {
    userId: DEFAULT_USER_ID,
    handle: 'default',
    tokenId: null,
    authenticated: false,
  };
  return next();
}

/**
 * Route-level guard: require a caller identity regardless of method.
 * In prod (AGENT_AUTH_ENABLED=1) this means an actual bearer-token-backed
 * agent. In dev (=0, default) the anonymous default user is fine — the
 * point of this guard is to distinguish "needs to know who's calling"
 * from "is public," not to force prod-level auth on local dev.
 */
function requireAgent(req, res, next) {
  const authEnabled = process.env.AGENT_AUTH_ENABLED === '1';
  if (!req.agent) {
    return res.status(401).json({
      error: { code: 'AUTH_REQUIRED', message: 'No agent on request' },
    });
  }
  if (authEnabled && !req.agent.authenticated) {
    return res.status(401).json({
      error: { code: 'AUTH_REQUIRED', message: 'This route requires authentication' },
    });
  }
  return next();
}

/**
 * Route-level guard: require a specific permission level on a project.
 * Expects req.params.id or req.params.projectId to identify the project.
 * Usage:
 *   router.put('/:id/...', requireProjectPermission('read-write'), handler)
 */
function requireProjectPermission(level) {
  if (!['read', 'read-write', 'owner'].includes(level)) {
    throw new Error(`requireProjectPermission: bad level '${level}'`);
  }
  return (req, res, next) => {
    const projectId = req.params.id || req.params.projectId;
    if (!projectId) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'No project id in path' } });
    }
    const userId = req.agent && req.agent.userId;
    if (!userId) {
      return res.status(401).json({ error: { code: 'AUTH_REQUIRED', message: 'No agent on request' } });
    }
    const perm = agents.getProjectPermission(projectId, userId);
    if (!perm) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found or no access' } });
    }
    const ranks = { read: 1, 'read-write': 2, owner: 3 };
    if (ranks[perm] < ranks[level]) {
      return res.status(403).json({
        error: { code: 'FORBIDDEN', message: `Requires ${level}; you have ${perm}` },
      });
    }
    req.agentProjectPermission = perm;
    return next();
  };
}

module.exports = {
  agentAuthMiddleware,
  requireAgent,
  requireProjectPermission,
};
