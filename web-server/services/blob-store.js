/**
 * blob-store.js — content-addressed binary storage
 *
 * Every layer PNG, posterframe JPG, and thumbnail in AgentBoard is stored as
 * an immutable blob keyed by SHA-256. The mapping from "what blob backs which
 * board's fill layer right now" lives in the SQLite `board_assets` table; the
 * actual bytes live wherever this BlobStore decides to put them.
 *
 * The interface exposes:
 *
 *   put(bytes, mimeType?)  -> { hash, size }
 *      Hashes the bytes, stores them if not already present, records a row
 *      in the `blobs` table, and returns the hash.
 *
 *   get(hash)              -> Buffer | null
 *      Reads bytes back. Returns null if the blob is missing.
 *
 *   exists(hash)           -> boolean
 *      Cheap existence check (consults the SQLite index, not the disk).
 *
 *   stream(hash, res)      -> void
 *      Streams the bytes directly to an HTTP response. Used by the
 *      legacy-path-to-blob translation in fs-api so we don't double-copy
 *      large blobs through Node Buffers.
 *
 *   remove(hash)           -> boolean
 *      Deletes the blob from storage and the index. Returns true if removed.
 *
 * Two implementations:
 *
 *   DiskBlobStore  — writes to web-server/data/blobs/<aa>/<bbcc...>.<ext>.
 *                    The 2-char prefix splits files across 256 directories
 *                    so no single dir grows unbounded. Used in dev and as
 *                    the default if no R2 env vars are set.
 *
 *   R2BlobStore    — stub for production. Selected automatically when the
 *                    R2_* env vars are present (see NOTES.local.md). Not
 *                    implemented yet because we don't deploy until Phase 4.
 *
 * Both implementations share the same SQLite-backed metadata, so swapping
 * the backend later doesn't require any data migration — only re-uploading
 * the actual blob bytes.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { db } = require('./db');

const BLOBS_DIR = path.join(__dirname, '..', 'data', 'blobs');

// ── prepared statements ────────────────────────────────────────────────
const stmts = {
  insertBlob: db.prepare(`
    INSERT INTO blobs (hash, byte_size, mime_type, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(hash) DO NOTHING
  `),
  getBlob: db.prepare('SELECT hash, byte_size, mime_type FROM blobs WHERE hash = ?'),
  existsBlob: db.prepare('SELECT 1 FROM blobs WHERE hash = ?'),
  deleteBlob: db.prepare('DELETE FROM blobs WHERE hash = ?'),
  refCountBlob: db.prepare('SELECT COUNT(*) AS n FROM board_assets WHERE blob_hash = ?'),
};

// ── DiskBlobStore ──────────────────────────────────────────────────────
function extForMime(mime) {
  if (!mime) return 'bin';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  return 'bin';
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function pathForHash(hash, mime) {
  // 2-char prefix shards prevent any single directory from growing past
  // a few thousand files. Important for filesystem performance on ext4/NTFS.
  const prefix = hash.slice(0, 2);
  const rest = hash.slice(2);
  return path.join(BLOBS_DIR, prefix, `${rest}.${extForMime(mime)}`);
}

class DiskBlobStore {
  constructor() {
    fs.mkdirSync(BLOBS_DIR, { recursive: true });
  }

  /**
   * Store bytes. Returns { hash, size } whether or not the blob already
   * existed — callers should treat this as idempotent.
   */
  put(bytes, mimeType = 'application/octet-stream') {
    if (!Buffer.isBuffer(bytes)) {
      bytes = Buffer.from(bytes);
    }
    const hash = sha256(bytes);
    const size = bytes.length;
    const fp = pathForHash(hash, mimeType);

    if (!fs.existsSync(fp)) {
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      // Atomic-ish write: temp file then rename. On the same filesystem
      // rename is atomic, so a concurrent reader never sees a half-written
      // file.
      const tmp = fp + '.tmp-' + process.pid + '-' + Date.now();
      fs.writeFileSync(tmp, bytes);
      fs.renameSync(tmp, fp);
    }

    stmts.insertBlob.run(hash, size, mimeType, Date.now());
    return { hash, size };
  }

  get(hash) {
    const row = stmts.getBlob.get(hash);
    if (!row) return null;
    const fp = pathForHash(hash, row.mime_type);
    if (!fs.existsSync(fp)) {
      // Index says it should exist but the file is missing — surface this
      // loudly because it means the disk and DB have drifted.
      console.warn(`[blob-store] index hit but file missing: ${hash}`);
      return null;
    }
    return fs.readFileSync(fp);
  }

  /**
   * Resolve the on-disk path for a blob without reading the bytes. Used by
   * the HTTP layer for `res.sendFile()` so Express can stream the file
   * directly without buffering through Node.
   */
  pathOf(hash) {
    const row = stmts.getBlob.get(hash);
    if (!row) return null;
    const fp = pathForHash(hash, row.mime_type);
    return fs.existsSync(fp) ? fp : null;
  }

  exists(hash) {
    return !!stmts.existsBlob.get(hash);
  }

  stat(hash) {
    return stmts.getBlob.get(hash) || null;
  }

  /**
   * Delete a blob unconditionally. Callers should normally check the ref
   * count first via refCount() — see DiskBlobStore.gc().
   */
  remove(hash) {
    const row = stmts.getBlob.get(hash);
    if (!row) return false;
    const fp = pathForHash(hash, row.mime_type);
    try { fs.unlinkSync(fp); } catch (err) { /* missing file is OK */ }
    stmts.deleteBlob.run(hash);
    return true;
  }

  /**
   * How many board_assets rows currently point at this blob. A blob with
   * refCount === 0 is orphaned and safe to remove.
   */
  refCount(hash) {
    return stmts.refCountBlob.get(hash).n;
  }

  /**
   * Sweep orphaned blobs (refCount === 0). Call occasionally — not on every
   * write, since that would make deletes O(n) in the blob count.
   */
  gc() {
    const orphans = db.prepare(`
      SELECT b.hash FROM blobs b
      LEFT JOIN board_assets ba ON ba.blob_hash = b.hash
      WHERE ba.board_uid IS NULL
    `).all();
    let removed = 0;
    for (const { hash } of orphans) {
      if (this.remove(hash)) removed++;
    }
    return removed;
  }
}

// ── R2BlobStore (stub) ─────────────────────────────────────────────────
// Selected when R2_ACCOUNT_ID + R2_BUCKET + R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY
// are all set. Not implemented yet. See NOTES.local.md for the deploy plan.
class R2BlobStore {
  constructor(_config) {
    throw new Error('R2BlobStore not implemented yet — see NOTES.local.md');
  }
}

// ── factory ────────────────────────────────────────────────────────────
function createBlobStore() {
  const r2 = {
    accountId: process.env.R2_ACCOUNT_ID,
    bucket: process.env.R2_BUCKET,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  };
  if (r2.accountId && r2.bucket && r2.accessKeyId && r2.secretAccessKey) {
    return new R2BlobStore(r2);
  }
  return new DiskBlobStore();
}

const blobStore = createBlobStore();

module.exports = { blobStore, DiskBlobStore, R2BlobStore, createBlobStore, BLOBS_DIR };
