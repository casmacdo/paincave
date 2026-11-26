-- PainCave D1 Migration 0002: Mobile OAuth 2.1 (PKCE + DCR) & CSRF state store

CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL DEFAULT 'MCP Client',
  redirect_uris_json TEXT NOT NULL,
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS mcp_oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL CHECK (code_challenge_method = 'S256'),
  scope TEXT NOT NULL DEFAULT 'mcp:tools',
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0 CHECK (used IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_mcp_oauth_codes_expires ON mcp_oauth_codes (expires_at);

CREATE TABLE IF NOT EXISTS mcp_oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  refresh_token_hash TEXT UNIQUE,
  client_id TEXT NOT NULL REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE,
  scope TEXT NOT NULL DEFAULT 'mcp:tools',
  expires_at INTEGER NOT NULL,
  refresh_expires_at INTEGER,
  revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_mcp_oauth_tokens_refresh ON mcp_oauth_tokens (refresh_token_hash);

CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_oauth_states_expires ON oauth_states (expires_at);
