CREATE TABLE worker_heartbeats (
  worker_id text PRIMARY KEY,
  last_seen_at timestamptz NOT NULL,
  last_job_at timestamptz
);

CREATE INDEX worker_heartbeats_last_seen_idx ON worker_heartbeats (last_seen_at);
