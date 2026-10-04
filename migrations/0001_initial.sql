CREATE TABLE accounts (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, last_used INTEGER NOT NULL DEFAULT 0,
  last_refresh INTEGER NOT NULL DEFAULT 0, health TEXT NOT NULL DEFAULT 'unknown',
  cooldown_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX accounts_available ON accounts(enabled, cooldown_until, last_used);
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE requests (
  id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, account_id TEXT, key_id TEXT NOT NULL,
  endpoint TEXT NOT NULL, model TEXT NOT NULL, actual_model TEXT,
  status INTEGER NOT NULL, duration_ms INTEGER NOT NULL, input_chars INTEGER NOT NULL DEFAULT 0,
  output_chars INTEGER NOT NULL DEFAULT 0, error_code TEXT
);
CREATE INDEX requests_time ON requests(created_at DESC);
CREATE TABLE daily_stats (
  day TEXT PRIMARY KEY, requests INTEGER NOT NULL, failures INTEGER NOT NULL
);
