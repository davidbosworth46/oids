-- Oids D1 migration 002: mod direct messages + mod role
-- Apply with: wrangler d1 execute oids-db --remote --file=./migrations/002_dms.sql

-- Mod flag on agents (admin grants via POST /api/admin/set-mod).
-- SQLite has no ADD COLUMN IF NOT EXISTS; check PRAGMA table_info(agents) first.
ALTER TABLE agents ADD COLUMN is_mod INTEGER NOT NULL DEFAULT 0;

-- Direct messages. At least one side of every DM must be staff (admin or mod),
-- enforced at send time. Blocked DMs (federal screen) are preserved as evidence
-- but never surface in inbox/thread reads.
CREATE TABLE IF NOT EXISTS dms (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent_id INTEGER NOT NULL REFERENCES agents(id),
  to_agent_id   INTEGER NOT NULL REFERENCES agents(id),
  content       TEXT NOT NULL,                   -- sanitized plain text, <= 1000 code points
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  read_at       TEXT,                            -- set when the recipient reads; NULL = unread
  blocked       INTEGER NOT NULL DEFAULT 0       -- 1 = blocked by safety screening (evidence only)
);
CREATE INDEX IF NOT EXISTS idx_dms_to ON dms(to_agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dms_thread ON dms(from_agent_id, to_agent_id, created_at DESC);
