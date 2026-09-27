-- 004_automod.sql — tables for the Cloudflare-native autonomous moderation worker.
-- Apply: wrangler d1 execute oids-db --remote --file=./migrations/004_automod.sql
-- (test first against a scratch/local DB; see automod/README.md)

-- Gray-area items awaiting human review (AI triage verdicts included when available).
CREATE TABLE review_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_type TEXT NOT NULL,              -- 'post' | 'dm' | 'abuse_report' | 'legal'
  target_id TEXT,                       -- post id / dm id / message id
  username TEXT,                        -- author or reporter
  content TEXT,                         -- excerpt for review
  reason TEXT NOT NULL,                 -- why it was queued
  ai_verdict TEXT,                      -- JSON {label, confidence, rationale} or NULL
  status TEXT NOT NULL DEFAULT 'open',  -- open | actioned | dismissed
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at TEXT
);
CREATE INDEX idx_review_queue_status ON review_queue(status, created_at);

-- Federal incidents. Mirrors the fields the Python pipeline wrote to
-- records/federal-reports/pending/*.json so nothing is lost in translation.
-- status 'pending' means packaged but not yet filed with NCMEC/FBI.
CREATE TABLE federal_incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                   -- 'child' -> NCMEC, 'other' -> FBI
  source TEXT NOT NULL,                 -- 'timeline' | 'dm' | 'abuse_report'
  target_type TEXT NOT NULL,            -- 'post' | 'dm'
  target_id TEXT NOT NULL,
  username TEXT,
  content TEXT NOT NULL,                -- preserved verbatim as evidence
  created_at TEXT,                      -- original content timestamp
  detected_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  action_taken TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | filed
  filed_at TEXT,
  filing_ref TEXT,
  dry_run INTEGER NOT NULL DEFAULT 0,
  package_json TEXT                     -- full incident package (JSON)
);
CREATE INDEX idx_federal_incidents_status ON federal_incidents(status, detected_at);

-- Notification queue. The worker writes here; a lightweight drain
-- (automod/drain-notifications.py, or Resend email fan-out) delivers them.
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                   -- 'dm' | 'federal' | 'review' | 'error' | 'info'
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  delivered INTEGER NOT NULL DEFAULT 0,
  delivered_at TEXT
);
CREATE INDEX idx_notifications_delivered ON notifications(delivered, created_at);
