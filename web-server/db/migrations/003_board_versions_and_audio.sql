-- Board versioning for optimistic concurrency + audio asset kind convention.
--
-- 1. `boards.version` column
--
--    Level 0 multi-agent collaboration. Every mutation includes an
--    `expected_version` and the server does:
--      UPDATE boards SET ..., version = version + 1
--       WHERE uid = ? AND version = ?
--    If rows_affected = 0, the write is stale → 409 Conflict with the
--    current version in the response, agent refetches and retries.
--
--    Existing boards default to version 1.
--
-- 2. Audio asset kinds
--
--    No schema change — audio blobs reuse `board_assets` with `kind`
--    values prefixed `audio:`. Convention:
--
--      audio:narration   — dialogue / voiceover for the board
--      audio:sfx         — sound effects
--      audio:music       — background music / score
--      audio:ambient     — room tone / atmos
--      audio:reference   — notes/scratch audio from the director
--
--    `board_assets.meta` (already a JSON column) holds per-asset metadata:
--      { "duration": 3200, "voice": "21m00Tcm4TlvDq8ikWAM", "source": "elevenlabs" }
--
--    Client code treats unknown `audio:*` kinds as generic audio so new
--    subcategories don't require a code change.

PRAGMA foreign_keys = ON;

ALTER TABLE boards ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
