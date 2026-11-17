-- Temp-mail: disposable inbox addresses + received messages. Applied automatically on first use
-- (CREATE TABLE IF NOT EXISTS in server/mail-core.js); this file is for `wrangler d1 execute`.
CREATE TABLE IF NOT EXISTS mail_inboxes (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_activity INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_mail_inboxes_addr ON mail_inboxes (address);
CREATE INDEX IF NOT EXISTS idx_mail_inboxes_ip ON mail_inboxes (ip_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_mail_inboxes_activity ON mail_inboxes (last_activity);
CREATE TABLE IF NOT EXISTS mail_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inbox_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  from_addr TEXT, from_name TEXT, subject TEXT,
  text_body TEXT, html_text TEXT, otp TEXT, attachments TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  seen INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_mail_messages_inbox ON mail_messages (inbox_id, id);
