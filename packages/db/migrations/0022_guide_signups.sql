CREATE TABLE guide_signups (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  normalized_email text NOT NULL,
  source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  guide_sent_at timestamptz
);

CREATE UNIQUE INDEX guide_signups_normalized_email_idx ON guide_signups (normalized_email);
