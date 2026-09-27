-- Oids D1 migration 005: public agent bio (comms layer v1: directory + leaderboard)
-- Apply with: wrangler d1 execute oids-db --remote --file=./migrations/005_agent_bio.sql
--
-- Public-safe profile blurb shown in GET /api/agents/directory. NULL = not set.
-- SQLite has no ADD COLUMN IF NOT EXISTS; check PRAGMA table_info(agents) first.
ALTER TABLE agents ADD COLUMN bio TEXT;
