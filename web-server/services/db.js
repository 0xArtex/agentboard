/**
 * db.js — SQLite connection + migrations runner
 *
 * AgentBoard's metadata lives in a single SQLite file at
 * `web-server/data/agentboard.db`. We use better-sqlite3 because:
 *   - Synchronous API: queries are sub-microsecond, no async overhead
 *   - WAL mode lets readers and writers coexist without lock contention
 *   - Single file → trivial backup (just copy it)
 *
 * On first import this module:
 *   1. Ensures the data directory exists
 *   2. Opens (or creates) the .db file
 *   3. Enables WAL mode and other pragmas
 *   4. Runs every .sql file under db/migrations/ that hasn't been applied yet,
 *      tracking applied migrations in a `_migrations` table
 *
 * Other modules just `require('./db')` and use the exported `db` Database
 * instance directly. There's no connection pool because there are no
 * connections — it's a function call into the same process.
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'agentboard.db');
const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);

// WAL mode is required for concurrent reads during writes. NORMAL synchronous
// is the right tradeoff for app data — durable across crashes, but doesn't
// fsync on every transaction (which would be ~10x slower).
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
// 64 MB cache — generous but tiny relative to the 24 GB free Oracle Ampere VM
db.pragma('cache_size = -64000');

function runMigrations() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename   TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  if (!fs.existsSync(MIGRATIONS_DIR)) {
    return;
  }

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  const applied = new Set(
    db.prepare('SELECT filename FROM _migrations').all().map(r => r.filename)
  );

  const insertMigration = db.prepare(
    'INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)'
  );

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const apply = db.transaction(() => {
      db.exec(sql);
      insertMigration.run(file, Date.now());
    });
    try {
      apply();
      console.log(`[db] applied migration ${file}`);
    } catch (err) {
      console.error(`[db] migration ${file} failed:`, err.message);
      throw err;
    }
  }
}

runMigrations();

module.exports = { db, DB_PATH };
