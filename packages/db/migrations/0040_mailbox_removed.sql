-- Deleting a mailbox from the app keeps its row so sent messages, campaigns and reply
-- threads (which reference email_accounts) stay intact. 'removed' mailboxes never send,
-- are hidden from every mailbox list, and come back if the same account is reconnected.
ALTER TYPE mailbox_status ADD VALUE IF NOT EXISTS 'removed';
