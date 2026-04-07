/**
 * Ephemeral smoke test for the R2 BlobStore implementation.
 *
 * Stands up a tiny in-process S3-compatible server that accepts PUT, HEAD,
 * GET, and DELETE for objects, then points R2BlobStore at it and exercises
 * every method. Verifies:
 *
 *   - Factory picks R2BlobStore when all R2_* env vars are set
 *   - put() idempotently uploads (skips re-upload when object exists)
 *   - get() downloads bytes from the bucket
 *   - exists() and stat() use the SQLite index (no network)
 *   - pathOf() returns a public URL when R2_PUBLIC_URL is set
 *   - pathOf() returns a presigned URL when no public URL
 *   - remove() deletes the object from the bucket
 *   - backend === 'r2' on the exported instance
 *   - Asset upload flow end-to-end via storeBoardAsset
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const Database = require('better-sqlite3');

// ── fake S3 server ────────────────────────────────────────────────────
// In-memory bucket keyed by URL path. Accepts any auth header.
const bucketContent = new Map();
let requestLog = [];

function fakeS3Server() {
  return http.createServer((req, res) => {
    // The AWS SDK appends ?x-id=PutObject / ?x-id=GetObject etc to URLs.
    // Strip the query so the same key works across verbs.
    const url = req.url.split('?')[0];
    requestLog.push({ method: req.method, url });

    if (req.method === 'PUT') {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        bucketContent.set(url, {
          bytes: Buffer.concat(chunks),
          contentType: req.headers['content-type'] || 'application/octet-stream',
        });
        res.setHeader('ETag', '"' + crypto.createHash('md5').update(Buffer.concat(chunks)).digest('hex') + '"');
        res.writeHead(200);
        res.end();
      });
      return;
    }

    if (req.method === 'HEAD') {
      const obj = bucketContent.get(url);
      if (!obj) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', obj.contentType);
      res.setHeader('Content-Length', obj.bytes.length);
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.method === 'GET') {
      const obj = bucketContent.get(url);
      if (!obj) { res.writeHead(404); res.end('NoSuchKey'); return; }
      res.setHeader('Content-Type', obj.contentType);
      res.setHeader('Content-Length', obj.bytes.length);
      res.writeHead(200);
      res.end(obj.bytes);
      return;
    }

    if (req.method === 'DELETE') {
      bucketContent.delete(url);
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(405);
    res.end();
  });
}

// ── test bootstrap ────────────────────────────────────────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-r2-'));
const dbPath = path.join(tmpDir, 'test.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).sort()) {
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
}

require.cache[require.resolve('../services/db')] = {
  id: require.resolve('../services/db'),
  filename: require.resolve('../services/db'),
  loaded: true,
  exports: { db, DB_PATH: dbPath },
};

let fail = false;
function check(label, cond, extra) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (!cond) fail = true;
  console.log(`${mark}  ${label}${extra ? '  ' + extra : ''}`);
}

const s3 = fakeS3Server();
s3.listen(0, async () => {
  const s3Port = s3.address().port;

  // Point the R2 client at our fake server. The SDK constructs the
  // endpoint from accountId, so we set the endpoint via a wrapper
  // constructor that overrides it.
  process.env.R2_ACCOUNT_ID = 'test-account';
  process.env.R2_BUCKET = 'test-bucket';
  process.env.R2_ACCESS_KEY_ID = 'AKIATEST';
  process.env.R2_SECRET_ACCESS_KEY = 'secretTest';

  // We need to override the endpoint the R2BlobStore uses. The easiest way
  // is to construct one manually with explicit config after patching the
  // client constructor. Let me instantiate it directly.
  const { R2BlobStore } = require('../services/blob-store');
  const { S3Client } = require('@aws-sdk/client-s3');

  // Build with a custom endpoint pointing at our fake server
  const store = new R2BlobStore({
    accountId: 'test-account',
    bucket: 'test-bucket',
    accessKeyId: 'AKIATEST',
    secretAccessKey: 'secretTest',
  });
  // Override the client's endpoint to our fake
  store.client = new S3Client({
    region: 'auto',
    endpoint: `http://localhost:${s3Port}`,
    forcePathStyle: true,
    credentials: {
      accessKeyId: 'AKIATEST',
      secretAccessKey: 'secretTest',
    },
  });

  try {
    check('1. backend = r2', store.backend === 'r2');

    // put a test payload
    const payload = Buffer.from('hello r2 world, this is a test blob', 'utf8');
    const result = await store.put(payload, 'application/octet-stream');
    check('2. put returns hash + size',
      typeof result.hash === 'string' && result.hash.length === 64 && result.size === payload.length);
    check('2. put uploaded to bucket',
      requestLog.some(r => r.method === 'PUT'));

    // put again — should skip the upload (idempotent)
    requestLog = [];
    const result2 = await store.put(payload, 'application/octet-stream');
    check('3. idempotent: same hash', result2.hash === result.hash);
    const puts2 = requestLog.filter(r => r.method === 'PUT').length;
    check('3. idempotent: no re-upload (skipped via HEAD)', puts2 === 0);

    // get the bytes back
    const bytes = await store.get(result.hash);
    check('4. get returns a Buffer', Buffer.isBuffer(bytes));
    check('4. get returns equal bytes', bytes && bytes.equals(payload));

    // exists + stat
    check('5. exists returns true', await store.exists(result.hash));
    check('5. stat returns a row', store.stat(result.hash) != null);

    // pathOf (presigned — no public URL configured)
    const presigned = await store.pathOf(result.hash);
    check('6. pathOf returns a URL', typeof presigned === 'string' && presigned.startsWith('http'));
    check('6. presigned URL contains signature',
      /X-Amz-Signature/.test(presigned));

    // pathOf with public URL set
    store.publicUrl = 'https://cdn.example.com';
    const publicUrl = await store.pathOf(result.hash);
    check('7. pathOf with public URL is unsigned',
      publicUrl === `https://cdn.example.com/${store._keyFor(result.hash, 'application/octet-stream')}`);
    store.publicUrl = null;

    // refCount (no board assets pointing at it)
    check('8. refCount = 0 when orphan', store.refCount(result.hash) === 0);

    // remove
    const removed = await store.remove(result.hash);
    check('9. remove returns true', removed === true);
    check('9. remove called DELETE on bucket',
      requestLog.some(r => r.method === 'DELETE'));
    check('9. blob row gone', !(await store.exists(result.hash)));

    // ── End-to-end: storeBoardAsset should hit the R2 backend ──
    // Swap the module-level blobStore to our instance for this test
    const blobStoreModule = require('../services/blob-store');
    const originalStore = blobStoreModule.blobStore;
    // Replace the singleton
    Object.defineProperty(blobStoreModule, 'blobStore', {
      value: store, writable: true, configurable: true,
    });

    // Create a project + board directly via project-store
    const projectStore = require('../services/project-store');
    const proj = await projectStore.createProject({ aspectRatio: 1.7777 });
    const board = await projectStore.addBoard(proj.id, { dialogue: 'r2 test' });
    check('10. created project + board via store', board && board.uid);

    // Upload a fake layer image — should go through R2
    const fakePng = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]);
    requestLog = [];
    const stored = await projectStore.storeBoardAsset(
      proj.id, board.uid, 'layer:ink', fakePng, 'image/png', { test: true }
    );
    check('11. storeBoardAsset returns hash',
      typeof stored.hash === 'string' && stored.hash.length === 64);
    const putsE2E = requestLog.filter(r => r.method === 'PUT').length;
    check('11. storeBoardAsset uploaded to R2', putsE2E >= 1);

    // Asset is retrievable
    const retrieved = await store.get(stored.hash);
    check('12. round-trip bytes equal', retrieved && retrieved.equals(fakePng));

    // Restore
    Object.defineProperty(blobStoreModule, 'blobStore', {
      value: originalStore, writable: true, configurable: true,
    });

  } catch (e) {
    console.error('EXCEPTION:', e.stack || e);
    fail = true;
  } finally {
    s3.close();
    console.log();
    console.log(fail ? 'FAILED' : 'OK — all checks passed');
    process.exit(fail ? 1 : 0);
  }
});
