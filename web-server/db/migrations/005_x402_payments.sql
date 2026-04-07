-- x402 payment audit log.
--
-- Every verified payment lands here. We never serve a gated resource
-- without first writing a row — if the insert fails, the request fails.
-- Used for:
--   - customer receipts ("show me my usage")
--   - reconciliation (did the money actually land on chain)
--   - refund processing (if the downstream provider fails we log the intent)
--   - rate limiting per payer
--
-- `status` values:
--   'verified' — payment proof accepted, resource will be served
--   'served'   — downstream resource successfully delivered (finalised)
--   'failed'   — resource delivery failed after payment was verified
--                 (this is the "eat the loss" case from NOTES.local.md;
--                 we still have the row for later manual reconciliation)
--
-- `amount_atomic` is a TEXT column because SQLite INTEGER caps at 2^63 and
-- EVM token amounts can in principle exceed that. For USDC this isn't
-- actually a problem (6 decimals, max realistic value fits easily in INT64)
-- but we store as TEXT for forward-compat with higher-decimal tokens.

PRAGMA foreign_keys = ON;

CREATE TABLE payments (
  id              TEXT PRIMARY KEY,             -- UUID
  project_id      TEXT REFERENCES projects(id) ON DELETE SET NULL,
  user_id         TEXT REFERENCES users(id),    -- NULL for anonymous x402 payers
  resource        TEXT NOT NULL,                -- the gated URL path
  scheme          TEXT NOT NULL,                -- 'exact' (EIP-3009) for now
  network         TEXT NOT NULL,                -- 'base' | 'base-sepolia' | ...
  asset           TEXT NOT NULL,                -- token contract address
  amount_atomic   TEXT NOT NULL,                -- amount in smallest unit, as string
  amount_required TEXT NOT NULL,                -- what we asked for
  payer           TEXT,                         -- 0x address of the payer
  pay_to          TEXT NOT NULL,                -- our receiver address
  tx_hash         TEXT,                         -- on-chain settlement tx (real mode only)
  status          TEXT NOT NULL
                    CHECK (status IN ('verified', 'served', 'failed')),
  verification_mode TEXT NOT NULL,              -- 'mock' | 'chain' | 'facilitator'
  error           TEXT,                         -- populated when status='failed'
  meta            TEXT,                         -- JSON for anything else
  created_at      INTEGER NOT NULL
);

CREATE INDEX idx_payments_resource ON payments(resource, created_at DESC);
CREATE INDEX idx_payments_payer ON payments(payer, created_at DESC);
CREATE INDEX idx_payments_user ON payments(user_id, created_at DESC);
CREATE INDEX idx_payments_status ON payments(status);
