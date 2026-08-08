CREATE TABLE IF NOT EXISTS plugin_config (
  team_id    TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (team_id, key)
);

-- status is 'active' or 'archived'. Nothing is ever deleted on a timer;
-- archiving writes a summary and keeps every message row. Only an explicit
-- human action removes a conversation.
CREATE TABLE IF NOT EXISTS conversation (
  id             TEXT PRIMARY KEY,
  team_id        TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active',
  summary        TEXT,
  summarized_at  TEXT,
  created_at     TEXT NOT NULL,
  last_active_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversation_user
  ON conversation (team_id, user_id, last_active_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversation_status
  ON conversation (team_id, status, last_active_at);

CREATE TABLE IF NOT EXISTS message (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  sources         TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_message_conversation
  ON message (conversation_id, created_at);
