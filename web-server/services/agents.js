/**
 * agents.js — users + agent tokens + project access control
 *
 * All identity and authorisation lookups go through this module. It's the
 * only place in the codebase that touches the `users`, `agent_tokens`, and
 * `project_grants` tables. Keeps permission checks in one spot so the agent
 * routes don't each reinvent the wheel.
 *
 * Tokens are stored as SHA-256 hashes — we never keep the raw token string.
 * When a token is created, the caller sees the raw value ONCE in the
 * response, and from then on it's only ever verified by hashing the
 * presented bearer and looking up the hash.
 */

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { db } = require('./db');

const DEFAULT_USER_ID = '00000000-0000-0000-0000-000000000001';

const stmts = {
  getUser: db.prepare('SELECT * FROM users WHERE id = ?'),
  getUserByHandle: db.prepare('SELECT * FROM users WHERE handle = ?'),
  insertUser: db.prepare(`
    INSERT INTO users (id, handle, email, created_at, meta)
    VALUES (?, ?, ?, ?, ?)
  `),
  listUsers: db.prepare('SELECT id, handle, email, created_at FROM users ORDER BY created_at DESC'),

  insertToken: db.prepare(`
    INSERT INTO agent_tokens (id, user_id, token_hash, name, created_at)
    VALUES (?, ?, ?, ?, ?)
  `),
  getTokenByHash: db.prepare(`
    SELECT t.*, u.handle AS user_handle
      FROM agent_tokens t
      JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = ? AND t.revoked_at IS NULL
  `),
  touchToken: db.prepare('UPDATE agent_tokens SET last_used_at = ? WHERE id = ?'),
  revokeToken: db.prepare('UPDATE agent_tokens SET revoked_at = ? WHERE id = ?'),
  listTokensForUser: db.prepare(`
    SELECT id, name, created_at, last_used_at, revoked_at
      FROM agent_tokens WHERE user_id = ? ORDER BY created_at DESC
  `),

  getProjectOwner: db.prepare('SELECT owner_id FROM projects WHERE id = ?'),
  getGrant: db.prepare(`
    SELECT permission FROM project_grants WHERE project_id = ? AND user_id = ?
  `),
  upsertGrant: db.prepare(`
    INSERT INTO project_grants (project_id, user_id, permission, granted_at, granted_by)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(project_id, user_id)
    DO UPDATE SET permission = excluded.permission,
                  granted_at = excluded.granted_at,
                  granted_by = excluded.granted_by
  `),
  deleteGrant: db.prepare('DELETE FROM project_grants WHERE project_id = ? AND user_id = ?'),
  listGrantsForProject: db.prepare(`
    SELECT g.user_id, u.handle, g.permission, g.granted_at
      FROM project_grants g
      JOIN users u ON u.id = g.user_id
     WHERE g.project_id = ?
  `),

  setProjectOwner: db.prepare('UPDATE projects SET owner_id = ? WHERE id = ?'),
};

function nowMs() { return Date.now(); }

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Generate a fresh random bearer token. The raw value is returned so the
 * caller can show it to the user ONCE; only the hash is persisted.
 */
function generateRawToken() {
  // 32 random bytes → 43-char base64url
  return crypto.randomBytes(32).toString('base64url');
}

// ── users ──────────────────────────────────────────────────────────────

function getDefaultUser() {
  return stmts.getUser.get(DEFAULT_USER_ID);
}

function getUser(id) {
  return stmts.getUser.get(id);
}

function getUserByHandle(handle) {
  return stmts.getUserByHandle.get(handle);
}

function createUser({ handle, email } = {}) {
  if (!handle || typeof handle !== 'string') {
    throw Object.assign(new Error('createUser: handle required'), { code: 'BAD_HANDLE' });
  }
  if (stmts.getUserByHandle.get(handle)) {
    throw Object.assign(new Error(`handle '${handle}' already taken`), { code: 'HANDLE_TAKEN' });
  }
  const id = uuidv4();
  stmts.insertUser.run(id, handle, email || null, nowMs(), null);
  return stmts.getUser.get(id);
}

function listUsers() {
  return stmts.listUsers.all();
}

// ── tokens ─────────────────────────────────────────────────────────────

/**
 * Issue a new bearer token for a user. Returns { id, token } where `token`
 * is the raw string — SHOW IT ONCE and then discard, because it's never
 * stored in its raw form.
 */
function createToken(userId, name = null) {
  if (!stmts.getUser.get(userId)) {
    throw Object.assign(new Error(`no user ${userId}`), { code: 'NO_USER' });
  }
  const raw = generateRawToken();
  const id = uuidv4();
  stmts.insertToken.run(id, userId, hashToken(raw), name, nowMs());
  return { id, token: raw };
}

/**
 * Resolve a raw bearer token to the user it belongs to, or null if the
 * token is unknown or revoked. Touches last_used_at on hit.
 */
function resolveToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') return null;
  const row = stmts.getTokenByHash.get(hashToken(rawToken));
  if (!row) return null;
  stmts.touchToken.run(nowMs(), row.id);
  return {
    tokenId: row.id,
    userId: row.user_id,
    handle: row.user_handle,
    name: row.name,
  };
}

function revokeToken(tokenId) {
  stmts.revokeToken.run(nowMs(), tokenId);
}

function listTokensForUser(userId) {
  return stmts.listTokensForUser.all(userId);
}

// ── project access control ────────────────────────────────────────────

/**
 * Resolve the effective permission a user has on a project.
 * Returns one of: 'owner' | 'read-write' | 'read' | null.
 *
 * 'owner' is implicit for the owner_id column; all other permissions come
 * from project_grants rows.
 */
function getProjectPermission(projectId, userId) {
  const proj = stmts.getProjectOwner.get(projectId);
  if (!proj) return null;
  if (proj.owner_id === userId) return 'owner';
  const grant = stmts.getGrant.get(projectId, userId);
  return grant ? grant.permission : null;
}

function canRead(projectId, userId) {
  const perm = getProjectPermission(projectId, userId);
  return perm === 'owner' || perm === 'read-write' || perm === 'read';
}

function canWrite(projectId, userId) {
  const perm = getProjectPermission(projectId, userId);
  return perm === 'owner' || perm === 'read-write';
}

function canAdmin(projectId, userId) {
  return getProjectPermission(projectId, userId) === 'owner';
}

function grantAccess(projectId, granterUserId, granteeUserId, permission) {
  if (!canAdmin(projectId, granterUserId)) {
    throw Object.assign(new Error('only the project owner can grant access'), { code: 'FORBIDDEN' });
  }
  if (!['read', 'read-write'].includes(permission)) {
    throw Object.assign(new Error(`invalid permission '${permission}'`), { code: 'BAD_PERMISSION' });
  }
  if (!stmts.getUser.get(granteeUserId)) {
    throw Object.assign(new Error(`no user ${granteeUserId}`), { code: 'NO_USER' });
  }
  stmts.upsertGrant.run(projectId, granteeUserId, permission, nowMs(), granterUserId);
}

function revokeAccess(projectId, granterUserId, granteeUserId) {
  if (!canAdmin(projectId, granterUserId)) {
    throw Object.assign(new Error('only the project owner can revoke access'), { code: 'FORBIDDEN' });
  }
  stmts.deleteGrant.run(projectId, granteeUserId);
}

function listGrants(projectId) {
  return stmts.listGrantsForProject.all(projectId);
}

function setProjectOwner(projectId, userId) {
  stmts.setProjectOwner.run(userId, projectId);
}

module.exports = {
  DEFAULT_USER_ID,

  getDefaultUser,
  getUser,
  getUserByHandle,
  createUser,
  listUsers,

  createToken,
  resolveToken,
  revokeToken,
  listTokensForUser,

  getProjectPermission,
  canRead,
  canWrite,
  canAdmin,
  grantAccess,
  revokeAccess,
  listGrants,
  setProjectOwner,
};
