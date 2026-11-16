-- Reverts 0001_webhooks.sql (drops all recorded webhook data).
DROP INDEX IF EXISTS idx_hook_requests_endpoint;
DROP TABLE IF EXISTS hook_requests;
DROP INDEX IF EXISTS idx_hook_endpoints_activity;
DROP INDEX IF EXISTS idx_hook_endpoints_ip;
DROP TABLE IF EXISTS hook_endpoints;
