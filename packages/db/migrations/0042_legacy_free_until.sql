-- The hosted Free plan is retired (docs/plans/open-source-and-managed.md): campaign
-- sending in the managed edition needs the lifetime license. Workspaces that exist
-- when this ships keep the Free plan's rules (10,000 sends a month, 2,500 contacts,
-- the "Sent via InboxJoy" footer) for 30 more days once they have no entitlement;
-- after that their campaign email waits with blocked_reason 'payment_required' until
-- they buy. New workspaces get NULL and need the license straight away. Self-hosted
-- installs ignore the column.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS legacy_free_until timestamptz;

-- Every existing workspace is stamped, entitled or not. The send gate checks the
-- entitlement first (sendingPlan() in packages/core/src/delivery/can-send.ts), so the
-- window changes nothing while a workspace is entitled. It matters for one that is
-- entitled only for now (a trial, on_hold in its grace, an old plan cancelling at
-- period end, a comp with an end date): when that lapses inside the 30 days it falls
-- back to the Free rules, like a workspace that never paid, instead of straight to
-- payment_required. Re-running never moves a date already stamped.
UPDATE workspaces
SET legacy_free_until = now() + interval '30 days'
WHERE legacy_free_until IS NULL;

-- Entitled workspaces never wait on the Free plan's monthly cap. Email parked with
-- 'free_monthly_cap' before they paid would otherwise sit until the 1st, so it
-- becomes due now; the send gate still decides at claim time. "Entitling" is
-- hasSendingEntitlement(): active (lifetime license, comp, an old Monthly/Yearly
-- plan), trialing before trial_end, or on_hold within 7 days of updated_at.
UPDATE messages m
SET scheduled_at = now(), blocked_reason = NULL, updated_at = now()
FROM subscriptions s
WHERE s.workspace_id = m.workspace_id
  AND (
    s.status = 'active'
    OR (s.status = 'trialing' AND s.trial_end > now())
    OR (s.status = 'on_hold' AND s.updated_at + interval '7 days' > now())
  )
  AND m.status IN ('scheduled', 'retryable')
  AND m.blocked_reason = 'free_monthly_cap'
  AND m.scheduled_at > now();
