-- One row per "Send to RJ" press from the Ask Govna drawer. The prompt is the
-- exact email body that went out, so a lost email can be resent from here.
CREATE TABLE IF NOT EXISTS issue_report (
  id              TEXT PRIMARY KEY,
  team_id         TEXT NOT NULL,
  conversation_id TEXT,
  user_id         TEXT NOT NULL,
  user_email      TEXT,
  title           TEXT NOT NULL,
  draft           TEXT NOT NULL,
  prompt          TEXT NOT NULL,
  recipients      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  error           TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_issue_report_user
  ON issue_report (team_id, user_id, created_at DESC);
