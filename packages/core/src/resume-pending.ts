import { schema, type InboxJoyDb } from "@inboxjoy/db";
import { appendUnsubscribeFooter } from "@inboxjoy/email";
import { and, eq, inArray, max, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { followUpSendJitterMs } from "./index.js";
import { loadLeadVariables } from "./lead-variables.js";
import { renderTemplate } from "./template-variables.js";

type ResumeDb = Pick<InboxJoyDb, "select" | "update">;

const DAY_MS = 86_400_000;
const ENROLLMENT_BATCH_SIZE = 1000;

// Runs inside a resume transaction, before the paused enrollments are restored. Two fixes in one
// pass over each enrollment's next unsent email (status 'scheduled', never attempted):
//
// 1. Copy edited while paused reaches leads already in the campaign. Editing a paused sequence
//    saves a new version, but the next email was rendered when the previous one went out, so a
//    resumed lead used to get the old text. The waiting email is re-rendered from the step with
//    the same number in the current version and the enrollment moves to that version, so later
//    steps come from it too. Sent mail keeps its old step and version. A lead stays on its
//    version when the current one has no step at that number, a variable it uses has no value,
//    or the stored email has no unsubscribe link to carry over.
//
// 2. A pause no longer pushes follow-ups later. Follow-ups are due a step's wait after the
//    previous email went out (with the same jitter the worker uses), so one that came due while
//    paused goes out on resume, subject to the usual windows, gaps and caps. Shifting by the
//    pause length stacked on top of the scheduler's own retry bumps and held overdue emails
//    back for days. First emails keep their scheduled time. A rescheduled email drops its
//    blocked_reason: its time now comes from the sequence, not from a gate's retry, so getting
//    the license later (releasePlanBlockedSends) must not pull it forward. The gate sets the
//    reason again if it still applies when the email comes due.
export async function refreshPendingOnResume(
  tx: ResumeDb,
  input: { workspaceId: string; sequenceId: string; enrollmentIds: string[]; now: Date },
): Promise<{ remapped: number; rescheduled: number }> {
  const totals = { remapped: 0, rescheduled: 0 };
  // Batched so a large campaign stays under PostgreSQL's bind-parameter limit.
  for (let index = 0; index < input.enrollmentIds.length; index += ENROLLMENT_BATCH_SIZE) {
    const batch = await refreshBatch(tx, { ...input, enrollmentIds: input.enrollmentIds.slice(index, index + ENROLLMENT_BATCH_SIZE) });
    totals.remapped += batch.remapped;
    totals.rescheduled += batch.rescheduled;
  }
  return totals;
}

async function refreshBatch(
  tx: ResumeDb,
  input: { workspaceId: string; sequenceId: string; enrollmentIds: string[]; now: Date },
): Promise<{ remapped: number; rescheduled: number }> {
  const pending = await tx.select({
    messageId: schema.messages.id,
    enrollmentId: schema.messages.enrollmentId,
    contactId: schema.messages.contactId,
    scheduledAt: schema.messages.scheduledAt,
    metadata: schema.messages.metadata,
    stepOrder: schema.sequenceSteps.stepOrder,
    delayDays: schema.sequenceSteps.delayDays,
    enrollmentVersionId: schema.enrollments.sequenceVersionId,
  }).from(schema.messages)
    .innerJoin(schema.sequenceSteps, eq(schema.sequenceSteps.id, schema.messages.sequenceStepId))
    .innerJoin(schema.enrollments, eq(schema.enrollments.id, schema.messages.enrollmentId))
    .where(and(
      eq(schema.messages.workspaceId, input.workspaceId),
      eq(schema.enrollments.sequenceId, input.sequenceId),
      inArray(schema.messages.enrollmentId, input.enrollmentIds),
      eq(schema.messages.status, "scheduled"),
      sql`NOT EXISTS (SELECT 1 FROM send_attempts sa WHERE sa.message_id = ${schema.messages.id})`,
    ));
  if (!pending.length) return { remapped: 0, rescheduled: 0 };

  const [sequence] = await tx.select({ currentVersionId: schema.sequences.currentVersionId }).from(schema.sequences)
    .where(and(eq(schema.sequences.id, input.sequenceId), eq(schema.sequences.workspaceId, input.workspaceId)));
  const currentVersionId = sequence?.currentVersionId ?? null;
  const stale = currentVersionId ? pending.filter((row) => row.enrollmentVersionId !== currentVersionId) : [];
  const currentSteps = stale.length ? await tx.select().from(schema.sequenceSteps).where(and(
    eq(schema.sequenceSteps.workspaceId, input.workspaceId),
    eq(schema.sequenceSteps.sequenceVersionId, currentVersionId!),
  )) : [];
  const stepByOrder = new Map(currentSteps.map((step) => [step.stepOrder, step]));
  const [version] = stale.length ? await tx.select({ enforced: schema.sequenceVersions.customVariablesEnforced }).from(schema.sequenceVersions)
    .where(and(eq(schema.sequenceVersions.id, currentVersionId!), eq(schema.sequenceVersions.workspaceId, input.workspaceId))) : [];
  const renderOptions = { enforceCustom: version?.enforced !== false };
  const contactIds = stale.map((row) => row.contactId);
  const contacts = contactIds.length ? await tx.select().from(schema.contacts).where(and(eq(schema.contacts.workspaceId, input.workspaceId), inArray(schema.contacts.id, contactIds))) : [];
  const contactById = new Map(contacts.map((contact) => [contact.id, contact]));
  const campaignVariables = contactIds.length ? await loadLeadVariables(tx, input.workspaceId, input.sequenceId, contactIds) : new Map<string, Record<string, string>>();
  const [workspace] = stale.length ? await tx.select({ postalAddress: schema.workspaces.postalAddress }).from(schema.workspaces).where(eq(schema.workspaces.id, input.workspaceId)) : [];
  const postalAddress = workspace?.postalAddress?.trim() || null;

  const lastAccepted = await tx.select({ enrollmentId: schema.messages.enrollmentId, acceptedAt: max(schema.messages.acceptedAt) }).from(schema.messages)
    .where(and(
      eq(schema.messages.workspaceId, input.workspaceId),
      inArray(schema.messages.enrollmentId, pending.map((row) => row.enrollmentId)),
      eq(schema.messages.status, "accepted"),
    ))
    .groupBy(schema.messages.enrollmentId);
  const lastAcceptedAt = new Map(lastAccepted.flatMap((row) => row.acceptedAt ? [[row.enrollmentId, row.acceptedAt] as const] : []));

  let remapped = 0;
  let rescheduled = 0;
  for (const row of pending) {
    const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata as Record<string, unknown> : {};
    const unsubscribeUrl = typeof metadata.unsubscribeUrl === "string" ? metadata.unsubscribeUrl : null;
    const step = row.enrollmentVersionId !== currentVersionId ? stepByOrder.get(row.stepOrder) : undefined;
    const contact = contactById.get(row.contactId);
    let delayDays = row.delayDays;
    let content: { sequenceStepId: string; subject: string; bodyHash: string; metadata: Record<string, unknown> } | null = null;
    if (step && contact && unsubscribeUrl) {
      const source = {
        firstName: contact.firstName ?? "",
        lastName: contact.lastName ?? "",
        company: contact.company ?? "",
        title: contact.title ?? "",
        email: contact.email,
        customFields: contact.customFields && typeof contact.customFields === "object" && !Array.isArray(contact.customFields) ? contact.customFields as Record<string, unknown> : {},
        campaignVariables: campaignVariables.get(contact.id) ?? {},
      };
      const subject = renderTemplate(step.subject, source, renderOptions);
      const body = renderTemplate(step.bodyText, source, renderOptions);
      if (!subject.missing.length && !body.missing.length) {
        const bodyText = appendUnsubscribeFooter(body.text, unsubscribeUrl, postalAddress);
        content = {
          sequenceStepId: step.id,
          subject: subject.text,
          bodyHash: createHash("sha256").update(bodyText).digest("hex"),
          metadata: { ...metadata, bodyText, sequenceStepOrder: step.stepOrder },
        };
        delayDays = step.delayDays;
      }
    }
    const previousSentAt = row.stepOrder > 1 ? lastAcceptedAt.get(row.enrollmentId) : undefined;
    const scheduledAt = previousSentAt
      ? new Date(previousSentAt.getTime() + delayDays * DAY_MS + followUpSendJitterMs(`${row.enrollmentId}:${row.stepOrder}`))
      : row.scheduledAt;
    const moved = scheduledAt.getTime() !== row.scheduledAt.getTime();
    if (!content && !moved) continue;
    const [updated] = await tx.update(schema.messages).set({ ...(content ?? {}), scheduledAt, ...(moved ? { blockedReason: null } : {}), updatedAt: input.now }).where(and(
      eq(schema.messages.id, row.messageId),
      eq(schema.messages.status, "scheduled"),
    )).returning({ id: schema.messages.id });
    // Claimed by a send that was already queued: leave that lead exactly as it is.
    if (!updated) continue;
    await tx.update(schema.enrollments).set({ ...(content ? { sequenceVersionId: currentVersionId! } : {}), nextDueAt: scheduledAt, updatedAt: input.now })
      .where(eq(schema.enrollments.id, row.enrollmentId));
    if (content) remapped += 1;
    if (moved) rescheduled += 1;
  }
  return { remapped, rescheduled };
}
