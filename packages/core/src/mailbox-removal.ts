import { schema, type InboxJoyDb } from "@inboxjoy/db";
import { and, eq, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";

import { reconcileCampaignStatus } from "./campaign-status.js";
import { isSendableSequenceMailbox, readSequenceMailboxIds } from "./sequence-mailboxes.js";

type WriteDb = Pick<InboxJoyDb, "select" | "update" | "execute">;

const OPEN_ENROLLMENT_STATUSES: Array<"scheduled" | "active" | "paused"> = ["scheduled", "active", "paused"];

// True once any message of the enrollment may have reached the provider. From then on
// the lead is threaded to its sender and must never move to another mailbox.
export function enrollmentHasStartedSending(workspaceId: string): SQL {
  return sql`exists (
    select 1 from messages previous
    where previous.enrollment_id = ${schema.enrollments.id}
      and previous.workspace_id = ${workspaceId}::uuid
      and (
        previous.status in ('accepted', 'sending', 'claimed')
        or previous.accepted_at is not null
        or previous.provider_message_id is not null
        or previous.error_class = 'unknown_provider_result'
        or previous.claim_expires_at > now()
        or exists (
          select 1 from send_attempts attempt
          where attempt.message_id = previous.id
            and (attempt.status = 'accepted' or attempt.provider_message_id is not null
              or (attempt.status in ('sending', 'claimed') and attempt.finished_at is null))
        )
        or exists (
          select 1 from message_events event
          where event.message_id = previous.id and event.event_type in ('sent', 'accepted')
        )
      )
  )`;
}

// Moves a sequence's enrollments that have not sent anything yet onto the given sendable
// mailboxes, round-robin. By default it moves every waiting enrollment whose sender is not
// one of the targets; fromMailboxId narrows that to enrollments pinned to one mailbox.
// Callers hold the workspace's send-capacity advisory lock.
export async function reassignWaitingEnrollments(tx: WriteDb, input: {
  workspaceId: string;
  sequenceId: string;
  sendableMailboxIds: string[];
  fromMailboxId?: string;
}): Promise<number> {
  const { workspaceId, sendableMailboxIds } = input;
  if (!sendableMailboxIds.length) return 0;
  const targetIds = sql`${sql.param(sendableMailboxIds)}::uuid[]`;
  const waitingForFirstSend = and(
    eq(schema.enrollments.workspaceId, workspaceId),
    eq(schema.enrollments.sequenceId, input.sequenceId),
    inArray(schema.enrollments.status, OPEN_ENROLLMENT_STATUSES),
    input.fromMailboxId
      ? eq(schema.enrollments.emailAccountId, input.fromMailboxId)
      : sql`(${schema.enrollments.emailAccountId} is null or ${schema.enrollments.emailAccountId} <> all(${targetIds}))`,
    sql`not ${enrollmentHasStartedSending(workspaceId)}`,
  );
  const enrollments = await tx.select({ id: schema.enrollments.id }).from(schema.enrollments)
    .where(waitingForFirstSend).orderBy(schema.enrollments.createdAt, schema.enrollments.id).for("update");
  if (!enrollments.length) return 0;
  // Set-based from here: the statement count stays fixed however many contacts are waiting.
  const enrollmentIds = enrollments.map((enrollment) => enrollment.id);
  await tx.select({ id: schema.messages.id }).from(schema.messages).where(and(
    eq(schema.messages.workspaceId, workspaceId),
    sql`${schema.messages.enrollmentId} = any(${sql.param(enrollmentIds)}::uuid[])`,
  )).orderBy(schema.messages.id).for("update");
  const assignedMailboxIds = enrollmentIds.map((_, index) => sendableMailboxIds[index % sendableMailboxIds.length]!);
  const updatedAt = new Date();
  // Leaving an expired mailbox clears that pause exactly as reconnecting it would;
  // every other pause (sequence, campaign) stays in place on the new sender.
  const authExpiredPause = sql`${schema.enrollments.status} = 'paused' and ${schema.enrollments.stopReason} = 'mailbox_auth_expired'`;
  const moved = await tx.update(schema.enrollments).set({
    emailAccountId: sql`assignment.email_account_id`,
    status: sql`case when ${authExpiredPause} then coalesce(${schema.enrollments.statusBeforePause}, 'active'::enrollment_status) else ${schema.enrollments.status} end`,
    statusBeforePause: sql`case when ${authExpiredPause} then null else ${schema.enrollments.statusBeforePause} end`,
    pausedAt: sql`case when ${authExpiredPause} then null else ${schema.enrollments.pausedAt} end`,
    stopReason: sql`case when ${authExpiredPause} then null else ${schema.enrollments.stopReason} end`,
    updatedAt,
  }).from(sql`unnest(${sql.param(enrollmentIds)}::uuid[], ${sql.param(assignedMailboxIds)}::uuid[]) as assignment(enrollment_id, email_account_id)`).where(and(
    sql`${schema.enrollments.id} = assignment.enrollment_id`,
    waitingForFirstSend,
  )).returning({ id: schema.enrollments.id });
  if (!moved.length) return 0;
  await tx.update(schema.messages).set({ emailAccountId: sql`${schema.enrollments.emailAccountId}`, updatedAt }).from(schema.enrollments).where(and(
    eq(schema.messages.workspaceId, workspaceId),
    eq(schema.messages.enrollmentId, schema.enrollments.id),
    sql`${schema.enrollments.id} = any(${sql.param(moved.map((enrollment) => enrollment.id))}::uuid[])`,
    inArray(schema.messages.status, ["scheduled", "retryable"]),
    isNull(schema.messages.acceptedAt),
    or(isNull(schema.messages.claimExpiresAt), sql`${schema.messages.claimExpiresAt} <= now()`),
  ));
  return moved.length;
}

// Deleting a mailbox from the app (status 'removed'). The row stays because sent
// messages and reply threads reference it, and campaign sender lists keep it: removing
// a campaign's last sender would turn its list empty, which means "all mailboxes".
// Its open leads are settled so no campaign waits on it forever:
// - leads it has not emailed yet move to the campaign's other sendable senders
//   (the same rule as sequences.setMailboxes); with no other sender they wait, and move
//   as soon as one is added to the campaign;
// - leads it already emailed are threaded to it, so they stop ('mailbox_removed').
export async function removeMailbox(db: InboxJoyDb, input: { workspaceId: string; mailboxId: string; now?: Date }): Promise<{ removed: boolean; reassigned: number; stopped: number }> {
  const { workspaceId, mailboxId } = input;
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    // The same lock as enrollment and sequences.setMailboxes: sender assignment must not race.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('send-capacity:' || ${workspaceId}::text))`);
    const [removed] = await tx.update(schema.emailAccounts).set({ status: "removed", updatedAt: now }).where(and(
      eq(schema.emailAccounts.id, mailboxId),
      eq(schema.emailAccounts.workspaceId, workspaceId),
      ne(schema.emailAccounts.status, "removed"),
    )).returning({ id: schema.emailAccounts.id });
    if (!removed) return { removed: false, reassigned: 0, stopped: 0 };

    const pinnedToMailbox = and(
      eq(schema.enrollments.workspaceId, workspaceId),
      eq(schema.enrollments.emailAccountId, mailboxId),
      inArray(schema.enrollments.status, OPEN_ENROLLMENT_STATUSES),
    );
    const sequences = await tx.selectDistinct({ sequenceId: schema.enrollments.sequenceId }).from(schema.enrollments).where(pinnedToMailbox);
    let reassigned = 0;
    if (sequences.length) {
      const workspaceMailboxes = await tx.select({
        id: schema.emailAccounts.id,
        status: schema.emailAccounts.status,
        email: schema.emailAccounts.email,
        healthState: schema.mailboxHealth.state,
      }).from(schema.emailAccounts)
        .leftJoin(schema.mailboxHealth, eq(schema.mailboxHealth.emailAccountId, schema.emailAccounts.id))
        .where(eq(schema.emailAccounts.workspaceId, workspaceId))
        .orderBy(schema.emailAccounts.id);
      for (const { sequenceId } of sequences) {
        const savedMailboxIds = await readSequenceMailboxIds(tx, workspaceId, sequenceId);
        const senders = savedMailboxIds.length ? workspaceMailboxes.filter((mailbox) => savedMailboxIds.includes(mailbox.id)) : workspaceMailboxes;
        reassigned += await reassignWaitingEnrollments(tx, {
          workspaceId,
          sequenceId,
          sendableMailboxIds: senders.filter(isSendableSequenceMailbox).map((mailbox) => mailbox.id),
          fromMailboxId: mailboxId,
        });
      }
    }

    const stopped = await tx.update(schema.enrollments).set({
      status: "cancelled",
      statusBeforePause: null,
      pausedAt: null,
      nextDueAt: null,
      stoppedAt: now,
      stopReason: "mailbox_removed",
      updatedAt: now,
    }).where(and(pinnedToMailbox, enrollmentHasStartedSending(workspaceId)))
      .returning({ id: schema.enrollments.id, campaignId: schema.enrollments.campaignId });
    if (stopped.length) {
      await tx.update(schema.messages).set({ status: "cancelled", blockedReason: "mailbox_removed", updatedAt: now }).where(and(
        eq(schema.messages.workspaceId, workspaceId),
        inArray(schema.messages.status, ["scheduled", "retryable"]),
        sql`${schema.messages.enrollmentId} = any(${sql.param(stopped.map((enrollment) => enrollment.id))}::uuid[])`,
      ));
      const campaignIds = new Set(stopped.flatMap((enrollment) => enrollment.campaignId ? [enrollment.campaignId] : []));
      for (const campaignId of campaignIds) await reconcileCampaignStatus(tx, { workspaceId, campaignId, now });
    }
    return { removed: true, reassigned, stopped: stopped.length };
  });
}
