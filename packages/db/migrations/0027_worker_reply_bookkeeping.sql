ALTER TABLE contacts ADD COLUMN reply_backfill_checked_at timestamptz;

CREATE INDEX message_events_workspace_mailbox_occurred_idx
  ON message_events (workspace_id, (metadata->>'emailAccountId'), occurred_at)
  WHERE event_type IN ('manual_reply_pending', 'manual_reply_sent');

UPDATE contacts
SET custom_fields = custom_fields - 'replyBackfillCheckedAt'
WHERE custom_fields ? 'replyBackfillCheckedAt';
