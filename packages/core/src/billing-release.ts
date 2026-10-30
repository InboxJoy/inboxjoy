import type { InboxJoyDb } from "@inboxjoy/db";
import { sql } from "drizzle-orm";

// Campaign email the plan gate parked waits on its scheduled_at:
// payment_required is rechecked every 6 hours (PAYMENT_REQUIRED_RETRY_MS), and
// legacy Free's free_monthly_cap waits for the next month (or the end of the
// legacy window). When a workspace gains a lifetime license, a comp or an
// entitling Dodo subscription, bring those messages back to now so they go out
// on the next scheduler tick instead of waiting. Only timing changes: canSend
// still decides at claim time, and idempotency keys, senders, versions and send
// attempts are untouched. Messages already due are left alone. Anything that
// later reschedules a parked message from the sequence itself (a resume,
// ./resume-pending.ts) clears its blocked_reason, so it is never pulled forward.
export const PLAN_BLOCKED_REASONS = ["payment_required", "free_monthly_cap"] as const;

export async function releasePlanBlockedSends(db: Pick<InboxJoyDb, "execute">, workspaceId: string, now: Date = new Date()): Promise<number> {
  // One explicitly typed parameter per use, so PostgreSQL never has to deduce
  // a type for a value bound in several places.
  const at = now.toISOString();
  const result = await db.execute(sql`
    UPDATE messages
    SET scheduled_at = ${at}::timestamptz, blocked_reason = NULL, updated_at = ${at}::timestamptz
    WHERE workspace_id = ${workspaceId}::uuid
      AND status IN ('scheduled', 'retryable')
      AND blocked_reason IN ('payment_required', 'free_monthly_cap')
      AND scheduled_at > ${at}::timestamptz
  `);
  return result.rowCount ?? 0;
}
