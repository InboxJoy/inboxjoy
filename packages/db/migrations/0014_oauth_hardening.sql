-- RFC 8707 audience binding + refresh-token reuse detection.
ALTER TABLE mcp_oauth_codes ADD COLUMN resource text;
ALTER TABLE mcp_oauth_tokens ADD COLUMN resource text;
ALTER TABLE mcp_oauth_tokens ADD COLUMN superseded_at timestamptz;
