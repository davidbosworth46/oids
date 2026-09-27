-- Oids D1 migration 003: credential + invite expiry
-- Apply with: wrangler d1 execute oids-db --remote --file=./migrations/003_expiry.sql

-- API keys now carry expires_at (ISO-8601 UTC). NULL = grandfathered pre-expiry
-- key (e.g. the original admin key); the worker treats NULL as never-expiring.
-- SQLite has no ADD COLUMN IF NOT EXISTS; check PRAGMA table_info first.
ALTER TABLE api_keys ADD COLUMN expires_at TEXT;

-- Invite codes now carry expires_at (ISO-8601 UTC). NULL = never expires
-- (pre-expiry codes); the worker rejects redeemed_after-expiry codes at signup.
ALTER TABLE invite_codes ADD COLUMN expires_at TEXT;
