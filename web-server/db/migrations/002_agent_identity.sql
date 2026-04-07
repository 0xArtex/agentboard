-- Agent identity layer.
--
-- Every caller of the /api/* routes now has an identity (even if the
-- "default" anonymous one in local dev). Projects are owned by a user, and
-- other users can be granted read or read-write access via project_grants.
--
-- Agents authenticate via bearer tokens stored in agent_tokens. One user
-- can own many tokens — typical pattern is one token per agent instance
-- (production-orchestrator, dev-playground, user-bob's-cursor, etc). Tokens
-- can be revoked independently without affecting the owner user.
--
-- In local dev the auth middleware can be disabled via AGENT_AUTH_ENABLED=0
-- env var, in which case every request is attributed to a built-in
-- `default` user (created by the seed step below). Production must set
-- AGENT_AUTH_ENABLED=1 and provision real users + tokens.

PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id          TEXT PRIMARY KEY,             -- UUID
  handle      TEXT NOT NULL UNIQUE,         -- display handle, e.g. 'artex' or 'claude-agent-42'
  email       TEXT,                         -- optional
  created_at  INTEGER NOT NULL,             -- unix ms
  meta        TEXT                          -- forward-compat JSON
);

CREATE INDEX idx_users_handle ON users(handle);

CREATE TABLE agent_tokens (
  id              TEXT PRIMARY KEY,         -- UUID of the token row
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL UNIQUE,     -- sha256 of the token string. Never store the raw token.
  name            TEXT,                     -- human label: "cursor-local", "prod-orchestrator"
  created_at      INTEGER NOT NULL,
  last_used_at    INTEGER,
  revoked_at      INTEGER                   -- NULL = active
);

CREATE INDEX idx_agent_tokens_user ON agent_tokens(user_id);
CREATE INDEX idx_agent_tokens_hash ON agent_tokens(token_hash);

-- Projects gain an owner. Existing projects (from before this migration)
-- are assigned to the default user, which is seeded below.
ALTER TABLE projects ADD COLUMN owner_id TEXT REFERENCES users(id);

CREATE INDEX idx_projects_owner ON projects(owner_id, updated_at DESC);

-- Fine-grained project access control. A project owner implicitly has 'owner'
-- permission; everyone else needs an explicit row here.
CREATE TABLE project_grants (
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission   TEXT NOT NULL CHECK (permission IN ('read', 'read-write')),
  granted_at   INTEGER NOT NULL,
  granted_by   TEXT REFERENCES users(id),
  PRIMARY KEY (project_id, user_id)
);

CREATE INDEX idx_project_grants_user ON project_grants(user_id);

-- Seed the default user and attribute any pre-existing projects to it.
-- Uses a deterministic UUID so scripts + tests can reference it by constant.
INSERT INTO users (id, handle, email, created_at, meta)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'default',
  NULL,
  unixepoch('now') * 1000,
  '{"description":"Default local-dev user. In production with AGENT_AUTH_ENABLED=1, real users + tokens are required for mutations."}'
);

UPDATE projects
SET    owner_id = '00000000-0000-0000-0000-000000000001'
WHERE  owner_id IS NULL;
