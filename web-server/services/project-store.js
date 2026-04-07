/**
 * project-store.js — projects + boards persistence (SQLite + BlobStore)
 *
 * This module is the ONLY thing in the codebase that should touch SQLite or
 * the BlobStore directly for project/board CRUD. Everything else goes through
 * this interface, which keeps the storage layer swappable.
 *
 * Public surface (kept stable across the file→SQLite migration so existing
 * routes don't need to change):
 *
 *   createProject(opts)               -> { id, project }
 *   getProject(id)                    -> { id, project } | null
 *   updateProject(id, updates)        -> { id, project } | null
 *   deleteProject(id)                 -> boolean
 *   listProjects()                    -> [{ id, boardCount, aspectRatio, version }]
 *
 *   addBoard(projectId, data)         -> board | null
 *   updateBoard(projectId, uid, data) -> board | null
 *   deleteBoard(projectId, uid)       -> boolean
 *   reorderBoards(projectId, order)   -> boards | null
 *
 *   listBoardAssets(projectId)        -> [{ filename, kind, hash, size, mime }]
 *      → used by /api/projects/:id/files for the web-bootstrap prefetch
 *      → fixes the verifyScene "every refresh wipes my work" bug
 *
 *   resolveLegacyAsset(projectId, filename) -> { hash, mime, size } | null
 *      → translates `board-1-ABCDE-fill.png` style filenames to a blob hash
 *      → used by fs-api.js + the /web/projects/:uuid static-fallback handler
 *
 *   storeLegacyAsset(projectId, filename, bytes) -> { hash, kind, board_uid }
 *      → reverse: takes a write to a legacy filename, infers the (board, kind)
 *        from the filename, hashes the bytes, and updates board_assets
 *
 *   generateBoardUid()                -> 'XXXXX' (5-char alphanum)
 *
 * Boards in the returned shape match what main-window.js / web-bootstrap.js
 * have always seen — `board.url`, `board.layers.fill.url`, etc are still
 * filename strings. The fact that they're now content-addressed under the
 * hood is invisible to the client.
 */

const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const { db } = require('./db');
const { blobStore } = require('./blob-store');
const { blankPng, dimensionsForAspect } = require('./blank-png');

const DATA_DIR = path.join(__dirname, '..', 'data');
// Legacy compat — app.js still references this for the path map. Nothing
// is actually stored here anymore; project data lives in agentboard.db and
// blobs/. Kept as a non-throwing constant.
const PROJECTS_DIR = path.join(DATA_DIR, 'projects');

// ── prepared statements ────────────────────────────────────────────────
const stmts = {
  // projects
  insertProject: db.prepare(`
    INSERT INTO projects
      (id, version, aspect_ratio, fps, default_board_timing, meta, owner_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getProject: db.prepare('SELECT * FROM projects WHERE id = ?'),
  listProjectsByOwner: db.prepare(`
    SELECT id, version, aspect_ratio, fps, updated_at, owner_id,
           (SELECT COUNT(*) FROM boards WHERE project_id = p.id) AS board_count
      FROM projects p
     WHERE owner_id = ?
     ORDER BY updated_at DESC
  `),
  updateProjectFields: db.prepare(`
    UPDATE projects
       SET version              = COALESCE(?, version),
           aspect_ratio         = COALESCE(?, aspect_ratio),
           fps                  = COALESCE(?, fps),
           default_board_timing = COALESCE(?, default_board_timing),
           meta                 = COALESCE(?, meta),
           updated_at           = ?
     WHERE id = ?
  `),
  deleteProject: db.prepare('DELETE FROM projects WHERE id = ?'),
  listProjects: db.prepare(`
    SELECT id, version, aspect_ratio, fps, updated_at,
           (SELECT COUNT(*) FROM boards WHERE project_id = p.id) AS board_count
      FROM projects p
     ORDER BY updated_at DESC
  `),

  // boards
  insertBoard: db.prepare(`
    INSERT INTO boards
      (uid, project_id, number, new_shot, shot, time_ms, duration_ms,
       dialogue, action, notes, audio, link, meta, last_edited)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  listBoardsForProject: db.prepare(`
    SELECT * FROM boards WHERE project_id = ? ORDER BY number ASC
  `),
  getBoard: db.prepare('SELECT * FROM boards WHERE uid = ?'),
  updateBoardFields: db.prepare(`
    UPDATE boards
       SET number      = COALESCE(?, number),
           new_shot    = COALESCE(?, new_shot),
           shot        = COALESCE(?, shot),
           time_ms     = COALESCE(?, time_ms),
           duration_ms = COALESCE(?, duration_ms),
           dialogue    = COALESCE(?, dialogue),
           action      = COALESCE(?, action),
           notes       = COALESCE(?, notes),
           audio       = COALESCE(?, audio),
           link        = COALESCE(?, link),
           meta        = COALESCE(?, meta),
           last_edited = ?,
           version     = version + 1
     WHERE uid = ?
  `),
  // Same as updateBoardFields but with an extra `version = ?` check for
  // optimistic concurrency. Returns 0 rows-affected when the expected
  // version doesn't match the current one, letting the caller decide
  // whether to refetch + retry or surface a 409 to the user.
  updateBoardFieldsVersioned: db.prepare(`
    UPDATE boards
       SET number      = COALESCE(?, number),
           new_shot    = COALESCE(?, new_shot),
           shot        = COALESCE(?, shot),
           time_ms     = COALESCE(?, time_ms),
           duration_ms = COALESCE(?, duration_ms),
           dialogue    = COALESCE(?, dialogue),
           action      = COALESCE(?, action),
           notes       = COALESCE(?, notes),
           audio       = COALESCE(?, audio),
           link        = COALESCE(?, link),
           meta        = COALESCE(?, meta),
           last_edited = ?,
           version     = version + 1
     WHERE uid = ? AND version = ?
  `),
  setBoardNumber: db.prepare(`
    UPDATE boards SET number = ?, time_ms = ? WHERE uid = ?
  `),
  // Asset writes + renumbers use this to bump last_edited WITHOUT bumping
  // version — the point of version is optimistic concurrency for content
  // (dialogue/action/notes), and we don't want a concurrent asset upload
  // on the same board to invalidate another agent's in-flight metadata
  // edit. Draws and metadata edits are independent domains.
  touchBoardEdited: db.prepare('UPDATE boards SET last_edited = ? WHERE uid = ?'),
  deleteBoard: db.prepare('DELETE FROM boards WHERE uid = ?'),

  // board_assets
  upsertAsset: db.prepare(`
    INSERT INTO board_assets (board_uid, kind, blob_hash, meta, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(board_uid, kind)
    DO UPDATE SET blob_hash = excluded.blob_hash,
                  meta      = excluded.meta,
                  updated_at = excluded.updated_at
  `),
  getAsset: db.prepare(`
    SELECT ba.kind, ba.blob_hash, ba.meta, ba.updated_at,
           b.byte_size, b.mime_type
      FROM board_assets ba
      JOIN blobs b ON b.hash = ba.blob_hash
     WHERE ba.board_uid = ? AND ba.kind = ?
  `),
  listAssetsForBoard: db.prepare(`
    SELECT ba.kind, ba.blob_hash, ba.meta, ba.updated_at,
           b.byte_size, b.mime_type
      FROM board_assets ba
      JOIN blobs b ON b.hash = ba.blob_hash
     WHERE ba.board_uid = ?
  `),
  listAssetsForProject: db.prepare(`
    SELECT b.uid AS board_uid, b.number AS board_number,
           ba.kind, ba.blob_hash, ba.meta, ba.updated_at,
           bl.byte_size, bl.mime_type
      FROM boards b
      JOIN board_assets ba ON ba.board_uid = b.uid
      JOIN blobs bl ON bl.hash = ba.blob_hash
     WHERE b.project_id = ?
     ORDER BY b.number ASC, ba.kind ASC
  `),
};

// ── helpers ────────────────────────────────────────────────────────────

function generateBoardUid() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let uid = '';
  for (let i = 0; i < 5; i++) {
    uid += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return uid;
}

function generateUniqueBoardUid(maxAttempts = 10) {
  for (let i = 0; i < maxAttempts; i++) {
    const uid = generateBoardUid();
    if (!stmts.getBoard.get(uid)) return uid;
  }
  // Astronomically unlikely with 60M possible uids and a fresh DB, but
  // bail loudly rather than infinite-loop if something is very wrong.
  throw new Error('Could not generate a unique board uid after 10 attempts');
}

function sanitize(segment) {
  return String(segment).replace(/[^a-zA-Z0-9_\-\.]/g, '');
}

function nowMs() { return Date.now(); }

// Build the legacy filename for a (board, kind) tuple. The original
// Storyboarder file layout is:
//
//   board-<n>-<uid>.png                  ← composited board PNG
//   board-<n>-<uid>-thumbnail.png        ← drawer thumbnail
//   board-<n>-<uid>-posterframe.jpg      ← posterframe (note: jpg)
//   board-<n>-<uid>-<layer>.png          ← individual layer
//
// We synthesise these on the fly when serializing a board for the client so
// main-window.js sees the same shape it always has.
function legacyFilenameFor(boardNumber, boardUid, kind) {
  const base = `board-${boardNumber}-${boardUid}`;
  if (kind === 'board') return `${base}.png`;
  if (kind === 'thumbnail') return `${base}-thumbnail.png`;
  if (kind === 'posterframe') return `${base}-posterframe.jpg`;
  if (kind.startsWith('layer:')) {
    const layerName = kind.slice('layer:'.length);
    return `${base}-${layerName}.png`;
  }
  return `${base}-${kind}.png`;
}

// Inverse of legacyFilenameFor. Parses the legacy filename to recover the
// (boardNumber, boardUid, kind) tuple. Returns null if the filename doesn't
// match any known pattern.
//
// Patterns recognised (in order):
//   board-<n>-<uid>-thumbnail.png
//   board-<n>-<uid>-posterframe.(jpg|jpeg)
//   board-<n>-<uid>-<layer>.png            ← layer:<layer>
//   board-<n>-<uid>.png                    ← bare composited board
function parseLegacyFilename(filename) {
  // Strip any directory prefix
  const base = path.basename(filename);
  let m;

  m = base.match(/^board-(\d+)-([A-Z0-9]{5})-thumbnail\.png$/i);
  if (m) return { number: parseInt(m[1], 10), uid: m[2].toUpperCase(), kind: 'thumbnail' };

  m = base.match(/^board-(\d+)-([A-Z0-9]{5})-posterframe\.(jpg|jpeg)$/i);
  if (m) return { number: parseInt(m[1], 10), uid: m[2].toUpperCase(), kind: 'posterframe' };

  m = base.match(/^board-(\d+)-([A-Z0-9]{5})-([a-zA-Z0-9_-]+)\.png$/);
  if (m) return { number: parseInt(m[1], 10), uid: m[2].toUpperCase(), kind: 'layer:' + m[3] };

  m = base.match(/^board-(\d+)-([A-Z0-9]{5})\.png$/i);
  if (m) return { number: parseInt(m[1], 10), uid: m[2].toUpperCase(), kind: 'board' };

  return null;
}

function mimeForKind(kind) {
  if (kind === 'posterframe') return 'image/jpeg';
  return 'image/png';
}

// Given a row from `boards`, build the JSON shape main-window.js expects.
function rowToBoard(row) {
  const audio = row.audio ? safeParse(row.audio) : undefined;
  const meta = row.meta ? safeParse(row.meta) : null;

  // Compute the legacy `url` for the composited board PNG. Even if no
  // 'board' asset has been written yet, the client still expects this
  // field to be present.
  const url = legacyFilenameFor(row.number, row.uid, 'board');

  // Reconstruct board.layers from board_assets rows of kind 'layer:*'.
  const layers = {};
  const assets = stmts.listAssetsForBoard.all(row.uid);
  for (const a of assets) {
    if (!a.kind.startsWith('layer:')) continue;
    const layerName = a.kind.slice('layer:'.length);
    const layerMeta = a.meta ? safeParse(a.meta) : null;
    layers[layerName] = {
      url: legacyFilenameFor(row.number, row.uid, a.kind),
      ...(layerMeta || {}),
    };
  }

  const board = {
    uid: row.uid,
    url,
    newShot: !!row.new_shot,
    lastEdited: row.last_edited,
    number: row.number,
    shot: row.shot || `${row.number}A`,
    time: row.time_ms,
    duration: row.duration_ms,
    dialogue: row.dialogue || '',
    action: row.action || '',
    notes: row.notes || '',
    layers,
    // Monotonic integer bumped on every successful metadata update.
    // Used by agents as the expectedVersion for optimistic concurrency.
    version: row.version || 1,
  };
  if (audio) board.audio = audio;
  if (row.link) board.link = row.link;
  if (meta && typeof meta === 'object') Object.assign(board, meta);
  return board;
}

function rowToProject(row) {
  const meta = row.meta ? safeParse(row.meta) : null;
  const project = {
    version: row.version,
    aspectRatio: row.aspect_ratio,
    fps: row.fps,
    defaultBoardTiming: row.default_board_timing,
    boards: stmts.listBoardsForProject.all(row.id).map(rowToBoard),
  };
  if (meta && typeof meta === 'object') project.meta = meta;
  return project;
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// ── project CRUD ───────────────────────────────────────────────────────

async function createProject(opts = {}) {
  const id = uuidv4();
  const now = nowMs();
  // Owner defaults to the built-in default user so legacy code paths that
  // don't know about identity still work. Agent routes always pass a real
  // ownerId from req.agent.userId.
  const ownerId = opts.ownerId || '00000000-0000-0000-0000-000000000001';
  stmts.insertProject.run(
    id,
    opts.version || '0.6.0',
    opts.aspectRatio || 1.7777,
    opts.fps || 24,
    opts.defaultBoardTiming || 2000,
    null, // meta
    ownerId,
    now,
    now
  );
  const row = stmts.getProject.get(id);
  return { id, project: rowToProject(row) };
}

async function listProjectsByOwner(ownerId) {
  return stmts.listProjectsByOwner.all(ownerId).map(r => ({
    id: r.id,
    boardCount: r.board_count,
    aspectRatio: r.aspect_ratio,
    version: r.version,
    ownerId: r.owner_id,
    updatedAt: r.updated_at,
  }));
}

async function getProject(id) {
  const row = stmts.getProject.get(id);
  if (!row) return null;
  return { id, project: rowToProject(row) };
}

async function updateProject(id, updates = {}) {
  const existing = stmts.getProject.get(id);
  if (!existing) return null;

  // The legacy interface accepts updates.boards in some flows but ignores
  // them (per the previous file-based implementation comment). We do the
  // same — board mutations go through addBoard / updateBoard / etc.
  const meta = updates.meta != null
    ? (typeof updates.meta === 'string' ? updates.meta : JSON.stringify(updates.meta))
    : null;

  stmts.updateProjectFields.run(
    updates.version ?? null,
    updates.aspectRatio ?? null,
    updates.fps ?? null,
    updates.defaultBoardTiming ?? null,
    meta,
    nowMs(),
    id
  );

  return getProject(id);
}

async function deleteProject(id) {
  // Cascading delete cleans up boards and board_assets via FKs. Blobs
  // become orphans and can be GC'd by blobStore.gc() later.
  const result = stmts.deleteProject.run(id);
  return result.changes > 0;
}

async function listProjects() {
  return stmts.listProjects.all().map(r => ({
    id: r.id,
    boardCount: r.board_count,
    aspectRatio: r.aspect_ratio,
    version: r.version,
  }));
}

// ── board CRUD ─────────────────────────────────────────────────────────

async function addBoard(projectId, data = {}) {
  const project = stmts.getProject.get(projectId);
  if (!project) return null;

  // Pick a uid: caller-supplied if it's free, otherwise generate one.
  let uid = data.uid;
  if (uid && stmts.getBoard.get(uid)) uid = null;
  if (!uid) uid = generateUniqueBoardUid();

  const existingBoards = stmts.listBoardsForProject.all(projectId);
  const number = existingBoards.length + 1;
  const now = nowMs();

  const insertTx = db.transaction(() => {
    stmts.insertBoard.run(
      uid,
      projectId,
      number,
      data.newShot !== undefined ? (data.newShot ? 1 : 0) : (number === 1 ? 1 : 0),
      data.shot || `${number}A`,
      data.time != null ? data.time : 0,
      data.duration != null ? data.duration : (project.default_board_timing || 2000),
      data.dialogue || '',
      data.action || '',
      data.notes || '',
      data.audio ? JSON.stringify(data.audio) : null,
      data.link || null,
      null, // meta
      now
    );

    // Mark the project as touched
    stmts.updateProjectFields.run(null, null, null, null, null, now, projectId);

    // Recalculate cumulative times
    recalcTimes(projectId);
  });
  insertTx();

  // Synthesise blank PNGs for any layers the caller declared (or for the
  // composited board itself, if data.url is set). The sketch-pane sizes its
  // render targets from the first image it loads, so missing files trigger
  // verifyScene placeholder writes (which used to overwrite real drawings).
  // Pre-seeding the assets here makes existsSync(legacy filename) return
  // true on first load and avoids the placeholder branch entirely.
  const dim = dimensionsForAspect(project.aspect_ratio);
  const blank = blankPng(dim.width, dim.height);
  const blankResult = blobStore.put(blank, 'image/png');

  // Always seed the composited board image. Other code paths look for it.
  stmts.upsertAsset.run(uid, 'board', blankResult.hash, null, now);

  // Seed any layers the caller named
  if (data.layers && typeof data.layers === 'object') {
    for (const layerName of Object.keys(data.layers)) {
      const layer = data.layers[layerName];
      const layerMeta = (layer && typeof layer === 'object')
        ? Object.fromEntries(Object.entries(layer).filter(([k]) => k !== 'url'))
        : null;
      stmts.upsertAsset.run(
        uid,
        'layer:' + layerName,
        blankResult.hash,
        layerMeta && Object.keys(layerMeta).length ? JSON.stringify(layerMeta) : null,
        now
      );
    }
  }

  return rowToBoard(stmts.getBoard.get(uid));
}

/**
 * Update board metadata. Every successful update bumps the board's
 * `version` column so agents can use it for optimistic concurrency.
 *
 * options:
 *   expectedVersion   when set, the UPDATE includes a `version = ?`
 *                     guard. If the current version doesn't match,
 *                     this throws VERSION_MISMATCH with a .code and
 *                     .currentVersion set, and no changes are applied.
 *                     Agents should refetch and retry.
 */
async function updateBoard(projectId, boardUid, updates = {}) {
  const board = stmts.getBoard.get(boardUid);
  if (!board || board.project_id !== projectId) return null;

  const expectedVersion = updates.expectedVersion;
  // Strip expectedVersion from the update payload before prep-statement
  // binding — it's a control knob, not a column.
  const expects = (expectedVersion != null && Number.isInteger(expectedVersion));

  if (expects) {
    const result = stmts.updateBoardFieldsVersioned.run(
      updates.number ?? null,
      updates.newShot != null ? (updates.newShot ? 1 : 0) : null,
      updates.shot ?? null,
      updates.time ?? null,
      updates.duration ?? null,
      updates.dialogue ?? null,
      updates.action ?? null,
      updates.notes ?? null,
      updates.audio != null ? JSON.stringify(updates.audio) : null,
      updates.link ?? null,
      null, // meta
      nowMs(),
      boardUid,
      expectedVersion
    );
    if (result.changes === 0) {
      // Refetch current version to report it in the error
      const current = stmts.getBoard.get(boardUid);
      const err = new Error(
        `Board ${boardUid} version mismatch (expected ${expectedVersion}, current ${current.version})`
      );
      err.code = 'VERSION_MISMATCH';
      err.currentVersion = current.version;
      err.expectedVersion = expectedVersion;
      throw err;
    }
    // Touch the project updated_at
    stmts.updateProjectFields.run(null, null, null, null, null, nowMs(), projectId);
    return rowToBoard(stmts.getBoard.get(boardUid));
  }

  // Non-versioned path — kept for legacy clients that don't send expectedVersion
  stmts.updateBoardFields.run(
    updates.number ?? null,
    updates.newShot != null ? (updates.newShot ? 1 : 0) : null,
    updates.shot ?? null,
    updates.time ?? null,
    updates.duration ?? null,
    updates.dialogue ?? null,
    updates.action ?? null,
    updates.notes ?? null,
    updates.audio != null ? JSON.stringify(updates.audio) : null,
    updates.link ?? null,
    null, // meta
    nowMs(),
    boardUid
  );

  // Touch the project so updated_at reflects this change
  stmts.updateProjectFields.run(null, null, null, null, null, nowMs(), projectId);

  return rowToBoard(stmts.getBoard.get(boardUid));
}

async function deleteBoard(projectId, boardUid) {
  const board = stmts.getBoard.get(boardUid);
  if (!board) return null;
  if (board.project_id !== projectId) return false;

  const tx = db.transaction(() => {
    stmts.deleteBoard.run(boardUid);
    // Renumber the survivors
    const remaining = stmts.listBoardsForProject.all(projectId);
    remaining.forEach((b, i) => {
      stmts.setBoardNumber.run(i + 1, b.time_ms, b.uid);
    });
    recalcTimes(projectId);
    stmts.updateProjectFields.run(null, null, null, null, null, nowMs(), projectId);
  });
  tx();
  return true;
}

async function reorderBoards(projectId, uidOrder) {
  const project = stmts.getProject.get(projectId);
  if (!project) return null;

  const tx = db.transaction(() => {
    // Resolve the new order; append any uids not mentioned (defensive)
    const existing = stmts.listBoardsForProject.all(projectId);
    const byUid = new Map(existing.map(b => [b.uid, b]));
    const ordered = [];
    for (const u of uidOrder) {
      const b = byUid.get(u);
      if (b) {
        ordered.push(b);
        byUid.delete(u);
      }
    }
    for (const b of byUid.values()) ordered.push(b);

    ordered.forEach((b, i) => {
      stmts.setBoardNumber.run(i + 1, b.time_ms, b.uid);
    });
    recalcTimes(projectId);
    stmts.updateProjectFields.run(null, null, null, null, null, nowMs(), projectId);
  });
  tx();

  return stmts.listBoardsForProject.all(projectId).map(rowToBoard);
}

function recalcTimes(projectId) {
  const project = stmts.getProject.get(projectId);
  if (!project) return;
  const defaultTiming = project.default_board_timing || 2000;
  const boards = stmts.listBoardsForProject.all(projectId);
  let acc = 0;
  for (const b of boards) {
    if (b.time_ms !== acc) {
      stmts.setBoardNumber.run(b.number, acc, b.uid);
    }
    acc += b.duration_ms || defaultTiming;
  }
}

// ── project.storyboarder JSON ↔ SQLite sync ────────────────────────────

/**
 * Serialize a project + its boards from SQLite into the legacy
 * project.storyboarder JSON shape that main-window.js expects when it does
 *   fs.readFileSync('/web/projects/<uuid>/project.storyboarder')
 *
 * Returns a string (JSON-encoded). Returns null if the project doesn't
 * exist.
 */
function serializeProjectAsLegacyJson(projectId) {
  const row = stmts.getProject.get(projectId);
  if (!row) return null;
  return JSON.stringify(rowToProject(row), null, 2);
}

/**
 * Sync a project + its boards FROM a legacy project.storyboarder JSON
 * payload INTO SQLite. Used by the fs-api POST /write handler when the
 * client (main-window.js) writes the project file as part of its normal
 * "save board state" flow.
 *
 * This is the bridge that lets client-side board mutations (add board,
 * delete board, edit dialogue, etc.) propagate into SQLite without having
 * to rewrite main-window.js to use the proper REST API. The JSON file
 * effectively becomes a command channel:
 *
 *   client mutates boardData → writes JSON → server parses → upserts SQLite
 *
 * Behavior:
 *   - Project columns (aspect_ratio, fps, default_board_timing, version)
 *     are updated to match the JSON
 *   - Boards present in the JSON are inserted (if new) or updated (if known)
 *   - Boards present in SQLite but absent from the JSON are DELETED
 *     (cascading to their board_assets) — this is how client-side
 *     deletions propagate
 *   - board_assets are NOT touched here. The client writes asset bytes
 *     through separate POST /api/fs/write calls, which storeLegacyAsset
 *     handles. Layer .url filenames in the JSON are derivable from
 *     (board.number, board.uid, layer name) and are recomputed on read.
 *
 * Throws if the project ID isn't a real project. Returns the updated
 * project row count info { boardsCreated, boardsUpdated, boardsDeleted }.
 */
function syncFromProjectFile(projectId, projectJson) {
  if (!projectJson || typeof projectJson !== 'object') {
    throw Object.assign(new Error('syncFromProjectFile: payload is not an object'), {
      code: 'BAD_PAYLOAD',
    });
  }
  if (!Array.isArray(projectJson.boards)) {
    throw Object.assign(new Error('syncFromProjectFile: missing boards array'), {
      code: 'BAD_PAYLOAD',
    });
  }

  const stats = { boardsCreated: 0, boardsUpdated: 0, boardsDeleted: 0 };
  const now = nowMs();

  const tx = db.transaction(() => {
    // Upsert the project row. INSERT first; on conflict update the columns
    // we care about. We don't use INSERT OR REPLACE because that would
    // cascade-delete boards via the FK.
    const existing = stmts.getProject.get(projectId);
    if (!existing) {
      stmts.insertProject.run(
        projectId,
        projectJson.version || '0.6.0',
        projectJson.aspectRatio != null ? projectJson.aspectRatio : 1.7777,
        projectJson.fps != null ? projectJson.fps : 24,
        projectJson.defaultBoardTiming != null ? projectJson.defaultBoardTiming : 2000,
        null,
        now,
        now
      );
    } else {
      stmts.updateProjectFields.run(
        projectJson.version || null,
        projectJson.aspectRatio != null ? projectJson.aspectRatio : null,
        projectJson.fps != null ? projectJson.fps : null,
        projectJson.defaultBoardTiming != null ? projectJson.defaultBoardTiming : null,
        null,
        now,
        projectId
      );
    }

    // Phase 1: push every existing board's `number` into a safe temporary
    // range so subsequent upserts don't hit the UNIQUE(project_id, number)
    // constraint mid-loop.
    //
    // Without this, a reorder that swaps two boards' numbers (A#1↔B#2) or
    // a delete that renumbers survivors (delete A#1 → B goes from #2 to #1,
    // but A still has #1 until its own DELETE fires) crashes the
    // transaction with SQLITE_CONSTRAINT_UNIQUE, leaving SQLite unchanged
    // and making the UI appear to revert on the next refresh.
    //
    // We stash existing numbers as `-(number + 1_000_000)`. Negative values
    // are outside the legal range the client ever produces, so they
    // cannot collide with each other OR with any positive number the JSON
    // is about to assign. After the upserts run, every board either has
    // its new positive number or is still in the temporary range (which
    // means it's a ghost we'll delete in phase 3).
    const existingForRenumber = stmts.listBoardsForProject.all(projectId);
    const NUMBER_PARK_OFFSET = 1000000;
    for (const b of existingForRenumber) {
      stmts.setBoardNumber.run(-(b.number + NUMBER_PARK_OFFSET), b.time_ms, b.uid);
    }

    // Phase 2: upsert each board from the JSON. We track which uids appear
    // so we can delete the leftovers afterwards.
    const seenUids = new Set();
    for (const board of projectJson.boards) {
      if (!board || !board.uid) continue;
      seenUids.add(board.uid);

      // Anything that doesn't map to a column gets stashed in meta JSON so
      // it round-trips through subsequent reads.
      const knownKeys = new Set([
        'uid', 'url', 'newShot', 'lastEdited', 'number', 'shot', 'time',
        'duration', 'dialogue', 'action', 'notes', 'audio', 'link', 'layers',
      ]);
      const extraMeta = {};
      for (const k of Object.keys(board)) {
        if (!knownKeys.has(k)) extraMeta[k] = board[k];
      }
      const metaJson = Object.keys(extraMeta).length
        ? JSON.stringify(extraMeta)
        : null;

      const existingBoard = stmts.getBoard.get(board.uid);
      if (!existingBoard) {
        stmts.insertBoard.run(
          board.uid,
          projectId,
          board.number || (seenUids.size),
          board.newShot ? 1 : 0,
          board.shot || `${board.number || seenUids.size}A`,
          board.time != null ? board.time : 0,
          board.duration != null ? board.duration : (projectJson.defaultBoardTiming || 2000),
          board.dialogue || '',
          board.action || '',
          board.notes || '',
          board.audio ? JSON.stringify(board.audio) : null,
          board.link || null,
          metaJson,
          board.lastEdited || now
        );
        stats.boardsCreated++;
      } else {
        // Defensive: if a board was somehow registered under a different
        // project, we don't quietly steal it.
        if (existingBoard.project_id !== projectId) {
          throw Object.assign(
            new Error(`Board ${board.uid} belongs to a different project`),
            { code: 'WRONG_PROJECT' }
          );
        }
        stmts.updateBoardFields.run(
          board.number != null ? board.number : null,
          board.newShot != null ? (board.newShot ? 1 : 0) : null,
          board.shot != null ? board.shot : null,
          board.time != null ? board.time : null,
          board.duration != null ? board.duration : null,
          board.dialogue != null ? board.dialogue : null,
          board.action != null ? board.action : null,
          board.notes != null ? board.notes : null,
          board.audio != null ? JSON.stringify(board.audio) : null,
          board.link != null ? board.link : null,
          metaJson,
          board.lastEdited || now,
          board.uid
        );
        stats.boardsUpdated++;
      }
    }

    // Delete boards that exist in SQLite but aren't in the new JSON. This
    // is how client-side board deletions propagate. board_assets cascade.
    const allBoards = stmts.listBoardsForProject.all(projectId);
    for (const b of allBoards) {
      if (!seenUids.has(b.uid)) {
        stmts.deleteBoard.run(b.uid);
        stats.boardsDeleted++;
      }
    }

    // Touch the project so updated_at reflects the sync
    stmts.updateProjectFields.run(null, null, null, null, null, now, projectId);
  });
  tx();

  return stats;
}

// ── legacy filename ↔ blob translation (used by fs-api) ────────────────

/**
 * List every asset filename that exists for a project. Used by
 * /api/projects/:id/files so the web-bootstrap can prefetch the existsSync
 * cache and stop verifyScene from writing blank placeholders on every page
 * refresh.
 */
function listBoardAssets(projectId) {
  const rows = stmts.listAssetsForProject.all(projectId);
  return rows.map(r => ({
    boardUid: r.board_uid,
    boardNumber: r.board_number,
    kind: r.kind,
    filename: legacyFilenameFor(r.board_number, r.board_uid, r.kind),
    hash: r.blob_hash,
    size: r.byte_size,
    mime: r.mime_type,
    updatedAt: r.updated_at,
  }));
}

/**
 * Resolve a legacy filename to the blob it currently points at.
 * Returns null if the filename doesn't parse, the board doesn't exist,
 * or no asset of that kind has been written yet.
 */
function resolveLegacyAsset(projectId, filename) {
  const parsed = parseLegacyFilename(filename);
  if (!parsed) return null;

  // The board uid is globally unique, but verify it lives in the right
  // project so callers can't read across projects.
  const board = stmts.getBoard.get(parsed.uid);
  if (!board || board.project_id !== projectId) return null;
  if (board.number !== parsed.number) {
    // Filename's number is stale (board was renumbered). Still serve the
    // current asset for the board — clients should refetch the project
    // metadata to discover the new number.
  }

  const asset = stmts.getAsset.get(parsed.uid, parsed.kind);
  if (!asset) return null;

  return {
    hash: asset.blob_hash,
    mime: asset.mime_type,
    size: asset.byte_size,
    kind: asset.kind,
    boardUid: parsed.uid,
    updatedAt: asset.updated_at,
  };
}

/**
 * Store a write to a legacy filename. Hashes the bytes, puts them in the
 * blob store, upserts the board_assets row, and returns the new hash.
 *
 * Throws if the filename can't be parsed or the board doesn't belong to
 * the project — those are programmer errors, not user input we should
 * silently swallow.
 */
function storeLegacyAsset(projectId, filename, bytes) {
  const parsed = parseLegacyFilename(filename);
  if (!parsed) {
    const err = new Error(`Cannot parse legacy filename: ${filename}`);
    err.code = 'BAD_FILENAME';
    throw err;
  }
  const board = stmts.getBoard.get(parsed.uid);
  if (!board) {
    const err = new Error(`No board with uid ${parsed.uid}`);
    err.code = 'NO_BOARD';
    throw err;
  }
  if (board.project_id !== projectId) {
    const err = new Error(`Board ${parsed.uid} does not belong to project ${projectId}`);
    err.code = 'WRONG_PROJECT';
    throw err;
  }

  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const result = blobStore.put(buf, mimeForKind(parsed.kind));

  const now = nowMs();
  stmts.upsertAsset.run(parsed.uid, parsed.kind, result.hash, null, now);

  // Touch the board's last_edited WITHOUT bumping version — asset writes
  // are independent of metadata edits and shouldn't invalidate a
  // concurrent agent's in-flight expectedVersion.
  stmts.touchBoardEdited.run(now, parsed.uid);
  stmts.updateProjectFields.run(null, null, null, null, null, now, projectId);

  return { hash: result.hash, kind: parsed.kind, boardUid: parsed.uid };
}

/**
 * Direct asset writer — no legacy filename parsing. Used by agent routes
 * that know the target (projectId, boardUid, kind) explicitly, e.g. audio
 * uploads and image-gen results. Mime type is caller-supplied (image/png,
 * audio/mpeg, etc) because kind alone doesn't disambiguate audio formats.
 *
 * Optional meta is stored as JSON on the asset row (useful for e.g.
 * { duration: 3200, voice: '...', source: 'elevenlabs' } on audio assets).
 */
function storeBoardAsset(projectId, boardUid, kind, bytes, mime, meta = null) {
  if (!kind || typeof kind !== 'string') {
    throw Object.assign(new Error('storeBoardAsset: kind required'), { code: 'BAD_KIND' });
  }
  const board = stmts.getBoard.get(boardUid);
  if (!board) {
    throw Object.assign(new Error(`No board with uid ${boardUid}`), { code: 'NO_BOARD' });
  }
  if (board.project_id !== projectId) {
    throw Object.assign(
      new Error(`Board ${boardUid} does not belong to project ${projectId}`),
      { code: 'WRONG_PROJECT' }
    );
  }

  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const result = blobStore.put(buf, mime || 'application/octet-stream');

  const now = nowMs();
  const metaJson = meta && typeof meta === 'object' ? JSON.stringify(meta) : null;
  stmts.upsertAsset.run(boardUid, kind, result.hash, metaJson, now);
  // Touch last_edited without bumping version (see storeLegacyAsset).
  stmts.touchBoardEdited.run(now, boardUid);
  stmts.updateProjectFields.run(null, null, null, null, null, now, projectId);

  return {
    hash: result.hash,
    size: result.size,
    kind,
    boardUid,
    mime: mime || 'application/octet-stream',
  };
}

/**
 * Look up a single asset for (boardUid, kind) → { hash, mime, size, meta }
 * or null. Used by agent GET routes that want a direct asset lookup without
 * going through the legacy filename parser.
 */
function getBoardAsset(projectId, boardUid, kind) {
  const board = stmts.getBoard.get(boardUid);
  if (!board || board.project_id !== projectId) return null;
  const row = stmts.getAsset.get(boardUid, kind);
  if (!row) return null;
  return {
    hash: row.blob_hash,
    mime: row.mime_type,
    size: row.byte_size,
    kind: row.kind,
    boardUid,
    meta: row.meta ? safeParse(row.meta) : null,
    updatedAt: row.updated_at,
  };
}

// ── legacy path helpers (kept for backwards compat) ────────────────────

function getProjectDir(id) {
  // Legacy interface — used to point at web-server/data/projects/<id>/.
  // Returns the same path so old export.js / files.js logic doesn't crash,
  // but nothing actually lives there anymore. Callers that try to read
  // from this path will get ENOENT, which is the correct signal that
  // the file-based store is gone.
  return path.join(PROJECTS_DIR, sanitize(id));
}

function getImagesDir(id) {
  return path.join(getProjectDir(id), 'images');
}

module.exports = {
  // CRUD (existing interface — kept stable)
  createProject,
  getProject,
  updateProject,
  deleteProject,
  listProjects,
  listProjectsByOwner,
  addBoard,
  updateBoard,
  deleteBoard,
  reorderBoards,
  getProjectDir,
  getImagesDir,
  generateBoardUid,
  sanitize,
  DATA_DIR,
  PROJECTS_DIR,

  // New interface for the legacy filename ↔ blob bridge
  listBoardAssets,
  resolveLegacyAsset,
  storeLegacyAsset,
  parseLegacyFilename,
  legacyFilenameFor,

  // Direct asset access for agent routes
  storeBoardAsset,
  getBoardAsset,

  // project.storyboarder JSON ↔ SQLite sync
  syncFromProjectFile,
  serializeProjectAsLegacyJson,
};
