CREATE TABLE affiliate_refunded_payments (
  dodo_payment_id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
