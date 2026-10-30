import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { and, eq } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applySuppression, ingestInboundEvent, type InboundEvent, type IngestOptions } from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("shared inbound ingestion", () => {
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const mailboxId = randomUUID();
  const sequenceId = randomUUID();
  const versionId = randomUUID();
  const stepId = randomUUID();
  const followupStepId = randomUUID();
  const accountId = `inbound-connected-${mailboxId}`;
  const mailboxEmail = `inbound-sender-${mailboxId}@example.com`;

  beforeAll(async () => {
    const email = `inbound-owner-${userId}@example.com`;
    await db.insert(schema.users).values({ id: userId, email, normalizedEmail: email, displayName: "Inbound owner" });
    await db.insert(schema.workspaces).values({ id: workspaceId, name: "Inbound ingestion", slug: `inbound-${workspaceId}`, createdByUserId: userId });
    await db.insert(schema.emailAccounts).values({ id: mailboxId, workspaceId, userId, provider: "gmail", composioConnectedAccountId: accountId, email: mailboxEmail, normalizedEmail: mailboxEmail, alias: "inbound", status: "active" });
    await db.insert(schema.sequences).values({ id: sequenceId, workspaceId, name: "Inbound sequence", status: "active" });
    await db.insert(schema.sequenceVersions).values({ id: versionId, workspaceId, sequenceId, version: 1, status: "active" });
    await db.update(schema.sequences).set({ currentVersionId: versionId }).where(eq(schema.sequences.id, sequenceId));
    await db.insert(schema.sequenceSteps).values({ id: stepId, workspaceId, sequenceVersionId: versionId, stepOrder: 1, subject: "Intro", bodyText: "Hello" });
    await db.insert(schema.sequenceSteps).values({ id: followupStepId, workspaceId, sequenceVersionId: versionId, stepOrder: 2, subject: "Follow-up", bodyText: "Following up" });
  });

  afterAll(async () => {
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await pool.end();
  });

  // An enrollment that has already ended -- the sequence finished, or the lead replied
  // once -- stopped a day ago, so a later stop is visible against it.
  async function createHumanReplyEvent(messageText = "Yes, let's talk next week.", options: { enrollmentStatus?: "active" | "completed" | "replied"; subject?: string } = {}) {
    const contactId = randomUUID();
    const enrollmentId = randomUUID();
    const messageId = randomUUID();
    const email = `inbound-lead-${contactId}@example.com`;
    const acceptedAt = new Date(Date.now() - 2 * 86_400_000);
    const stoppedAt = new Date(Date.now() - 86_400_000);
    const enrollmentStatus = options.enrollmentStatus ?? "active";
    await db.insert(schema.contacts).values({ id: contactId, workspaceId, email, normalizedEmail: email, ...(enrollmentStatus === "replied" ? { status: "replied", repliedAt: stoppedAt } : { status: "enrolled" }) });
    await db.insert(schema.enrollments).values({ id: enrollmentId, workspaceId, contactId, sequenceId, sequenceVersionId: versionId, emailAccountId: mailboxId, status: enrollmentStatus, ...(enrollmentStatus === "active" ? {} : { stoppedAt, stopReason: enrollmentStatus === "completed" ? "sequence_completed" : "reply_detected" }) });
    await db.insert(schema.messages).values({ id: messageId, workspaceId, enrollmentId, sequenceStepId: stepId, emailAccountId: mailboxId, contactId, status: "accepted", idempotencyKey: `${enrollmentId}:1`, scheduledAt: acceptedAt, acceptedAt, recipientEmail: email, normalizedRecipientEmail: email, subject: "Intro", bodyHash: "inbound-original" });
    const eventId = `inbound-event-${randomUUID()}`;
    const logId = `inbound-log-${randomUUID()}`;
    const data = { message_id: `inbound-provider-message-${randomUUID()}`, thread_id: `inbound-thread-${randomUUID()}`, from: email, to: mailboxEmail, subject: options.subject ?? "Re: Intro", message_text: messageText };
    const payload = { type: "gmail_new_gmail_message", timestamp: new Date().toISOString(), metadata: { connected_account_id: accountId, trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE", log_id: logId }, data };
    const event: InboundEvent = {
      provider: "composio",
      eventId,
      logId,
      payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
      payload,
      data,
      eventType: payload.type,
      triggerSlug: payload.metadata.trigger_slug,
      accountId,
      timestamp: String(Math.floor(Date.now() / 1000)),
    };
    return { event, contactId, enrollmentId, messageId, email, stoppedAt };
  }

  async function conversationState(input: { contactId: string; enrollmentId: string; email: string; event: InboundEvent }) {
    const replies = await db.select().from(schema.replies).where(and(eq(schema.replies.workspaceId, workspaceId), eq(schema.replies.contactId, input.contactId)));
    const [enrollment] = await db.select().from(schema.enrollments).where(eq(schema.enrollments.id, input.enrollmentId));
    const [contact] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, input.contactId));
    const [messageEvent] = await db.select().from(schema.messageEvents).where(eq(schema.messageEvents.providerEventId, input.event.eventId));
    const replyNotifications = await db.select().from(schema.notifications).where(and(eq(schema.notifications.workspaceId, workspaceId), eq(schema.notifications.body, `${input.email} replied to your sequence.`)));
    return { replies, enrollment, contact, messageEvent, replyNotifications };
  }

  // An opt-out reply with a follow-up still queued behind the accepted first step.
  async function createOptOutEvent() {
    const created = await createHumanReplyEvent("Please unsubscribe me.");
    const followupId = randomUUID();
    await db.insert(schema.messages).values({ id: followupId, workspaceId, enrollmentId: created.enrollmentId, sequenceStepId: followupStepId, emailAccountId: mailboxId, contactId: created.contactId, status: "scheduled", idempotencyKey: `${created.enrollmentId}:2`, scheduledAt: new Date(Date.now() + 60_000), recipientEmail: created.email, normalizedRecipientEmail: created.email, subject: "Follow-up", bodyHash: "inbound-followup" });
    return { ...created, followupId };
  }

  async function optOutState(input: { contactId: string; enrollmentId: string; followupId: string; email: string; eventId: string }) {
    const [contact] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, input.contactId));
    const [enrollment] = await db.select().from(schema.enrollments).where(eq(schema.enrollments.id, input.enrollmentId));
    const [followup] = await db.select().from(schema.messages).where(eq(schema.messages.id, input.followupId));
    const [messageEvent] = await db.select().from(schema.messageEvents).where(eq(schema.messageEvents.providerEventId, input.eventId));
    const replies = await db.select().from(schema.replies).where(and(eq(schema.replies.workspaceId, workspaceId), eq(schema.replies.contactId, input.contactId)));
    const suppressions = await db.select().from(schema.suppressions).where(and(eq(schema.suppressions.workspaceId, workspaceId), eq(schema.suppressions.normalizedEmail, input.email)));
    const replyNotifications = await db.select().from(schema.notifications).where(and(eq(schema.notifications.workspaceId, workspaceId), eq(schema.notifications.body, `${input.email} replied to your sequence.`)));
    return { contact, enrollment, followup, messageEvent, replies, suppressions, replyNotifications };
  }

  it("suppresses a reply opt-out through the shared path without a second reply stop", async () => {
    const created = await createOptOutEvent();

    expect(await ingestInboundEvent(db, created.event, { applySuppression: (input) => applySuppression(db, input) })).toEqual({ received: true, duplicate: false });

    const result = await optOutState({ ...created, eventId: created.event.eventId });
    expect(result.suppressions).toHaveLength(1);
    expect(result.suppressions[0]).toMatchObject({ workspaceId, email: created.email, reason: "unsubscribed", source: "reply_opt_out" });
    expect(result.contact).toMatchObject({ status: "suppressed" });
    expect(result.contact?.unsubscribedAt).toBeInstanceOf(Date);
    // The cascade's stop stands: it is not overwritten by the ordinary reply stop.
    expect(result.enrollment).toMatchObject({ status: "unsubscribed", stopReason: "unsubscribed" });
    expect(result.followup).toMatchObject({ status: "cancelled", errorClass: "recipient_suppressed" });
    expect(result.messageEvent).toMatchObject({ workspaceId, eventType: "unsubscribed" });
    expect(result.replies).toHaveLength(1);
    expect(result.replies[0]).toMatchObject({ intent: "opt_out", isAutoReply: false });
    expect(result.replyNotifications).toHaveLength(0);
  });

  // Suppression is what normally stops an opt-out's enrollments. Whenever it did
  // not happen, the sequence must still stop -- as an ordinary reply.
  it.each<[string, IngestOptions["applySuppression"]]>([
    ["no suppression handler is wired", undefined],
    ["the suppression handler throws", async () => { throw new Error("suppression store unavailable"); }],
    ["the suppression handler reports nothing written", async () => null],
  ])("still stops the enrollment for a reply opt-out when %s", async (_label, handler) => {
    const created = await createOptOutEvent();

    expect(await ingestInboundEvent(db, created.event, { applySuppression: handler })).toEqual({ received: true, duplicate: false });

    const result = await optOutState({ ...created, eventId: created.event.eventId });
    expect(result.suppressions).toHaveLength(0);
    expect(result.enrollment).toMatchObject({ status: "replied", stopReason: "reply_detected" });
    expect(result.followup).toMatchObject({ status: "cancelled", errorClass: "reply_detected" });
    expect(result.messageEvent).toMatchObject({ workspaceId, eventType: "unsubscribed" });
    expect(result.replies).toHaveLength(1);
    expect(result.replies[0]).toMatchObject({ intent: "opt_out" });
    expect(result.replyNotifications).toHaveLength(1);
  });

  it("captures a human reply directly without an HTTP route", async () => {
    const { event, contactId, enrollmentId, messageId, email } = await createHumanReplyEvent();

    expect(await ingestInboundEvent(db, event)).toEqual({ received: true, duplicate: false });

    const replies = await db.select().from(schema.replies).where(and(eq(schema.replies.workspaceId, workspaceId), eq(schema.replies.contactId, contactId)));
    const [enrollment] = await db.select().from(schema.enrollments).where(eq(schema.enrollments.id, enrollmentId));
    const [messageEvent] = await db.select().from(schema.messageEvents).where(eq(schema.messageEvents.providerEventId, event.eventId));
    const [webhook] = await db.select().from(schema.providerWebhookEvents).where(and(eq(schema.providerWebhookEvents.provider, event.provider), eq(schema.providerWebhookEvents.eventId, event.eventId)));
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ workspaceId, contactId, enrollmentId, sequenceId, emailAccountId: mailboxId, inReplyToMessageId: messageId, fromEmail: email, providerMessageId: event.data.message_id, providerThreadId: event.data.thread_id, bodyText: event.data.message_text, intent: "human", isAutoReply: false, source: "webhook" });
    expect(enrollment).toMatchObject({ status: "replied", stopReason: "reply_detected" });
    expect(messageEvent).toMatchObject({ workspaceId, eventType: "replied" });
    expect(webhook).toMatchObject({ workspaceId, logId: event.logId, payloadHash: event.payloadHash, status: "processed", signatureTimestamp: new Date(Number(event.timestamp) * 1000) });
  });

  it("creates only one reply when the same event is ingested twice", async () => {
    const { event, contactId } = await createHumanReplyEvent();

    expect(await ingestInboundEvent(db, event)).toEqual({ received: true, duplicate: false });
    expect(await ingestInboundEvent(db, event)).toEqual({ received: true, duplicate: true });

    const replies = await db.select().from(schema.replies).where(and(eq(schema.replies.workspaceId, workspaceId), eq(schema.replies.contactId, contactId)));
    const messageEvents = await db.select().from(schema.messageEvents).where(eq(schema.messageEvents.providerEventId, event.eventId));
    const webhooks = await db.select().from(schema.providerWebhookEvents).where(and(eq(schema.providerWebhookEvents.provider, event.provider), eq(schema.providerWebhookEvents.eventId, event.eventId)));
    expect(replies).toHaveLength(1);
    expect(messageEvents).toHaveLength(1);
    expect(webhooks).toHaveLength(1);
  });

  it("captures and counts a reply that arrives after the sequence finished", async () => {
    const created = await createHumanReplyEvent("Sorry for the slow reply -- keen to chat.", { enrollmentStatus: "completed" });

    expect(await ingestInboundEvent(db, created.event)).toEqual({ received: true, duplicate: false });

    const result = await conversationState(created);
    expect(result.replies).toHaveLength(1);
    expect(result.replies[0]).toMatchObject({ enrollmentId: created.enrollmentId, sequenceId, emailAccountId: mailboxId, inReplyToMessageId: created.messageId, fromEmail: created.email, intent: "human", isAutoReply: false });
    expect(result.enrollment).toMatchObject({ status: "replied", stopReason: "reply_detected" });
    expect(result.enrollment!.stoppedAt!.getTime()).toBeGreaterThan(created.stoppedAt.getTime());
    expect(result.contact).toMatchObject({ status: "replied" });
    expect(result.messageEvent).toMatchObject({ workspaceId, eventType: "replied" });
    expect(result.replyNotifications).toHaveLength(1);
  });

  it("captures a lead's second message without moving their first reply", async () => {
    const created = await createHumanReplyEvent("One more thing -- can we do Thursday?", { enrollmentStatus: "replied" });

    expect(await ingestInboundEvent(db, created.event)).toEqual({ received: true, duplicate: false });

    const result = await conversationState(created);
    expect(result.replies).toHaveLength(1);
    expect(result.replies[0]).toMatchObject({ enrollmentId: created.enrollmentId, inReplyToMessageId: created.messageId, intent: "human" });
    expect(result.enrollment).toMatchObject({ status: "replied", stopReason: "reply_detected", stoppedAt: created.stoppedAt });
    expect(result.contact).toMatchObject({ status: "replied", repliedAt: created.stoppedAt });
    expect(result.replyNotifications).toHaveLength(1);
  });

  it("shows an auto-reply after the sequence finished without counting it as a reply", async () => {
    const created = await createHumanReplyEvent("I am away until Monday.", { enrollmentStatus: "completed", subject: "Out of office: Re: Intro" });

    expect(await ingestInboundEvent(db, created.event)).toEqual({ received: true, duplicate: false });

    const result = await conversationState(created);
    expect(result.replies).toHaveLength(1);
    expect(result.replies[0]).toMatchObject({ intent: "auto_reply", isAutoReply: true });
    expect(result.enrollment).toMatchObject({ status: "completed", stoppedAt: created.stoppedAt });
    expect(result.contact).toMatchObject({ status: "enrolled" });
    expect(result.messageEvent).toMatchObject({ eventType: "auto_reply" });
    expect(result.replyNotifications).toHaveLength(0);
  });

  it("suppresses an opt-out that arrives after the sequence finished", async () => {
    const created = await createHumanReplyEvent("Please unsubscribe me.", { enrollmentStatus: "completed" });

    expect(await ingestInboundEvent(db, created.event, { applySuppression: (input) => applySuppression(db, input) })).toEqual({ received: true, duplicate: false });

    const result = await conversationState(created);
    const suppressions = await db.select().from(schema.suppressions).where(and(eq(schema.suppressions.workspaceId, workspaceId), eq(schema.suppressions.normalizedEmail, created.email)));
    expect(suppressions).toHaveLength(1);
    expect(suppressions[0]).toMatchObject({ reason: "unsubscribed", source: "reply_opt_out" });
    expect(result.contact).toMatchObject({ status: "suppressed" });
    expect(result.enrollment).toMatchObject({ status: "completed" });
    expect(result.replies).toHaveLength(1);
    expect(result.replies[0]).toMatchObject({ intent: "opt_out" });
    expect(result.replyNotifications).toHaveLength(0);
  });

  it("ignores mail from someone who is not a lead", async () => {
    const created = await createHumanReplyEvent();
    const stranger = `inbound-stranger-${randomUUID()}@example.com`;
    const event: InboundEvent = { ...created.event, data: { ...created.event.data, from: stranger } };

    expect(await ingestInboundEvent(db, event)).toEqual({ received: true, duplicate: false });

    const replies = await db.select().from(schema.replies).where(and(eq(schema.replies.workspaceId, workspaceId), eq(schema.replies.fromEmail, stranger)));
    const [enrollment] = await db.select().from(schema.enrollments).where(eq(schema.enrollments.id, created.enrollmentId));
    expect(replies).toHaveLength(0);
    expect(enrollment).toMatchObject({ status: "active" });
  });
});
