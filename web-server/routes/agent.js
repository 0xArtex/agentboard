/**
 * /api/agent/* — story-shaped authoring API for agents
 *
 * These endpoints wrap the low-level project-store + blob-store primitives
 * into a batch-friendly, ergonomic surface that matches how agents actually
 * think about storyboards: "here's a spec for a whole project," "add these
 * five scenes," "upload this image to this board's fill layer."
 *
 * Every mutation runs through the agent-auth middleware (req.agent is
 * always populated), and every route that touches an existing project
 * checks permissions. Creates implicitly attribute ownership to the
 * caller. Mutations of someone else's project require a read-write grant.
 *
 * Image + audio uploads accept base64-encoded bytes in the JSON body for
 * simplicity. Agents that want to upload larger files can chunk them
 * client-side; we'll add streaming/multipart in Phase 3.5 if it's needed.
 *
 * Broadcasts happen via the existing socketHandler on every successful
 * mutation so connected clients / other agents see changes in real time.
 * The socket event shape is intentionally forward-compatible with the
 * Layer 4 (collab) work coming next.
 */

const express = require('express');
const router = express.Router();

const store = require('../services/project-store');
const agents = require('../services/agents');
const shareTokens = require('../services/share-tokens');
const { asyncHandler } = require('../middleware/error-handler');
const { requireAgent } = require('../middleware/agent-auth');

// ── helpers ────────────────────────────────────────────────────────────

function decodeBase64(input, fieldName) {
  if (typeof input !== 'string' || input.length === 0) {
    const err = new Error(`${fieldName} must be a non-empty base64 string`);
    err.code = 'BAD_BASE64';
    throw err;
  }
  // Strip data URL prefix if the caller included one
  const stripped = input.replace(/^data:[^;]+;base64,/, '');
  try {
    const buf = Buffer.from(stripped, 'base64');
    if (buf.length === 0) {
      const err = new Error(`${fieldName} decoded to empty buffer`);
      err.code = 'BAD_BASE64';
      throw err;
    }
    return buf;
  } catch (e) {
    const err = new Error(`${fieldName} is not valid base64`);
    err.code = 'BAD_BASE64';
    throw err;
  }
}

function broadcast(req, event, payload) {
  const handler = req.app.locals.socketHandler;
  if (handler && typeof handler.broadcast === 'function') {
    try { handler.broadcast(event, payload); } catch (e) { /* socket errors are non-fatal */ }
  }
}

function publicShareUrl(req, projectId) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.get('host') || 'localhost:3456';
  const base = process.env.PUBLIC_BASE_URL || `${proto}://${host}`;
  return {
    viewUrl: `${base}/view/${projectId}`,
    apiUrl: `${base}/api/projects/${projectId}`,
  };
}

function requireProjectAccess(level) {
  // level: 'read' | 'write' | 'owner'
  return (req, res, next) => {
    const projectId = req.params.id || req.params.projectId || (req.body && req.body.projectId);
    if (!projectId) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'No projectId in path or body' } });
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
    const required = { read: 1, write: 2, owner: 3 }[level];
    if (ranks[perm] < required) {
      return res.status(403).json({
        error: { code: 'FORBIDDEN', message: `Requires ${level}; you have ${perm}` },
      });
    }
    req.projectId = projectId;
    return next();
  };
}

// ── project lifecycle ──────────────────────────────────────────────────

// POST /api/agent/create-project
// Body:
//   {
//     title?: string,                         // stored in project meta
//     aspectRatio?: number,                   // default 1.7777
//     fps?: number,                           // default 24
//     defaultBoardTiming?: number,            // default 2000 (ms)
//     boards?: [{
//       dialogue?, action?, notes?,
//       duration?, newShot?, shot?,
//       layers?: { name: { url, opacity? } }  // optional pre-declared layer filenames
//     }, ...]
//   }
//
// Returns: { id, project, viewUrl, apiUrl }
router.post('/create-project', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const { id } = await store.createProject({
    aspectRatio: body.aspectRatio,
    fps: body.fps,
    defaultBoardTiming: body.defaultBoardTiming,
    ownerId: req.agent.userId,
  });

  // If a title was supplied, tuck it into project meta
  if (body.title) {
    await store.updateProject(id, { meta: { title: body.title } });
  }

  // Add any boards the caller pre-declared
  const createdBoards = [];
  if (Array.isArray(body.boards)) {
    for (const spec of body.boards) {
      const board = await store.addBoard(id, {
        dialogue: spec.dialogue || '',
        action: spec.action || '',
        notes: spec.notes || '',
        duration: spec.duration,
        newShot: spec.newShot,
        shot: spec.shot,
        layers: spec.layers,
      });
      if (board) createdBoards.push(board);
    }
  }

  broadcast(req, 'project:create', { id, ownerId: req.agent.userId });

  const result = await store.getProject(id);
  const urls = publicShareUrl(req, id);
  res.status(201).json({
    id,
    project: result.project,
    boards: createdBoards,
    ...urls,
  });
}));

// GET /api/agent/project/:id
// Returns the full project in the same shape as /api/projects/:id, plus
// the share URLs and owner metadata.
router.get('/project/:id', requireProjectAccess('read'), asyncHandler(async (req, res) => {
  const result = await store.getProject(req.params.id);
  if (!result) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found' } });
  const urls = publicShareUrl(req, req.params.id);
  res.json({
    id: req.params.id,
    project: result.project,
    permission: req.agentProjectPermission || agents.getProjectPermission(req.params.id, req.agent.userId),
    ...urls,
  });
}));

// GET /api/agent/projects
// List all projects the caller owns. Does NOT include projects shared with
// the caller via grants — that's a Phase 3.5 thing.
router.get('/projects', requireAgent, asyncHandler(async (req, res) => {
  const projects = await store.listProjectsByOwner(req.agent.userId);
  res.json({ projects });
}));

// GET /api/agent/share/:id
// Returns the base share URL (unauthenticated public view, no token).
// In prod when `PUBLIC_VIEW_REQUIRES_TOKEN=1` this URL won't work without
// a mint from POST /api/agent/share/:id. Most of the time the caller
// wants the token flow — use the POST below.
router.get('/share/:id', requireProjectAccess('read'), asyncHandler(async (req, res) => {
  const urls = publicShareUrl(req, req.params.id);
  res.json({ id: req.params.id, ...urls });
}));

// POST /api/agent/share/:id
// Body: { permission?: 'view'|'comment'|'edit' (default view),
//         name?: string,
//         ttlMs?: number   // expires after ttlMs milliseconds, NULL = never }
// Mints a new shareable token for the project.
router.post('/share/:id', requireProjectAccess('write'), asyncHandler(async (req, res) => {
  const body = req.body || {};
  const ttlMs = typeof body.ttlMs === 'number' && body.ttlMs > 0 ? body.ttlMs : null;
  const expiresAt = ttlMs ? Date.now() + ttlMs : null;
  try {
    const token = shareTokens.createShareToken(req.projectId, {
      permission: body.permission,
      name: body.name,
      expiresAt,
      createdBy: req.agent.userId,
    });
    const urls = publicShareUrl(req, req.projectId);
    res.status(201).json({
      id: token.id,
      token: token.token,
      permission: token.permission,
      expiresAt: token.expiresAt,
      viewUrl: `${urls.viewUrl}?t=${encodeURIComponent(token.token)}`,
      warning: 'Save this URL now — the raw token will never be shown again.',
    });
  } catch (err) {
    return res.status(400).json({ error: { code: err.code, message: err.message } });
  }
}));

// GET /api/agent/share/:id/tokens
// List all tokens minted for a project (metadata only — no raw values).
router.get('/share/:id/tokens', requireProjectAccess('read'), asyncHandler(async (req, res) => {
  res.json({ tokens: shareTokens.listShareTokens(req.projectId) });
}));

// DELETE /api/agent/share/:id/tokens/:tokenId
router.delete('/share/:id/tokens/:tokenId', requireProjectAccess('write'), asyncHandler(async (req, res) => {
  const ok = shareTokens.revokeShareToken(req.params.tokenId);
  if (!ok) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Token not found' } });
  res.json({ ok: true });
}));

// ── board mutations ────────────────────────────────────────────────────

// POST /api/agent/add-board
// Body: { projectId, dialogue?, action?, notes?, duration?, newShot?, shot?, layers? }
router.post('/add-board', requireProjectAccess('write'), asyncHandler(async (req, res) => {
  const body = req.body || {};
  const board = await store.addBoard(req.projectId, {
    dialogue: body.dialogue || '',
    action: body.action || '',
    notes: body.notes || '',
    duration: body.duration,
    newShot: body.newShot,
    shot: body.shot,
    layers: body.layers,
  });
  if (!board) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found' } });
  broadcast(req, 'board:add', { projectId: req.projectId, board });
  res.status(201).json({ board });
}));

// POST /api/agent/add-scene
// Body: { projectId, boards: [...] } — batch version of add-board
router.post('/add-scene', requireProjectAccess('write'), asyncHandler(async (req, res) => {
  const body = req.body || {};
  if (!Array.isArray(body.boards) || body.boards.length === 0) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'boards[] required' } });
  }
  const added = [];
  for (const spec of body.boards) {
    const board = await store.addBoard(req.projectId, {
      dialogue: spec.dialogue || '',
      action: spec.action || '',
      notes: spec.notes || '',
      duration: spec.duration,
      newShot: spec.newShot,
      shot: spec.shot,
      layers: spec.layers,
    });
    if (board) added.push(board);
  }
  broadcast(req, 'board:add-scene', { projectId: req.projectId, boards: added });
  res.status(201).json({ boards: added });
}));

// PUT /api/agent/board/:uid
// Body: partial board update. projectId is derived from the board.
// This one doesn't use requireProjectAccess because the project id comes
// from the board, not the URL — we do the permission check inline.
router.put('/board/:uid', asyncHandler(async (req, res) => {
  const uid = req.params.uid;
  const body = req.body || {};
  // Look up the board so we know which project to permission-check
  const existing = await store.getProject(body.projectId || '');
  const projectId = body.projectId;
  if (!projectId) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'projectId required in body' } });
  }
  if (!agents.canWrite(projectId, req.agent.userId)) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'read-write access required' } });
  }
  const board = await store.updateBoard(projectId, uid, body);
  if (!board) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Board not found in project' } });
  broadcast(req, 'board:update', { projectId, board });
  res.json({ board });
}));

// POST /api/agent/set-metadata
// Body: { projectId, updates: [{ boardUid, dialogue?, action?, notes?, duration?, newShot?, shot? }, ...] }
// Batch metadata update — useful for agents editing a whole scene at once.
router.post('/set-metadata', requireProjectAccess('write'), asyncHandler(async (req, res) => {
  const body = req.body || {};
  if (!Array.isArray(body.updates) || body.updates.length === 0) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'updates[] required' } });
  }
  const results = [];
  for (const u of body.updates) {
    if (!u.boardUid) continue;
    const board = await store.updateBoard(req.projectId, u.boardUid, u);
    if (board) results.push(board);
  }
  broadcast(req, 'board:metadata', { projectId: req.projectId, boards: results });
  res.json({ boards: results });
}));

// DELETE /api/agent/board/:uid
router.delete('/board/:uid', asyncHandler(async (req, res) => {
  const projectId = req.body && req.body.projectId;
  if (!projectId) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'projectId required in body' } });
  }
  if (!agents.canWrite(projectId, req.agent.userId)) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'read-write access required' } });
  }
  const ok = await store.deleteBoard(projectId, req.params.uid);
  if (!ok) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Board not found' } });
  broadcast(req, 'board:delete', { projectId, boardUid: req.params.uid });
  res.json({ ok: true });
}));

// ── asset uploads ──────────────────────────────────────────────────────

// POST /api/agent/draw
// Body: {
//   projectId, boardUid,
//   layer: 'fill' | 'reference' | 'ink' | 'notes' | ...,
//   imageBase64: string,         // base64-encoded PNG/JPG bytes
//   mime?: 'image/png' | 'image/jpeg'
// }
// Replaces the target layer for the given board with the uploaded image.
// Programmatic stroke commands are explicitly deferred — see NOTES.local.md
// "Programmatic drawing" section.
router.post('/draw', requireProjectAccess('write'), asyncHandler(async (req, res) => {
  const body = req.body || {};
  const { boardUid, layer } = body;
  if (!boardUid || !layer) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'boardUid and layer required' } });
  }
  let bytes;
  try {
    bytes = decodeBase64(body.imageBase64, 'imageBase64');
  } catch (e) {
    return res.status(400).json({ error: { code: e.code, message: e.message } });
  }
  const mime = body.mime || 'image/png';
  try {
    const result = store.storeBoardAsset(
      req.projectId, boardUid, 'layer:' + layer, bytes, mime
    );
    broadcast(req, 'asset:update', {
      projectId: req.projectId, boardUid, kind: result.kind, hash: result.hash,
    });
    res.status(201).json(result);
  } catch (err) {
    const status = err.code === 'NO_BOARD' ? 404 : (err.code === 'WRONG_PROJECT' ? 403 : 400);
    return res.status(status).json({ error: { code: err.code, message: err.message } });
  }
}));

// POST /api/agent/upload-audio
// Body: {
//   projectId, boardUid,
//   kind?: 'narration' | 'sfx' | 'music' | 'ambient' | 'reference',  // default 'narration'
//   audioBase64: string,
//   mime?: 'audio/mpeg' | 'audio/wav' | 'audio/ogg',                  // default 'audio/mpeg'
//   duration?: number,                                                 // ms, optional metadata
//   voice?: string                                                     // optional voice label
// }
router.post('/upload-audio', requireProjectAccess('write'), asyncHandler(async (req, res) => {
  const body = req.body || {};
  const { boardUid } = body;
  if (!boardUid) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'boardUid required' } });
  }
  let bytes;
  try {
    bytes = decodeBase64(body.audioBase64, 'audioBase64');
  } catch (e) {
    return res.status(400).json({ error: { code: e.code, message: e.message } });
  }
  const subkind = (body.kind || 'narration').replace(/[^a-z]/g, '');
  const mime = body.mime || 'audio/mpeg';
  const meta = {};
  if (body.duration != null) meta.duration = body.duration;
  if (body.voice) meta.voice = body.voice;
  if (body.source) meta.source = body.source;
  try {
    const result = store.storeBoardAsset(
      req.projectId, boardUid, 'audio:' + subkind, bytes, mime,
      Object.keys(meta).length ? meta : null
    );
    broadcast(req, 'asset:update', {
      projectId: req.projectId, boardUid, kind: result.kind, hash: result.hash,
    });
    res.status(201).json(result);
  } catch (err) {
    const status = err.code === 'NO_BOARD' ? 404 : (err.code === 'WRONG_PROJECT' ? 403 : 400);
    return res.status(status).json({ error: { code: err.code, message: err.message } });
  }
}));

// ── stubs that future tasks will implement ─────────────────────────────
// These return 501 so the API surface is discoverable but the unfinished
// bits are clearly marked. Each references the task that implements it.

// Task #36 — AI image generation
router.post('/generate-image', asyncHandler(async (req, res) => {
  res.status(501).json({
    error: {
      code: 'NOT_IMPLEMENTED',
      message: 'Image generation lands with task #36 (fal.ai adapter + x402)',
    },
  });
}));

// Task #37 — ElevenLabs TTS
router.post('/generate-speech', asyncHandler(async (req, res) => {
  res.status(501).json({
    error: {
      code: 'NOT_IMPLEMENTED',
      message: 'Text-to-speech lands with task #37 (ElevenLabs adapter + x402)',
    },
  });
}));

// POST /api/agent/export/pdf
// Body: { projectId }
// Returns the PDF bytes directly (application/pdf). Caller gets a
// downloadable storyboard with one page per board.
const { renderProjectPdf } = require('../services/pdf-export');
router.post('/export/pdf', requireProjectAccess('read'), asyncHandler(async (req, res) => {
  try {
    const pdf = await renderProjectPdf(req.projectId);
    const title = ((await store.getProject(req.projectId)).project.meta || {}).title || 'storyboard';
    const safeFilename = String(title).replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 64) || 'storyboard';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}.pdf"`);
    res.setHeader('Content-Length', pdf.length);
    res.send(pdf);
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: err.message } });
    }
    throw err;
  }
}));

// Also expose a convenience GET for browser-initiated downloads (click a
// link to download the PDF without having to POST from JS). Same permission
// check as the POST version.
router.get('/export/pdf/:projectId', (req, res, next) => {
  // Rewrite the request so requireProjectAccess can find projectId in params
  req.params.id = req.params.projectId;
  return next();
}, requireProjectAccess('read'), asyncHandler(async (req, res) => {
  try {
    const pdf = await renderProjectPdf(req.projectId);
    const title = ((await store.getProject(req.projectId)).project.meta || {}).title || 'storyboard';
    const safeFilename = String(title).replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 64) || 'storyboard';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}.pdf"`);
    res.setHeader('Content-Length', pdf.length);
    res.send(pdf);
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: err.message } });
    }
    throw err;
  }
}));

module.exports = router;
