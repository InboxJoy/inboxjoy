ALTER TABLE subscriptions
  ADD COLUMN dodo_customer_id text,
  ADD COLUMN dodo_subscription_id text,
  ADD COLUMN product_id text,
  ADD COLUMN next_billing_date timestamptz,
  ADD COLUMN trial_end timestamptz,
  ADD COLUMN cancel_at_period_end boolean NOT NULL DEFAULT false;

UPDATE subscriptions
SET next_billing_date = current_period_ends_at
WHERE next_billing_date IS NULL
  AND current_period_ends_at IS NOT NULL;

CREATE UNIQUE INDEX subscriptions_dodo_subscription_idx
  ON subscriptions (dodo_subscription_id)
  WHERE dodo_subscription_id IS NOT NULL;

CREATE TABLE processed_webhook_events (
  id uuid PRIMARY KEY,
  webhook_id text NOT NULL,
  type varchar(160) NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX processed_webhook_events_webhook_id_idx
  ON processed_webhook_events (webhook_id);
