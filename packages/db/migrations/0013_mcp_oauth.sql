CREATE TABLE mcp_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  client_id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scopes text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE INDEX mcp_grants_user_id_idx ON mcp_grants(user_id);
CREATE INDEX mcp_grants_client_id_idx ON mcp_grants(client_id);
CREATE INDEX mcp_grants_workspace_id_idx ON mcp_grants(workspace_id);
CREATE UNIQUE INDEX mcp_grants_active_subject_idx
  ON mcp_grants(user_id, client_id, workspace_id)
  WHERE revoked_at IS NULL;

CREATE TABLE oauth_clients (
  id text PRIMARY KEY,
  client_name text NOT NULL,
  redirect_uris text[] NOT NULL,
  token_endpoint_auth_method text NOT NULL DEFAULT 'none',
  client_secret_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT oauth_clients_redirect_uris_nonempty CHECK (cardinality(redirect_uris) > 0),
  CONSTRAINT oauth_clients_auth_method_check CHECK (token_endpoint_auth_method = 'none')
);

CREATE TABLE mcp_oauth_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash text NOT NULL,
  client_id text NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  scopes text NOT NULL,
  code_challenge text NOT NULL,
  code_challenge_method text NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '60 seconds',
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mcp_oauth_codes_challenge_method_check CHECK (code_challenge_method = 'S256')
);

CREATE UNIQUE INDEX mcp_oauth_codes_code_hash_idx ON mcp_oauth_codes(code_hash);
CREATE INDEX mcp_oauth_codes_client_id_idx ON mcp_oauth_codes(client_id);
CREATE INDEX mcp_oauth_codes_expires_at_idx ON mcp_oauth_codes(expires_at);

CREATE TABLE mcp_oauth_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL,
  refresh_token_hash text,
  user_id text NOT NULL,
  client_id text NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scopes text NOT NULL,
  expires_at timestamptz NOT NULL,
  refresh_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX mcp_oauth_tokens_token_hash_idx ON mcp_oauth_tokens(token_hash);
CREATE UNIQUE INDEX mcp_oauth_tokens_refresh_token_hash_idx
  ON mcp_oauth_tokens(refresh_token_hash)
  WHERE refresh_token_hash IS NOT NULL;
CREATE INDEX mcp_oauth_tokens_subject_idx
  ON mcp_oauth_tokens(user_id, client_id, workspace_id);
CREATE INDEX mcp_oauth_tokens_active_idx
  ON mcp_oauth_tokens(client_id, expires_at)
  WHERE revoked_at IS NULL;
