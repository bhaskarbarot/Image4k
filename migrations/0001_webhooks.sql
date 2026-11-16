-- Webhook tester storage (Cloudflare D1, binding HOOKS_DB). Idempotent; the function also creates it lazily.
CREATE TABLE IF NOT EXISTS hook_endpoints (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_activity INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0
  );

CREATE INDEX IF NOT EXISTS idx_hook_endpoints_ip ON hook_endpoints (ip_hash, created_at);

CREATE INDEX IF NOT EXISTS idx_hook_endpoints_activity ON hook_endpoints (last_activity);

CREATE TABLE IF NOT EXISTS hook_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  query TEXT NOT NULL,
  headers TEXT NOT NULL,
  content_type TEXT,
  body TEXT NOT NULL,
  body_encoding TEXT NOT NULL,
  size INTEGER NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0,
  ip TEXT
  );

CREATE INDEX IF NOT EXISTS idx_hook_requests_endpoint ON hook_requests (endpoint_id, id);
