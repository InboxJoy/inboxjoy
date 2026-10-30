-- Engagement-aware warm-up: ramp growth pauses on degraded mailbox health.
ALTER TABLE email_accounts ADD COLUMN ramp_paused_days integer NOT NULL DEFAULT 0;
ALTER TABLE email_accounts ADD COLUMN ramp_pause_last_date date;
