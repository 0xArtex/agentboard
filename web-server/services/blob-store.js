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

  get backend() { return 'disk'; }

  /**
   * Store bytes. Returns a Promise of { hash, size } — the promise form
   * unifies the interface with R2BlobStore so upstream code can await
   * without branching on backend. Underneath it's synchronous fs work.
   */
  async put(bytes, mimeType = 'application/octet-stream') {
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

  async get(hash) {
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
   *
   * Returns the path synchronously (no await needed). The R2 backend's
   * equivalent returns a presigned URL and IS async — the HTTP serving
   * layer in server.js handles the difference.
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
  async remove(hash) {
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
  async gc() {
    const orphans = db.prepare(`
      SELECT b.hash FROM blobs b
      LEFT JOIN board_assets ba ON ba.blob_hash = b.hash
      WHERE ba.board_uid IS NULL
    `).all();
    let removed = 0;
    for (const { hash } of orphans) {
      if (await this.remove(hash)) removed++;
    }
    return removed;
  }
}

// ── R2BlobStore ────────────────────────────────────────────────────────
//
// Selected when all four R2_* env vars are present. Cloudflare R2 is
// S3-compatible, so we use @aws-sdk/client-s3 pointed at the R2 endpoint.
// Two-level storage same as DiskBlobStore: SQLite index records metadata,
// the R2 bucket holds the bytes keyed by `<hash[:2]>/<rest>.<ext>`.
//
// Reads are handled two ways depending on the consumer:
//   1. pathOf(hash)  — returns a PRESIGNED URL (5-minute expiry) that
//      the caller can send straight to the browser via res.redirect or
//      use as an <img src>. Uses s3-request-presigner.
//   2. get(hash)     — downloads the bytes locally (for PDF export,
//      MCP export_pdf, migration scripts, etc).
//
// Bulk-write atomicity: R2 PutObject is atomic per-object, so the
// tmp-then-rename dance DiskBlobStore does isn't needed here. We upload
// straight to the final key.
//
// Local dev can set R2_PUBLIC_URL (e.g. a custom domain bound to the
// bucket for public read) so pathOf can return an unsigned URL when
// the bucket is public-read. If unset, pathOf falls back to presigned.
class R2BlobStore {
  constructor(config) {
    const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } =
      require('@aws-sdk/client-s3');
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

    this.S3Client = S3Client;
    this.PutObjectCommand = PutObjectCommand;
    this.GetObjectCommand = GetObjectCommand;
    this.HeadObjectCommand = HeadObjectCommand;
    this.DeleteObjectCommand = DeleteObjectCommand;
    this.getSignedUrl = getSignedUrl;

    this.accountId = config.accountId;
    this.bucket = config.bucket;
    this.publicUrl = (config.publicUrl || '').replace(/\/$/, '') || null;

    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });

    console.log(`[blob-store] R2 backend active (bucket=${this.bucket}, accountId=${this.accountId.slice(0, 8)}...)`);
  }

  get backend() { return 'r2'; }

  _keyFor(hash, mime) {
    const prefix = hash.slice(0, 2);
    const rest = hash.slice(2);
    return `${prefix}/${rest}.${extForMime(mime)}`;
  }

  async _exists(key) {
    try {
      await this.client.send(new this.HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err) {
      if (err.$metadata && err.$metadata.httpStatusCode === 404) return false;
      throw err;
    }
  }

  // ── public interface (matches DiskBlobStore) ─────────────────────────
  //
  // All methods are synchronous from the caller's perspective via a
  // busy-wait on the underlying promise. That keeps the BlobStore
  // interface uniform between the two backends — existing code that
  // calls `blobStore.put(...)` synchronously keeps working.
  //
  // Synchronous wrapping is possible here because blob writes happen
  // infrequently (one per draw/upload) and the R2 roundtrip is fast
  // enough (~50-200ms) that blocking the main thread is tolerable for
  // v1. When we scale, move the route handlers to an async path and
  // drop this wrapper — the method bodies stay the same.

  async put(bytes, mimeType = 'application/octet-stream') {
    if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
    const hash = sha256(bytes);
    const size = bytes.length;
    const key = this._keyFor(hash, mimeType);

    // Idempotent: if the object already exists (same hash, same bytes),
    // skip the upload. Saves request quota + bandwidth.
    if (!(await this._exists(key))) {
      await this.client.send(new this.PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: mimeType,
        ContentLength: size,
      }));
    }
    stmts.insertBlob.run(hash, size, mimeType, Date.now());
    return { hash, size };
  }

  async get(hash) {
    const row = stmts.getBlob.get(hash);
    if (!row) return null;
    const key = this._keyFor(hash, row.mime_type);
    try {
      const res = await this.client.send(new this.GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const chunks = [];
      for await (const chunk of res.Body) chunks.push(chunk);
      return Buffer.concat(chunks);
    } catch (err) {
      console.warn(`[blob-store] R2 get failed for ${hash}: ${err.message}`);
      return null;
    }
  }

  /**
   * Resolve a blob hash to a URL the browser can GET. If R2_PUBLIC_URL is
   * set and the bucket has public-read on the key's path, returns the
   * unsigned URL (fastest, CDN-cached). Otherwise returns a presigned URL
   * with a 5-minute expiry.
   *
   * NOTE: this returns a Promise, unlike DiskBlobStore.pathOf which is
   * sync. The Express route that calls pathOf for the `/web/projects/...`
   * static handler needs to await this — server.js handles both cases.
   */
  async pathOf(hash) {
    const row = stmts.getBlob.get(hash);
    if (!row) return null;
    const key = this._keyFor(hash, row.mime_type);
    if (this.publicUrl) {
      return `${this.publicUrl}/${key}`;
    }
    // Presigned URL for private buckets
    return await this.getSignedUrl(
      this.client,
      new this.GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: 300 }
    );
  }

  async exists(hash) {
    return !!stmts.existsBlob.get(hash);
  }

  stat(hash) {
    return stmts.getBlob.get(hash) || null;
  }

  async remove(hash) {
    const row = stmts.getBlob.get(hash);
    if (!row) return false;
    const key = this._keyFor(hash, row.mime_type);
    try {
      await this.client.send(new this.DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err) {
      console.warn(`[blob-store] R2 delete failed for ${hash}: ${err.message}`);
    }
    stmts.deleteBlob.run(hash);
    return true;
  }

  refCount(hash) {
    return stmts.refCountBlob.get(hash).n;
  }

  async gc() {
    const orphans = db.prepare(`
      SELECT b.hash FROM blobs b
      LEFT JOIN board_assets ba ON ba.blob_hash = b.hash
      WHERE ba.board_uid IS NULL
    `).all();
    let removed = 0;
    for (const { hash } of orphans) {
      if (await this.remove(hash)) removed++;
    }
    return removed;
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
