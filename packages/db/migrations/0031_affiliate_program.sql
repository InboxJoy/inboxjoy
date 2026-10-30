DO $$ BEGIN
  CREATE TYPE affiliate_referral_status AS ENUM ('signed_up', 'paid');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE affiliate_commission_status AS ENUM ('pending', 'paid', 'reversed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS affiliate_codes (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  code varchar(32) NOT NULL,
  clicks integer NOT NULL DEFAULT 0,
  commission_percent integer,
  commission_months integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS affiliate_codes_workspace_idx ON affiliate_codes (workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS affiliate_codes_code_idx ON affiliate_codes (code);

CREATE TABLE IF NOT EXISTS affiliate_referrals (
  id uuid PRIMARY KEY,
  affiliate_workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  referred_workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  code varchar(32) NOT NULL,
  status affiliate_referral_status NOT NULL DEFAULT 'signed_up',
  first_paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS affiliate_referrals_affiliate_workspace_idx ON affiliate_referrals (affiliate_workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS affiliate_referrals_referred_workspace_idx ON affiliate_referrals (referred_workspace_id);

CREATE TABLE IF NOT EXISTS affiliate_commissions (
  id uuid PRIMARY KEY,
  referral_id uuid NOT NULL REFERENCES affiliate_referrals(id) ON DELETE CASCADE,
  affiliate_workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  dodo_payment_id text NOT NULL,
  payment_amount_cents integer NOT NULL,
  currency varchar(8) NOT NULL,
  commission_percent integer NOT NULL,
  commission_cents integer NOT NULL,
  status affiliate_commission_status NOT NULL DEFAULT 'pending',
  available_at timestamptz NOT NULL,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS affiliate_commissions_affiliate_workspace_idx ON affiliate_commissions (affiliate_workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS affiliate_commissions_dodo_payment_idx ON affiliate_commissions (dodo_payment_id);
