-- AgentBoard initial schema
--
-- Three tables:
--
--   blobs           — content-addressed binary store index. Every PNG/JPG
--                     written through the BlobStore lives here keyed by its
--                     SHA-256 hash. The actual bytes live on disk under
--                     web-server/data/blobs/<hash[:2]>/<hash[2:]>.<ext> when
--                     using DiskBlobStore, or in an R2 bucket when using
--                     R2BlobStore. Either way the row tells us about size,
--                     mime, and creation time without touching the bytes.
--
--   projects        — top-level project metadata (aspect ratio, fps, etc).
--                     One row per project. Soft-replaces the old
--                     project.storyboarder JSON files.
--
--   boards          — boards within a project. One row per board, ordered by
--                     `number`. Holds the dialogue/action/notes/timing fields
--                     and a JSON `meta` for anything we don't deserve a
--                     dedicated column for. Layers and other binary assets
--                     live in board_assets, NOT in this table.
--
--   board_assets    — the binary side of a board. One row per (board, asset
--                     kind) pair pointing at a blob hash. `kind` is one of:
--                       'board'              — composited posterframe PNG
--                       'thumbnail'          — drawer thumbnail PNG
--                       'posterframe'        — fast preview JPG
--                       'layer:<name>'       — individual layer PNG (e.g.
--                                              'layer:fill', 'layer:reference')
--                     This single table replaces the old per-board file mess
--                     and lets us add new asset kinds without schema changes.

PRAGMA foreign_keys = ON;

CREATE TABLE blobs (
  hash        TEXT PRIMARY KEY,         -- sha256 hex (64 chars)
  byte_size   INTEGER NOT NULL,
  mime_type   TEXT NOT NULL DEFAULT 'application/octet-stream',
  created_at  INTEGER NOT NULL          -- unix ms
);

CREATE INDEX idx_blobs_created ON blobs(created_at DESC);

CREATE TABLE projects (
  id                    TEXT PRIMARY KEY,        -- UUID
  version               TEXT NOT NULL DEFAULT '0.6.0',
  aspect_ratio          REAL NOT NULL DEFAULT 1.7777,
  fps                   INTEGER NOT NULL DEFAULT 24,
  default_board_timing  INTEGER NOT NULL DEFAULT 2000,
  meta                  TEXT,                    -- optional JSON for forward-compat
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE INDEX idx_projects_updated ON projects(updated_at DESC);

CREATE TABLE boards (
  uid           TEXT PRIMARY KEY,                -- 5-char uppercase, globally unique
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number        INTEGER NOT NULL,                -- 1-indexed order within project
  new_shot      INTEGER NOT NULL DEFAULT 0,      -- 0/1 boolean
  shot          TEXT,
  time_ms       INTEGER NOT NULL DEFAULT 0,     -- cumulative time at start of board
  duration_ms   INTEGER NOT NULL DEFAULT 2000,
  dialogue      TEXT NOT NULL DEFAULT '',
  action        TEXT NOT NULL DEFAULT '',
  notes         TEXT NOT NULL DEFAULT '',
  audio         TEXT,                            -- optional JSON
  link          TEXT,                            -- optional linked PSD path
  meta          TEXT,                            -- forward-compat JSON
  last_edited   INTEGER NOT NULL,
  UNIQUE(project_id, number)
);

CREATE INDEX idx_boards_project ON boards(project_id, number);
CREATE INDEX idx_boards_edited ON boards(last_edited DESC);

CREATE TABLE board_assets (
  board_uid    TEXT NOT NULL REFERENCES boards(uid) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  blob_hash    TEXT NOT NULL REFERENCES blobs(hash),
  meta         TEXT,                             -- per-asset JSON (e.g. layer opacity)
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (board_uid, kind)
);

CREATE INDEX idx_board_assets_blob ON board_assets(blob_hash);
