#!/usr/bin/env node
/**
 * migrate-legacy-store.js — one-shot import from the file-based store
 *
 * Reads any remaining web-server/data/projects/<uuid>/project.storyboarder
 * JSON files plus their `images/` directories and inserts the equivalent
 * SQLite rows + blob records.
 *
 * Idempotent: skips projects that already exist in the DB by id, and
 * skips assets whose blob already exists by hash.
 *
 * After a successful run you can delete the legacy directories:
 *
 *   rm -rf web-server/data/projects/
 *
 * Usage:
 *   node web-server/scripts/migrate-legacy-store.js
 *   node web-server/scripts/migrate-legacy-store.js --delete   # also rm the legacy dirs after
 */

const path = require('path');
const fs = require('fs');

const { db } = require('../services/db');
const { blobStore } = require('../services/blob-store');
const store = require('../services/project-store');

const PROJECTS_DIR = path.join(__dirname, '..', 'data', 'projects');
const DELETE_AFTER = process.argv.includes('--delete');

const stmts = {
  hasProject: db.prepare('SELECT 1 FROM projects WHERE id = ?'),
  insertProject: db.prepare(`
    INSERT INTO projects
      (id, version, aspect_ratio, fps, default_board_timing, meta, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  insertBoard: db.prepare(`
    INSERT INTO boards
      (uid, project_id, number, new_shot, shot, time_ms, duration_ms,
       dialogue, action, notes, audio, link, meta, last_edited)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  upsertAsset: db.prepare(`
    INSERT INTO board_assets (board_uid, kind, blob_hash, meta, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(board_uid, kind)
    DO UPDATE SET blob_hash = excluded.blob_hash,
                  meta      = excluded.meta,
                  updated_at = excluded.updated_at
  `),
};

function migrateOne(projectId) {
  const projectDir = path.join(PROJECTS_DIR, projectId);
  const projectFile = path.join(projectDir, 'project.storyboarder');
  if (!fs.existsSync(projectFile)) {
    console.log(`[migrate] skip ${projectId}: no project.storyboarder`);
    return false;
  }
  if (stmts.hasProject.get(projectId)) {
    console.log(`[migrate] skip ${projectId}: already in SQLite`);
    return false;
  }

  const project = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
  const now = Date.now();

  const tx = db.transaction(() => {
    stmts.insertProject.run(
      projectId,
      project.version || '0.6.0',
      project.aspectRatio || 1.7777,
      project.fps || 24,
      project.defaultBoardTiming || 2000,
      null,
      now,
      now
    );

    const boards = Array.isArray(project.boards) ? project.boards : [];
    for (const board of boards) {
      stmts.insertBoard.run(
        board.uid,
        projectId,
        board.number,
        board.newShot ? 1 : 0,
        board.shot || `${board.number}A`,
        board.time || 0,
        board.duration || project.defaultBoardTiming || 2000,
        board.dialogue || '',
        board.action || '',
        board.notes || '',
        board.audio ? JSON.stringify(board.audio) : null,
        board.link || null,
        null,
        board.lastEdited || now
      );

      // For each on-disk file matching this board, hash it and record an
      // asset row. We rely on the legacy filename parser to figure out
      // which kind each file represents.
      const imagesDir = path.join(projectDir, 'images');
      if (!fs.existsSync(imagesDir)) continue;
      const files = fs.readdirSync(imagesDir);
      for (const fname of files) {
        const parsed = store.parseLegacyFilename(fname);
        if (!parsed) continue;
        if (parsed.uid !== board.uid) continue;
        const bytes = fs.readFileSync(path.join(imagesDir, fname));
        const mime = parsed.kind === 'posterframe' ? 'image/jpeg' : 'image/png';
        const result = blobStore.put(bytes, mime);
        // Carry over layer opacity from board.layers if present
        let assetMeta = null;
        if (parsed.kind.startsWith('layer:')) {
          const layerName = parsed.kind.slice('layer:'.length);
          const layerData = board.layers && board.layers[layerName];
          if (layerData && typeof layerData === 'object') {
            const meta = Object.fromEntries(
              Object.entries(layerData).filter(([k]) => k !== 'url')
            );
            if (Object.keys(meta).length) assetMeta = JSON.stringify(meta);
          }
        }
        stmts.upsertAsset.run(board.uid, parsed.kind, result.hash, assetMeta, now);
      }
    }
  });
  tx();

  console.log(`[migrate] imported ${projectId}: ${(project.boards || []).length} board(s)`);
  return true;
}

function main() {
  if (!fs.existsSync(PROJECTS_DIR)) {
    console.log('[migrate] no legacy projects directory, nothing to do');
    return;
  }

  const entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  let imported = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (migrateOne(entry.name)) imported++;
  }

  console.log(`[migrate] done — ${imported} project(s) imported`);

  if (DELETE_AFTER && imported > 0) {
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(PROJECTS_DIR, entry.name);
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`[migrate] removed ${dir}`);
    }
  }
}

main();
