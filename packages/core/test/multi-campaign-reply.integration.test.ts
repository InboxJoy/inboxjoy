import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { eq } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applySuppression, ingestInboundEvent, type InboundEvent } from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;

// A lead can be live in two campaigns on different mailboxes. A reply or opt-out
// received on one mailbox must end every live enrollment for that lead.
describe.skipIf(!databaseUrl)("replies and opt-outs stop every enrollment of a lead", () => {
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const mailboxA = randomUUID();
  const mailboxB = randomUUID();
  const accountA = `multi-a-${mailboxA}`;
  const mailboxAEmail = `multi-a-${mailboxA}@example.com`;
  const mailboxBEmail = `multi-b-${mailboxB}@example.com`;
  const sequences = [randomUUID(), randomUUID()];
  const versions = [randomUUID(), randomUUID()];
  const steps = [randomUUID(), randomUUID()];

  beforeAll(async () => {
    const email = `multi-owner-${userId}@example.com`;
    await db.insert(schema.users).values({ id: userId, email, normalizedEmail: email, displayName: "Multi owner" });
    await db.insert(schema.workspaces).values({ id: workspaceId, name: "Multi campaign", slug: `multi-${workspaceId}`, createdByUserId: userId });
    await db.insert(schema.emailAccounts).values([
      { id: mailboxA, workspaceId, userId, provider: "gmail", composioConnectedAccountId: accountA, email: mailboxAEmail, normalizedEmail: mailboxAEmail, alias: "multi-a", status: "active" },
      { id: mailboxB, workspaceId, userId, provider: "gmail", composioConnectedAccountId: `multi-b-${mailboxB}`, email: mailboxBEmail, normalizedEmail: mailboxBEmail, alias: "multi-b", status: "active" },
    ]);
    for (let index = 0; index < 2; index += 1) {
      await db.insert(schema.sequences).values({ id: sequences[index]!, workspaceId, name: `Multi ${index}`, status: "active" });
      await db.insert(schema.sequenceVersions).values({ id: versions[index]!, workspaceId, sequenceId: sequences[index]!, version: 1, status: "active" });
      await db.update(schema.sequences).set({ currentVersionId: versions[index]! }).where(eq(schema.sequences.id, sequences[index]!));
      await db.insert(schema.sequenceSteps).values({ id: steps[index]!, workspaceId, sequenceVersionId: versions[index]!, stepOrder: 1, subject: "Intro", bodyText: "Hello" });
    }
  });

  afterAll(async () => {
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await pool.end();
  });

  async function enrollInBoth(text: string) {
    const contactId = randomUUID();
    const email = `multi-lead-${contactId}@example.com`;
    await db.insert(schema.contacts).values({ id: contactId, workspaceId, email, normalizedEmail: email, status: "enrolled" });
    const enrollmentIds: string[] = [];
    const messageIds: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const enrollmentId = randomUUID();
      const mailboxId = index === 0 ? mailboxA : mailboxB;
      await db.insert(schema.enrollments).values({ id: enrollmentId, workspaceId, contactId, sequenceId: sequences[index]!, sequenceVersionId: versions[index]!, emailAccountId: mailboxId, status: "active" });
      const acceptedAt = new Date(Date.now() - 60_000);
      await db.insert(schema.messages).values({ id: randomUUID(), workspaceId, enrollmentId, sequenceStepId: steps[index]!, emailAccountId: mailboxId, contactId, status: "accepted", idempotencyKey: `${enrollmentId}:1`, scheduledAt: acceptedAt, acceptedAt, recipientEmail: email, normalizedRecipientEmail: email, subject: "Intro", bodyHash: `sent-${index}` });
      const pendingId = randomUUID();
      await db.insert(schema.messages).values({ id: pendingId, workspaceId, enrollmentId, sequenceStepId: steps[index]!, emailAccountId: mailboxId, contactId, status: "scheduled", idempotencyKey: `${enrollmentId}:2`, scheduledAt: new Date(Date.now() + 60_000), recipientEmail: email, normalizedRecipientEmail: email, subject: "Follow-up", bodyHash: `pending-${index}` });
      enrollmentIds.push(enrollmentId);
      messageIds.push(pendingId);
    }
    const eventId = `multi-event-${randomUUID()}`;
    const logId = `multi-log-${randomUUID()}`;
    const data = { message_id: `multi-message-${randomUUID()}`, thread_id: `multi-thread-${randomUUID()}`, from: email, to: mailboxAEmail, subject: "Re: Intro", message_text: text };
    const payload = { type: "gmail_new_gmail_message", timestamp: new Date().toISOString(), metadata: { connected_account_id: accountA, trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE", log_id: logId }, data };
    const event: InboundEvent = { provider: "composio", eventId, logId, payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"), payload, data, eventType: payload.type, triggerSlug: payload.metadata.trigger_slug, accountId: accountA, timestamp: String(Math.floor(Date.now() / 1000)) };
    return { event, contactId, enrollmentIds, messageIds };
  }

  async function states(enrollmentIds: string[], messageIds: string[]) {
    const enrollments = await Promise.all(enrollmentIds.map(async (id) => (await db.select().from(schema.enrollments).where(eq(schema.enrollments.id, id)))[0]!));
    const messages = await Promise.all(messageIds.map(async (id) => (await db.select().from(schema.messages).where(eq(schema.messages.id, id)))[0]!));
    return { enrollments, messages };
  }

  it("a reply received on one mailbox stops the enrollment on the other mailbox too", async () => {
    const created = await enrollInBoth("Sounds interesting, call me.");
    await ingestInboundEvent(db, created.event);
    const result = await states(created.enrollmentIds, created.messageIds);
    expect(result.enrollments.map((enrollment) => enrollment.status)).toEqual(["replied", "replied"]);
    expect(result.messages.map((message) => message.status)).toEqual(["cancelled", "cancelled"]);
    const [contact] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, created.contactId));
    expect(contact?.status).toBe("replied");
  });

  it("an opt-out reply suppresses the lead and stops both enrollments", async () => {
    const created = await enrollInBoth("Please unsubscribe me.");
    await ingestInboundEvent(db, created.event, { applySuppression: (input) => applySuppression(db, input) });
    const result = await states(created.enrollmentIds, created.messageIds);
    expect(result.enrollments.map((enrollment) => enrollment.status)).toEqual(["unsubscribed", "unsubscribed"]);
    expect(result.messages.map((message) => message.status)).toEqual(["cancelled", "cancelled"]);
  });

  it("a reply on a mailbox with no live enrollment still stops the live enrollment on another mailbox", async () => {
    const contactId = randomUUID();
    const email = `multi-lead-${contactId}@example.com`;
    await db.insert(schema.contacts).values({ id: contactId, workspaceId, email, normalizedEmail: email, status: "enrolled" });
    const liveId = randomUUID();
    const finishedId = randomUUID();
    await db.insert(schema.enrollments).values({ id: liveId, workspaceId, contactId, sequenceId: sequences[0]!, sequenceVersionId: versions[0]!, emailAccountId: mailboxA, status: "active" });
    await db.insert(schema.enrollments).values({ id: finishedId, workspaceId, contactId, sequenceId: sequences[1]!, sequenceVersionId: versions[1]!, emailAccountId: mailboxB, status: "completed" });
    const pendingId = randomUUID();
    await db.insert(schema.messages).values({ id: pendingId, workspaceId, enrollmentId: liveId, sequenceStepId: steps[0]!, emailAccountId: mailboxA, contactId, status: "scheduled", idempotencyKey: `${liveId}:2`, scheduledAt: new Date(Date.now() + 60_000), recipientEmail: email, normalizedRecipientEmail: email, subject: "Follow-up", bodyHash: `pending-${liveId}` });
    const accountB = `multi-b-${mailboxB}`;
    const logId = `multi-log-${randomUUID()}`;
    const data = { message_id: `multi-message-${randomUUID()}`, thread_id: `multi-thread-${randomUUID()}`, from: email, to: mailboxBEmail, subject: "Re: Intro", message_text: "Yes, let's talk." };
    const payload = { type: "gmail_new_gmail_message", timestamp: new Date().toISOString(), metadata: { connected_account_id: accountB, trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE", log_id: logId }, data };
    const event: InboundEvent = { provider: "composio", eventId: `multi-event-${randomUUID()}`, logId, payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"), payload, data, eventType: payload.type, triggerSlug: payload.metadata.trigger_slug, accountId: accountB, timestamp: String(Math.floor(Date.now() / 1000)) };
    await ingestInboundEvent(db, event);
    const result = await states([liveId, finishedId], [pendingId]);
    expect(result.enrollments.map((enrollment) => enrollment.status)).toEqual(["replied", "completed"]);
    expect(result.messages[0]?.status).toBe("cancelled");
    const [contact] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId));
    expect(contact?.status).toBe("replied");
    const replies = await db.select().from(schema.replies).where(eq(schema.replies.contactId, contactId));
    expect(replies.length).toBeGreaterThan(0);
  });
});
