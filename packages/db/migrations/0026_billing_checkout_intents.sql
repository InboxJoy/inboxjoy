CREATE TABLE billing_checkout_intents (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  product_key varchar(16) NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  checkout_url text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
