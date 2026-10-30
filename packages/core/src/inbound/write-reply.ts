import { schema, type InboxJoyDb } from "@inboxjoy/db";
import { and, desc, eq, inArray, notInArray, or, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";

import { reconcileCampaignStatus } from "../campaign-status.js";
import { retryTransaction } from "../transaction-retry.js";
import {
  classifyBounceWebhook,
  classifyDeliveryStatusBounce,
  classifyReplyIntent,
  extractMessageIdentifiers,
  extractReplyContent,
  extractSenderEmail,
  extractSuppressibleRecipientEmails,
  isComplaintWebhook,
  isPermanentBounce,
  record,
  stringValue,
  suppressibleRecipientEmails,
  type BounceClassification,
  type DeliveryStatusBounce,
  type ExtractedReplyContent,
} from "./classify.js";
import type { InboundEvent, IngestOptions } from "./ingest-inbound-event.js";

export async function writeWebhookSuppressions(
  db: Pick<InboxJoyDb, "insert">,
  input: { workspaceId: string; emails: string[]; reason: "bounced" | "complained"; eventId: string; classification?: BounceClassification },
): Promise<void> {
  const emails = [...new Set(input.emails.map((email) => email.trim().toLowerCase()).filter(Boolean))];
  if (!emails.length) return;
  await db.insert(schema.suppressions).values(emails.map((email) => ({
    id: randomUUID(),
    workspaceId: input.workspaceId,
    email,
    normalizedEmail: email,
    emailHash: createHash("sha256").update(email).digest("hex"),
    reason: input.reason,
    source: "provider_webhook",
    evidence: { eventId: input.eventId, classification: input.classification },
  }))).onConflictDoNothing();
}

export async function writeInboundReply(
  db: Pick<InboxJoyDb, "select" | "insert">,
  input: {
    workspaceId: string;
    contactId: string;
    enrollmentId: string;
    sequenceId: string;
    emailAccountId: string;
    fromEmail: string;
    isAutoReply?: boolean;
    intent?: string;
    content: ExtractedReplyContent;
  },
): Promise<void> {
  const [message] = await db.select({ id: schema.messages.id }).from(schema.messages).where(and(
    eq(schema.messages.workspaceId, input.workspaceId),
    eq(schema.messages.enrollmentId, input.enrollmentId),
    eq(schema.messages.status, "accepted"),
  )).orderBy(desc(schema.messages.acceptedAt), desc(schema.messages.createdAt)).limit(1);

  await db.insert(schema.replies).values({
    id: randomUUID(),
    workspaceId: input.workspaceId,
    contactId: input.contactId,
    enrollmentId: input.enrollmentId,
    sequenceId: input.sequenceId,
    emailAccountId: input.emailAccountId,
    inReplyToMessageId: message?.id,
    providerMessageId: input.content.providerMessageId,
    providerThreadId: input.content.providerThreadId,
    subject: input.content.subject,
    bodyText: input.content.bodyText,
    snippet: input.content.snippet,
    fromEmail: input.fromEmail,
    receivedAt: input.content.receivedAt,
    isAutoReply: input.isAutoReply ?? false,
    intent: input.intent ?? "human",
    source: "webhook",
  }).onConflictDoNothing();
}

export async function writeInboundEvent(
  db: InboxJoyDb,
  event: InboundEvent,
  webhookAccount: typeof schema.emailAccounts.$inferSelect | undefined,
  options: IngestOptions,
): Promise<void> {
  if (event.bounce) {
    for (const [index, bounce] of event.bounce.entries()) {
      if (!classifyDeliveryStatusBounce(bounce)) continue;
      await writeClassifiedInboundEvent(db, { ...event, eventId: index ? `${event.eventId}:${index}` : event.eventId }, webhookAccount, options, bounce);
    }
    return;
  }
  await writeClassifiedInboundEvent(db, event, webhookAccount, options);
}

async function writeClassifiedInboundEvent(
  db: InboxJoyDb,
  event: InboundEvent,
  webhookAccount: typeof schema.emailAccounts.$inferSelect | undefined,
  options: IngestOptions,
  bounce?: DeliveryStatusBounce,
): Promise<void> {
  const { eventId, accountId, eventType = "unknown", triggerSlug = "" } = event;
  const payload = record(event.payload);
  const data = event.data;

  if (accountId && /expir|revok|disconnect/i.test(eventType)) await options.onAccountExpired?.(accountId);

  const complaint = !bounce && isComplaintWebhook(payload, eventType, triggerSlug);
  const bounceClassification = bounce ? classifyDeliveryStatusBounce(bounce) : classifyBounceWebhook(payload, eventType, triggerSlug);

  if (webhookAccount && bounceClassification === "auto_reply") {
    const sender = extractSenderEmail(data);
    const recipientEmails = sender
      ? suppressibleRecipientEmails([sender], webhookAccount.normalizedEmail)
      : extractSuppressibleRecipientEmails(payload, "bounce", webhookAccount.normalizedEmail);
    const contacts = recipientEmails.length
      ? await db.select({ id: schema.contacts.id }).from(schema.contacts).where(and(eq(schema.contacts.workspaceId, webhookAccount.workspaceId), inArray(schema.contacts.normalizedEmail, recipientEmails)))
      : [];
    const [message] = contacts.length
      ? await db.select({ id: schema.messages.id }).from(schema.messages).where(and(
        eq(schema.messages.workspaceId, webhookAccount.workspaceId),
        inArray(schema.messages.contactId, contacts.map((contact) => contact.id)),
        eq(schema.messages.status, "accepted"),
      )).orderBy(desc(schema.messages.acceptedAt), desc(schema.messages.createdAt)).limit(1)
      : [];
    await db.insert(schema.messageEvents).values({ id: randomUUID(), workspaceId: webhookAccount.workspaceId, messageId: message?.id, eventType: "auto_reply", providerEventId: eventId, occurredAt: stringValue(payload.timestamp) ? new Date(String(payload.timestamp)) : new Date(), metadata: { triggerSlug, connectedAccountId: accountId ?? webhookAccount.composioConnectedAccountId, sender, recipientEmails, classification: bounceClassification } }).onConflictDoNothing();
  } else if (webhookAccount && (complaint || bounceClassification)) {
    const recipientEmails = bounce
      ? suppressibleRecipientEmails([bounce.recipient], webhookAccount.normalizedEmail)
      : extractSuppressibleRecipientEmails(payload, complaint ? "complaint" : "bounce", webhookAccount.normalizedEmail);
    const contacts = recipientEmails.length
      ? await db.select().from(schema.contacts).where(and(eq(schema.contacts.workspaceId, webhookAccount.workspaceId), inArray(schema.contacts.normalizedEmail, recipientEmails)))
      : [];
    if (recipientEmails.length) {
      const now = new Date();
      const permanent = complaint || (bounceClassification ? isPermanentBounce(bounceClassification) : false);
      const active = contacts.length
        ? await db.select({ id: schema.enrollments.id, contactId: schema.enrollments.contactId, campaignId: schema.enrollments.campaignId }).from(schema.enrollments).where(and(
          eq(schema.enrollments.workspaceId, webhookAccount.workspaceId),
          inArray(schema.enrollments.contactId, contacts.map((contact) => contact.id)),
          inArray(schema.enrollments.status, ["scheduled", "active", "paused"]),
        ))
        : [];

      if (permanent) {
        await retryTransaction(() => db.transaction(async (tx) => {
          const campaignIds = [...new Set(active.flatMap((enrollment) => enrollment.campaignId ? [enrollment.campaignId] : []))];
          if (campaignIds.length) await tx.select({ id: schema.campaigns.id }).from(schema.campaigns).where(and(eq(schema.campaigns.workspaceId, webhookAccount.workspaceId), inArray(schema.campaigns.id, campaignIds))).orderBy(schema.campaigns.id).for("update");
          await writeWebhookSuppressions(tx, {
            workspaceId: webhookAccount.workspaceId,
            emails: recipientEmails,
            reason: complaint ? "complained" : "bounced",
            eventId,
            classification: bounceClassification,
          });

          const enrollmentIds = active.map((item) => item.id);
          const contactIds = contacts.map((item) => item.id);
          const messageIdentifiers = extractMessageIdentifiers(payload);
          let [message] = messageIdentifiers.length
            ? await tx.select({ id: schema.messages.id }).from(schema.messages).where(and(
              eq(schema.messages.workspaceId, webhookAccount.workspaceId),
              inArray(schema.messages.normalizedRecipientEmail, recipientEmails),
              eq(schema.messages.status, "accepted"),
              or(
                inArray(schema.messages.providerMessageId, messageIdentifiers),
                inArray(schema.messages.internetMessageId, messageIdentifiers),
              ),
            )).orderBy(desc(schema.messages.acceptedAt), desc(schema.messages.createdAt)).limit(1)
            : [];
          if (!message && recipientEmails.length) {
            [message] = await tx.select({ id: schema.messages.id }).from(schema.messages).where(and(
              eq(schema.messages.workspaceId, webhookAccount.workspaceId),
              inArray(schema.messages.normalizedRecipientEmail, recipientEmails),
              eq(schema.messages.status, "accepted"),
            )).orderBy(desc(schema.messages.acceptedAt), desc(schema.messages.createdAt)).limit(1);
          }
          // Last-resort fallback for provider payloads without a usable recipient or
          // message identifier. Contact recency can be ambiguous across campaigns.
          if (!message && contactIds.length) {
            [message] = await tx.select({ id: schema.messages.id }).from(schema.messages).where(and(
              eq(schema.messages.workspaceId, webhookAccount.workspaceId),
              inArray(schema.messages.contactId, contactIds),
              eq(schema.messages.status, "accepted"),
            )).orderBy(desc(schema.messages.acceptedAt), desc(schema.messages.createdAt)).limit(1);
          }
          const eventClass = complaint ? "complained" : bounceClassification!;
          const errorMessage = complaint ? "Recipient reported the message as spam" : `Recipient delivery failed: ${eventClass}`;

          if (message) await tx.update(schema.messages).set({ bouncedAt: now, errorClass: eventClass, errorMessage, blockedReason: eventClass, updatedAt: now }).where(eq(schema.messages.id, message.id));
          if (enrollmentIds.length) {
            await tx.update(schema.enrollments).set({ status: "bounced", stoppedAt: now, stopReason: complaint ? "complaint_detected" : eventClass, nextDueAt: null, updatedAt: now }).where(inArray(schema.enrollments.id, enrollmentIds));
            const cancellableMessages = await tx.select({ id: schema.messages.id }).from(schema.messages).where(and(inArray(schema.messages.enrollmentId, enrollmentIds), inArray(schema.messages.status, ["scheduled", "retryable", "claimed", "sending"])));
            const messageIds = cancellableMessages.map((item) => item.id);
            if (messageIds.length) {
              await tx.update(schema.messages).set({ status: "cancelled", errorClass: eventClass, errorMessage, blockedReason: eventClass, claimExpiresAt: null, updatedAt: now }).where(inArray(schema.messages.id, messageIds));
              await tx.update(schema.sendAttempts).set({ status: "cancelled", errorClass: eventClass, errorMessage, finishedAt: now }).where(and(inArray(schema.sendAttempts.messageId, messageIds), eq(schema.sendAttempts.status, "sending")));
            }
          }
          if (contactIds.length) await tx.update(schema.contacts).set({ status: complaint ? "suppressed" : "bounced", bouncedAt: complaint ? undefined : now, updatedAt: now }).where(inArray(schema.contacts.id, contactIds));
          await tx.insert(schema.messageEvents).values({ id: randomUUID(), workspaceId: webhookAccount.workspaceId, messageId: message?.id, eventType: eventClass, providerEventId: eventId, occurredAt: stringValue(payload.timestamp) ? new Date(String(payload.timestamp)) : now, metadata: { triggerSlug, connectedAccountId: accountId ?? webhookAccount.composioConnectedAccountId, recipientEmails, classification: bounceClassification } }).onConflictDoNothing();
          await tx.insert(schema.notifications).values({ id: randomUUID(), workspaceId: webhookAccount.workspaceId, type: complaint ? "complaint" : "bounce", title: complaint ? "Spam complaint received" : "Email permanently rejected", body: `${recipientEmails[0] ?? "A recipient"} ${complaint ? "reported the message as spam" : `failed with ${String(eventClass).replaceAll("_", " ")}`}.` });
          for (const campaignId of [...new Set(active.flatMap((item) => item.campaignId ? [item.campaignId] : []))].sort()) {
            await reconcileCampaignStatus(tx, { workspaceId: webhookAccount.workspaceId, campaignId, now });
          }
        }));
      } else if (!contacts.length) {
        // A bounce-shaped inbound whose recipients are not workspace contacts is
        // someone else's mail (another tool's DSN, a service receipt) arriving in
        // the connected inbox. It is not our delivery problem: no event, and no
        // "Temporary delivery issue" notification naming a stranger's address.
        options.logger?.info({ triggerSlug, recipientEmails, bounceClassification }, "Ignored bounce webhook with no matching workspace contact");
      } else {
        const contactIds = contacts.map((item) => item.id);
        const [message] = contactIds.length
          ? await db.select({ id: schema.messages.id }).from(schema.messages).where(and(
            eq(schema.messages.workspaceId, webhookAccount.workspaceId),
            inArray(schema.messages.contactId, contactIds),
            eq(schema.messages.status, "accepted"),
          )).orderBy(desc(schema.messages.acceptedAt), desc(schema.messages.createdAt)).limit(1)
          : [];
        await db.insert(schema.messageEvents).values({ id: randomUUID(), workspaceId: webhookAccount.workspaceId, messageId: message?.id, eventType: bounceClassification!, providerEventId: eventId, occurredAt: stringValue(payload.timestamp) ? new Date(String(payload.timestamp)) : now, metadata: { triggerSlug, connectedAccountId: accountId ?? webhookAccount.composioConnectedAccountId, recipientEmails, classification: bounceClassification } }).onConflictDoNothing();
        await db.insert(schema.notifications).values({ id: randomUUID(), workspaceId: webhookAccount.workspaceId, type: "delivery_warning", title: "Temporary delivery issue", body: `${recipientEmails[0] ?? "A recipient"} had a temporary delivery issue (${bounceClassification}).` });
      }
    }
  } else if (webhookAccount && !/SENT/i.test(triggerSlug) && /NEW.*(MESSAGE|EMAIL)|MESSAGE.*RECEIVED|(?:^|_)MESSAGE_TRIGGER$/i.test(triggerSlug)) {
    const sender = extractSenderEmail(data);
    if (sender && sender !== webhookAccount.normalizedEmail) {
      const [contact] = await db.select().from(schema.contacts).where(and(eq(schema.contacts.workspaceId, webhookAccount.workspaceId), eq(schema.contacts.normalizedEmail, sender)));
      if (contact) {
        const active = await db.select({ id: schema.enrollments.id, campaignId: schema.enrollments.campaignId, sequenceId: schema.enrollments.sequenceId }).from(schema.enrollments).where(and(
          eq(schema.enrollments.workspaceId, webhookAccount.workspaceId),
          eq(schema.enrollments.contactId, contact.id),
          eq(schema.enrollments.emailAccountId, webhookAccount.id),
          inArray(schema.enrollments.status, ["scheduled", "active", "paused"]),
        ));
        // A lead can be live in several campaigns at once, sending from different mailboxes.
        // A reply or opt-out ends the conversation everywhere, so every live enrollment of
        // this contact stops, not only the ones on the mailbox that received the message.
        const liveEnrollments = await db.select({ id: schema.enrollments.id, campaignId: schema.enrollments.campaignId, sequenceId: schema.enrollments.sequenceId }).from(schema.enrollments).where(and(
          eq(schema.enrollments.workspaceId, webhookAccount.workspaceId),
          eq(schema.enrollments.contactId, contact.id),
          inArray(schema.enrollments.status, ["scheduled", "active", "paused"]),
        ));
        // With nothing live -- the sequence finished, or the lead already replied once --
        // the message is still their conversation and belongs in the Inbox. It goes to the
        // latest enrollment that actually emailed them, preferring the receiving mailbox.
        const [pastEnrollment] = liveEnrollments.length ? [] : await db.select({ id: schema.enrollments.id, sequenceId: schema.enrollments.sequenceId, status: schema.enrollments.status })
          .from(schema.enrollments)
          .innerJoin(schema.messages, eq(schema.messages.enrollmentId, schema.enrollments.id))
          .where(and(
            eq(schema.enrollments.workspaceId, webhookAccount.workspaceId),
            eq(schema.enrollments.contactId, contact.id),
            eq(schema.messages.status, "accepted"),
          ))
          .orderBy(sql`case when ${schema.enrollments.emailAccountId} = ${webhookAccount.id} then 0 else 1 end`, sql`${schema.messages.acceptedAt} desc nulls last`)
          .limit(1);
        if (liveEnrollments.length || pastEnrollment) {
          // The reply is attributed to the enrollment on the receiving mailbox when there is
          // one, otherwise to another live enrollment of the same contact.
          const enrollment = active[0] ?? liveEnrollments[0] ?? pastEnrollment!;
          const enrollmentIds = liveEnrollments.map((item) => item.id);
          // An autoresponder is recorded so it shows in the Inbox, but it must
          // not stop the sequence: doing so drops a live prospect who never
          // actually answered, and inflates the reply rate with machines.
          const intent = classifyReplyIntent(data);
          const auto = intent === "auto_reply";
          const optOut = intent === "opt_out";
          // "Unsubscribe" is a legal obligation, not a reply. It must stop every
          // campaign for this contact and keep them off future ones, so it goes
          // through the shared suppression path rather than this sequence's stop.
          let suppressed = false;
          if (optOut && options.applySuppression) {
            try {
              // The handler resolves with the suppression it wrote; an empty
              // result is it reporting that it wrote nothing.
              suppressed = await options.applySuppression({
                workspaceId: webhookAccount.workspaceId,
                normalizedEmail: sender,
                email: sender,
                reason: "unsubscribed",
                source: "reply_opt_out",
                contactId: contact.id,
              }) != null;
            } catch (error) {
              options.logger?.error({ err: error, eventId, sender }, "Failed to suppress reply opt-out");
            }
          }
          // Safety net: suppression is what stops an opt-out's enrollments. If it
          // did not run (no handler, or it failed) the cascade never happened, so
          // the opt-out falls back to the ordinary reply stop below. Someone who
          // asked us to stop must never keep receiving the sequence because the
          // suppression write failed.
          if (optOut && !suppressed) options.logger?.error({ eventId, sender }, "Reply opt-out was not suppressed; stopping the sequence as a reply instead");
          const stopAsReply = !auto && (!optOut || !suppressed);
          await retryTransaction(() => db.transaction(async (tx) => {
            const campaignIds = [...new Set(liveEnrollments.flatMap((enrollment) => enrollment.campaignId ? [enrollment.campaignId] : []))];
            if (campaignIds.length) await tx.select({ id: schema.campaigns.id }).from(schema.campaigns).where(and(eq(schema.campaigns.workspaceId, webhookAccount.workspaceId), inArray(schema.campaigns.id, campaignIds))).orderBy(schema.campaigns.id).for("update");
            // A reply after the last step is still that campaign's reply: it counts toward the
            // reply rate and keeps the lead out of future campaigns. A message after an earlier
            // reply, opt-out or bounce only adds to the conversation. Nothing is resent either way.
            if (stopAsReply && pastEnrollment) {
              if (pastEnrollment.status === "completed") await tx.update(schema.enrollments).set({ status: "replied", stoppedAt: new Date(), stopReason: "reply_detected", updatedAt: new Date() }).where(and(eq(schema.enrollments.id, pastEnrollment.id), eq(schema.enrollments.status, "completed")));
              await tx.update(schema.contacts).set({ status: "replied", repliedAt: new Date(), updatedAt: new Date() }).where(and(eq(schema.contacts.id, contact.id), notInArray(schema.contacts.status, ["replied", "bounced", "suppressed", "unsubscribed"])));
            }
            if (stopAsReply && liveEnrollments.length) {
              await tx.update(schema.enrollments).set({ status: "replied", stoppedAt: new Date(), stopReason: "reply_detected", updatedAt: new Date() }).where(inArray(schema.enrollments.id, enrollmentIds));
              const cancellableMessages = await tx.select({ id: schema.messages.id }).from(schema.messages).where(and(inArray(schema.messages.enrollmentId, enrollmentIds), inArray(schema.messages.status, ["scheduled", "retryable", "claimed", "sending"])));
              const messageIds = cancellableMessages.map((message) => message.id);
              if (messageIds.length) {
                await tx.update(schema.messages).set({ status: "cancelled", errorClass: "reply_detected", claimExpiresAt: null, updatedAt: new Date() }).where(inArray(schema.messages.id, messageIds));
                await tx.update(schema.sendAttempts).set({ status: "cancelled", errorClass: "reply_detected", errorMessage: "Recipient replied", finishedAt: new Date() }).where(and(inArray(schema.sendAttempts.messageId, messageIds), eq(schema.sendAttempts.status, "sending")));
              }
              await tx.update(schema.contacts).set({ status: "replied", repliedAt: new Date(), updatedAt: new Date() }).where(eq(schema.contacts.id, contact.id));
            }
            try {
              await tx.transaction(async (replyTx) => {
                await writeInboundReply(replyTx, {
                  workspaceId: webhookAccount.workspaceId,
                  contactId: contact.id,
                  enrollmentId: enrollment.id,
                  sequenceId: enrollment.sequenceId,
                  emailAccountId: webhookAccount.id,
                  fromEmail: sender,
                  isAutoReply: auto,
                  intent,
                  content: extractReplyContent(data, payload.timestamp),
                });
              });
            } catch (error) {
              options.logger?.error({ err: error, eventId, sender }, "Failed to capture inbound reply");
            }
            await tx.insert(schema.messageEvents).values({ id: randomUUID(), workspaceId: webhookAccount.workspaceId, eventType: optOut ? "unsubscribed" : auto ? "auto_reply" : "replied", providerEventId: eventId, occurredAt: stringValue(payload.timestamp) ? new Date(String(payload.timestamp)) : new Date(), metadata: { triggerSlug, sender, connectedAccountId: accountId ?? webhookAccount.composioConnectedAccountId } }).onConflictDoNothing();
            if (!stopAsReply) return;
            await tx.insert(schema.notifications).values({ id: randomUUID(), workspaceId: webhookAccount.workspaceId, type: "reply", title: "New reply", body: `${sender} replied to your sequence.` });
            for (const campaignId of [...new Set(liveEnrollments.flatMap((item) => item.campaignId ? [item.campaignId] : []))].sort()) {
              await reconcileCampaignStatus(tx, { workspaceId: webhookAccount.workspaceId, campaignId });
            }
          }));
        }
      }
    }
  }
}
