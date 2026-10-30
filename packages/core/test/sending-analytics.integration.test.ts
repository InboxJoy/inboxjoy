import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { operationByName, runOperation, type OperationContext } from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;

function operation(name: string) {
  const found = operationByName.get(name);
  if (!found) throw new Error(`Missing operation ${name}`);
  return found;
}

describe.skipIf(!databaseUrl)("sending analytics summary", () => {
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);
  let userId = "";
  let workspaceId = "";
  let sequenceId = "";
  let versionId = "";
  let stepId = "";
  let mailboxId = "";

  function context(): OperationContext {
    return {
      db,
      workspaceId,
      userId,
      env: {
        edition: "selfhost",
        authSecret: "sending-analytics-test-auth-secret-at-least-32-chars",
        apiBaseUrl: "https://api.example.test",
      },
    };
  }

  beforeAll(async () => {
    await pool.query("select 1");
  });

  beforeEach(async () => {
    userId = randomUUID();
    workspaceId = randomUUID();
    sequenceId = randomUUID();
    versionId = randomUUID();
    stepId = randomUUID();
    mailboxId = randomUUID();
    const suffix = randomUUID().slice(0, 8);
    const mailboxEmail = `analytics-mailbox-${suffix}@example.com`;

    await db.insert(schema.users).values({
      id: userId,
      email: `analytics-user-${suffix}@example.com`,
      normalizedEmail: `analytics-user-${suffix}@example.com`,
      displayName: "Analytics Test",
    });
    await db.insert(schema.workspaces).values({
      id: workspaceId,
      name: `Analytics ${suffix}`,
      slug: `analytics-${suffix}`,
      createdByUserId: userId,
    });
    await db.insert(schema.emailAccounts).values({
      id: mailboxId,
      workspaceId,
      userId,
      provider: "gmail",
      composioConnectedAccountId: `analytics-${suffix}`,
      email: mailboxEmail,
      normalizedEmail: mailboxEmail,
      alias: `analytics-${suffix}`,
      status: "active",
    });
    await db.insert(schema.sequences).values({ id: sequenceId, workspaceId, name: "Analytics sequence", status: "active", createdByUserId: userId });
    await db.insert(schema.sequenceVersions).values({ id: versionId, workspaceId, sequenceId, version: 1, status: "active", snapshot: {}, launchedAt: new Date(), createdByUserId: userId });
    await db.update(schema.sequences).set({ currentVersionId: versionId }).where(eq(schema.sequences.id, sequenceId));
    await db.insert(schema.sequenceSteps).values({ id: stepId, workspaceId, sequenceVersionId: versionId, stepOrder: 1, subject: "Analytics", bodyText: "Analytics" });
  });

  afterEach(async () => {
    if (workspaceId) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    if (userId) await db.delete(schema.users).where(eq(schema.users.id, userId));
  });

  afterAll(async () => {
    await pool.end();
  });

  it("separates human and bot opens and counts distinct soft-bounced messages", async () => {
    const now = new Date();
    const contactIds = Array.from({ length: 5 }, () => randomUUID());
    const enrollmentIds = Array.from({ length: 5 }, () => randomUUID());
    const messageIds = Array.from({ length: 5 }, () => randomUUID());
    const emails = contactIds.map((_, index) => `analytics-contact-${index}-${randomUUID()}@example.com`);

    await db.insert(schema.contacts).values(contactIds.map((id, index) => ({
      id,
      workspaceId,
      email: emails[index]!,
      normalizedEmail: emails[index]!,
      status: "active",
    })));
    await db.insert(schema.enrollments).values(enrollmentIds.map((id, index) => ({
      id,
      workspaceId,
      contactId: contactIds[index]!,
      sequenceId,
      sequenceVersionId: versionId,
      emailAccountId: mailboxId,
      status: "active" as const,
      startedAt: now,
    })));
    await db.insert(schema.messages).values(messageIds.map((id, index) => ({
      id,
      workspaceId,
      enrollmentId: enrollmentIds[index]!,
      sequenceStepId: stepId,
      emailAccountId: mailboxId,
      contactId: contactIds[index]!,
      status: "accepted" as const,
      idempotencyKey: `analytics-${id}`,
      scheduledAt: now,
      acceptedAt: now,
      recipientEmail: emails[index]!,
      normalizedRecipientEmail: emails[index]!,
      subject: "Analytics",
      bodyHash: `body-${id}`,
    })));

    await db.insert(schema.messageEvents).values([
      { id: randomUUID(), workspaceId, messageId: messageIds[0]!, eventType: "opened", occurredAt: now, metadata: { source: "tracking_pixel", bot: true } },
      { id: randomUUID(), workspaceId, messageId: messageIds[1]!, eventType: "opened", occurredAt: now, metadata: { source: "tracking_pixel", bot: true } },
      { id: randomUUID(), workspaceId, messageId: messageIds[1]!, eventType: "opened", occurredAt: now, metadata: { source: "tracking_pixel", bot: false } },
      { id: randomUUID(), workspaceId, messageId: messageIds[2]!, eventType: "opened", occurredAt: now, metadata: { source: "tracking_pixel" } },
      ...["soft_bounce", "mailbox_full", "rate_limit", "temporary_provider_error", "auth_failure"].map((eventType, index) => ({
        id: randomUUID(),
        workspaceId,
        messageId: messageIds[index]!,
        eventType,
        occurredAt: now,
      })),
      { id: randomUUID(), workspaceId, messageId: messageIds[0]!, eventType: "auto_reply", occurredAt: now },
    ]);

    const analytics = await runOperation(operation("analytics.summary"), context(), { range: 7 });
    const today = now.toISOString().slice(0, 10);

    expect(analytics.summary).toMatchObject({
      sent: 5,
      opened: 3,
      humanOpened: 2,
      botOpened: 1,
      softBounced: 5,
      openRate: 40,
    });
    expect(analytics.summary.series).toEqual(expect.arrayContaining([
      expect.objectContaining({ date: today, opened: 3, humanOpened: 2 }),
    ]));

    const sequenceAnalytics = await runOperation(operation("sequences.analytics"), context(), { id: sequenceId });
    expect(sequenceAnalytics.totals).toMatchObject({ opened: 2, openRate: 40 });
    expect(sequenceAnalytics.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ stepId, opened: 2, openRate: 40 }),
    ]));
  });

  it("reports unsubscribe rates and attributes opt-outs to the last sent step", async () => {
    const now = new Date();
    const secondStepId = randomUUID();
    await db.insert(schema.sequenceSteps).values({ id: secondStepId, workspaceId, sequenceVersionId: versionId, stepOrder: 2, subject: "Follow-up", bodyText: "Follow-up" });

    const contactIds = Array.from({ length: 97 }, () => randomUUID());
    const enrollmentIds = Array.from({ length: 97 }, () => randomUUID());
    const emails = contactIds.map((_, index) => `unsubscribe-contact-${index}-${randomUUID()}@example.com`);
    await db.insert(schema.contacts).values(contactIds.map((id, index) => ({
      id,
      workspaceId,
      email: emails[index]!,
      normalizedEmail: emails[index]!,
      status: index < 3 ? "unsubscribed" as const : "active" as const,
    })));
    await db.insert(schema.enrollments).values(enrollmentIds.map((id, index) => ({
      id,
      workspaceId,
      contactId: contactIds[index]!,
      sequenceId,
      sequenceVersionId: versionId,
      emailAccountId: mailboxId,
      status: index < 3 ? "unsubscribed" as const : "active" as const,
      startedAt: now,
      stoppedAt: index < 3 ? now : null,
    })));

    const firstStepMessages = enrollmentIds.map((enrollmentId, index) => ({
      id: randomUUID(),
      workspaceId,
      enrollmentId,
      sequenceStepId: stepId,
      emailAccountId: mailboxId,
      contactId: contactIds[index]!,
      status: "accepted" as const,
      idempotencyKey: `unsubscribe-first-${enrollmentId}`,
      scheduledAt: new Date(now.getTime() - 60_000),
      acceptedAt: new Date(now.getTime() - 60_000),
      recipientEmail: emails[index]!,
      normalizedRecipientEmail: emails[index]!,
      subject: "Analytics",
      bodyHash: `first-${enrollmentId}`,
    }));
    const secondStepMessages = enrollmentIds.slice(0, 3).map((enrollmentId, index) => ({
      id: randomUUID(),
      workspaceId,
      enrollmentId,
      sequenceStepId: secondStepId,
      emailAccountId: mailboxId,
      contactId: contactIds[index]!,
      status: "accepted" as const,
      idempotencyKey: `unsubscribe-second-${enrollmentId}`,
      scheduledAt: now,
      acceptedAt: now,
      recipientEmail: emails[index]!,
      normalizedRecipientEmail: emails[index]!,
      subject: "Follow-up",
      bodyHash: `second-${enrollmentId}`,
    }));
    await db.insert(schema.messages).values([...firstStepMessages, ...secondStepMessages]);

    const sequenceAnalytics = await runOperation(operation("sequences.analytics"), context(), { id: sequenceId });
    expect(sequenceAnalytics.totals).toMatchObject({ sent: 100, unsubscribed: 3, unsubscribeRate: 3 });
    expect(sequenceAnalytics.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ stepId, sent: 97, unsubscribed: 0, unsubscribeRate: 0 }),
      expect.objectContaining({ stepId: secondStepId, sent: 3, unsubscribed: 3, unsubscribeRate: 100 }),
    ]));

    const listed = await runOperation(operation("sequences.list"), context(), {});
    expect(listed.sequences).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: sequenceId, unsubscribed: 3, unsubscribeRate: 3 }),
    ]));

    const workspaceAnalytics = await runOperation(operation("analytics.summary"), context(), { range: 7 });
    expect(workspaceAnalytics.summary.bySequence).toEqual(expect.arrayContaining([
      expect.objectContaining({ sequenceId, sent: 100, unsubscribed: 3, unsubscribeRate: 3 }),
    ]));

    const zeroSequenceId = randomUUID();
    const zeroVersionId = randomUUID();
    const zeroStepId = randomUUID();
    const zeroContactId = randomUUID();
    const zeroEnrollmentId = randomUUID();
    const zeroEmail = `zero-sent-${randomUUID()}@example.com`;
    await db.insert(schema.sequences).values({ id: zeroSequenceId, workspaceId, name: "Zero sent sequence", status: "active", createdByUserId: userId });
    await db.insert(schema.sequenceVersions).values({ id: zeroVersionId, workspaceId, sequenceId: zeroSequenceId, version: 1, status: "active", snapshot: {}, launchedAt: now, createdByUserId: userId });
    await db.update(schema.sequences).set({ currentVersionId: zeroVersionId }).where(eq(schema.sequences.id, zeroSequenceId));
    await db.insert(schema.sequenceSteps).values({ id: zeroStepId, workspaceId, sequenceVersionId: zeroVersionId, stepOrder: 1, subject: "No sends", bodyText: "No sends" });
    await db.insert(schema.contacts).values({ id: zeroContactId, workspaceId, email: zeroEmail, normalizedEmail: zeroEmail, status: "unsubscribed" });
    await db.insert(schema.enrollments).values({ id: zeroEnrollmentId, workspaceId, contactId: zeroContactId, sequenceId: zeroSequenceId, sequenceVersionId: zeroVersionId, emailAccountId: mailboxId, status: "unsubscribed", startedAt: now, stoppedAt: now });

    const zeroSentAnalytics = await runOperation(operation("sequences.analytics"), context(), { id: zeroSequenceId });
    expect(zeroSentAnalytics.totals).toMatchObject({ sent: 0, unsubscribed: 1, unsubscribeRate: 0 });
    expect(zeroSentAnalytics.steps).toEqual([
      expect.objectContaining({ stepId: zeroStepId, sent: 0, unsubscribed: 0, unsubscribeRate: 0 }),
    ]);
  });
});
