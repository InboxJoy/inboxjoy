CREATE TABLE mailbox_health (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email_account_id uuid NOT NULL UNIQUE REFERENCES email_accounts(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'healthy',
  effective_daily_limit int,
  consecutive_failures int NOT NULL DEFAULT 0,
  temp_failures_24h int NOT NULL DEFAULT 0,
  perm_failures_24h int NOT NULL DEFAULT 0,
  bounce_rate numeric(5,2) NOT NULL DEFAULT 0,
  reply_rate numeric(5,2) NOT NULL DEFAULT 0,
  last_successful_send_at timestamptz,
  throttled_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE provider_circuit (
  provider text PRIMARY KEY,
  state text NOT NULL DEFAULT 'closed',
  opened_at timestamptz,
  failure_count int NOT NULL DEFAULT 0,
  next_probe_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE messages ADD COLUMN blocked_reason text;

CREATE INDEX messages_email_account_status_accepted_idx
  ON messages (email_account_id, status, accepted_at);

CREATE INDEX messages_workspace_status_accepted_idx
  ON messages (workspace_id, status, accepted_at);

-- accepted_at is timestamptz, so PostgreSQL rejects an accepted_at::date expression
-- index as timezone-dependent. This raw timestamp index is designed for the equivalent
-- sargable day-range predicate (accepted_at >= day_start AND accepted_at < day_end).

DROP TABLE sender_health;

UPDATE suppressions
SET reason = CASE
  WHEN lower(reason) LIKE '%unsub%' THEN 'unsubscribed'
  WHEN lower(reason) LIKE '%bounce%' THEN 'bounced'
  WHEN lower(reason) LIKE '%complaint%' OR lower(reason) LIKE '%spam%' THEN 'complained'
  WHEN lower(reason) LIKE '%block%' THEN 'blocked'
  WHEN lower(reason) LIKE '%customer%' THEN 'customer'
  ELSE 'manual'
END;

CREATE FUNCTION normalize_suppression_reason() RETURNS trigger AS $$
BEGIN
  NEW.reason := CASE
    WHEN lower(NEW.reason) IN ('unsubscribed', 'bounced', 'complained', 'blocked', 'customer', 'manual') THEN lower(NEW.reason)
    WHEN lower(NEW.reason) LIKE '%unsub%' THEN 'unsubscribed'
    WHEN lower(NEW.reason) LIKE '%bounce%' THEN 'bounced'
    WHEN lower(NEW.reason) LIKE '%complaint%' OR lower(NEW.reason) LIKE '%spam%' THEN 'complained'
    WHEN lower(NEW.reason) LIKE '%block%' THEN 'blocked'
    WHEN lower(NEW.reason) LIKE '%customer%' THEN 'customer'
    ELSE 'manual'
  END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER suppressions_normalize_reason
BEFORE INSERT OR UPDATE OF reason ON suppressions
FOR EACH ROW EXECUTE FUNCTION normalize_suppression_reason();

ALTER TABLE suppressions ADD CONSTRAINT suppressions_reason_taxonomy_check
  CHECK (reason IN ('unsubscribed', 'bounced', 'complained', 'blocked', 'customer', 'manual'));
