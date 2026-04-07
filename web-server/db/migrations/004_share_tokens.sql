-- Shareable read-only (or higher) URLs for projects.
--
-- An agent calls POST /api/agent/share with a project id and optional
-- permission + expiry; the server mints a random token, stores its SHA-256
-- hash, and returns a URL of the shape:
--
--   /view/<projectId>?t=<raw-token>
--
-- When a request arrives at /view/:projectId, the viewer validates the
-- token by:
--   1. Hashing the `t` query param
--   2. Looking it up in share_tokens
--   3. Checking the token matches the project id
--   4. Checking expires_at (NULL means never expires)
--   5. Checking revoked_at
--
-- Permission levels (lowest to highest):
--   'view'    — can see the project, can download the PDF, cannot mutate
--   'comment' — same as view; reserved for Phase 3.5 when comments arrive
--   'edit'    — can mutate boards and assets (used for collaborative editing)
--
-- In v1 only 'view' is enforced; 'comment' and 'edit' are accepted as
-- values but behave the same as 'view' until the downstream routes
-- implement token-based mutation gating.
--
-- Revoked tokens stay in the table for audit purposes — they just fail
-- validation. A nightly cleanup job can DELETE where revoked_at IS NOT NULL
-- once we have audit logs.

PRAGMA foreign_keys = ON;

CREATE TABLE share_tokens (
  id              TEXT PRIMARY KEY,                      -- UUID of the row
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL UNIQUE,                  -- sha256 of the raw token
  permission      TEXT NOT NULL
                    CHECK (permission IN ('view', 'comment', 'edit')),
  name            TEXT,                                  -- human label: "prod preview", "client review"
  created_by      TEXT REFERENCES users(id),             -- who minted it
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER,                               -- unix ms, NULL = never
  last_used_at    INTEGER,
  revoked_at      INTEGER
);

CREATE INDEX idx_share_tokens_project ON share_tokens(project_id);
CREATE INDEX idx_share_tokens_hash ON share_tokens(token_hash);
CREATE INDEX idx_share_tokens_expires ON share_tokens(expires_at) WHERE expires_at IS NOT NULL;
