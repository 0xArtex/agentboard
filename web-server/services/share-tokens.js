/**
 * share-tokens.js — mint, validate, and revoke shareable project URLs
 *
 * All lookups go through prepared statements against the share_tokens
 * table. Raw tokens are never stored — only the sha256 hash. The caller
 * sees the raw value once in createShareToken()'s response, and from
 * then on it's only ever verified by hashing the presented token and
 * doing an index lookup.
 *
 * Tokens are scoped to a single project. Reuse across projects is not
 * supported — if you want two projects to have sharing, mint two tokens.
 */

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { db } = require('./db');

const VALID_PERMISSIONS = new Set(['view', 'comment', 'edit']);

const stmts = {
  insert: db.prepare(`
    INSERT INTO share_tokens
      (id, project_id, token_hash, permission, name, created_by, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getByHash: db.prepare(`
    SELECT *
      FROM share_tokens
     WHERE token_hash = ?
       AND revoked_at IS NULL
  `),
  touch: db.prepare('UPDATE share_tokens SET last_used_at = ? WHERE id = ?'),
  revoke: db.prepare('UPDATE share_tokens SET revoked_at = ? WHERE id = ?'),
  listForProject: db.prepare(`
    SELECT id, permission, name, created_by, created_at, expires_at, last_used_at, revoked_at
      FROM share_tokens
     WHERE project_id = ?
     ORDER BY created_at DESC
  `),
  getById: db.prepare('SELECT * FROM share_tokens WHERE id = ?'),
};

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function generateRawToken() {
  // 24 bytes → 32 base64url chars. Plenty of entropy, short enough that
  // the resulting URL is reasonably friendly.
  return crypto.randomBytes(24).toString('base64url');
}

/**
 * Mint a new share token for a project.
 *
 * opts: { permission = 'view', name = null, expiresAt = null, createdBy = null }
 *
 * Returns { id, token } where `token` is the raw value — SHOW IT ONCE.
 */
function createShareToken(projectId, opts = {}) {
  if (!projectId) {
    throw Object.assign(new Error('projectId required'), { code: 'BAD_REQUEST' });
  }
  const permission = opts.permission || 'view';
  if (!VALID_PERMISSIONS.has(permission)) {
    throw Object.assign(
      new Error(`invalid permission '${permission}' (allowed: ${[...VALID_PERMISSIONS].join(', ')})`),
      { code: 'BAD_PERMISSION' }
    );
  }
  if (opts.expiresAt != null && (typeof opts.expiresAt !== 'number' || opts.expiresAt <= Date.now())) {
    throw Object.assign(new Error('expiresAt must be a future unix ms timestamp'), { code: 'BAD_EXPIRES' });
  }

  const raw = generateRawToken();
  const id = uuidv4();
  stmts.insert.run(
    id,
    projectId,
    hashToken(raw),
    permission,
    opts.name || null,
    opts.createdBy || null,
    Date.now(),
    opts.expiresAt || null
  );
  return { id, token: raw, permission, expiresAt: opts.expiresAt || null };
}

/**
 * Validate a raw share token for a given project. Returns the token row
 * (with permission) if valid, or an object `{ ok: false, reason }` if not.
 */
function validateShareToken(projectId, rawToken) {
  if (!rawToken || typeof rawToken !== 'string') {
    return { ok: false, reason: 'missing' };
  }
  const row = stmts.getByHash.get(hashToken(rawToken));
  if (!row) return { ok: false, reason: 'unknown' };
  if (row.project_id !== projectId) return { ok: false, reason: 'wrong_project' };
  if (row.expires_at != null && row.expires_at < Date.now()) {
    return { ok: false, reason: 'expired' };
  }
  stmts.touch.run(Date.now(), row.id);
  return {
    ok: true,
    id: row.id,
    permission: row.permission,
    name: row.name,
    expiresAt: row.expires_at,
  };
}

function revokeShareToken(id) {
  const row = stmts.getById.get(id);
  if (!row) return false;
  stmts.revoke.run(Date.now(), id);
  return true;
}

function listShareTokens(projectId) {
  return stmts.listForProject.all(projectId).map(r => ({
    id: r.id,
    permission: r.permission,
    name: r.name,
    createdBy: r.created_by,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    lastUsedAt: r.last_used_at,
    revoked: !!r.revoked_at,
  }));
}

module.exports = {
  createShareToken,
  validateShareToken,
  revokeShareToken,
  listShareTokens,
};
