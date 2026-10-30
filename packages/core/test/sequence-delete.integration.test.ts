import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { operationByName, runOperation, type OperationContext } from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;

function operation(name: string) {
  const found = operationByName.get(name);
  if (!found) throw new Error(`Missing operation ${name}`);
  return found;
}

describe.skipIf(!databaseUrl)("sequence deletion", () => {
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);

  beforeAll(async () => {
    await pool.query("select 1");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("deletes dependent campaign data without crossing workspace boundaries", async () => {
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const workspaceId = randomUUID();
    const otherWorkspaceId = randomUUID();
    const sequenceId = randomUUID();
    const otherSequenceId = randomUUID();
    const versionId = randomUUID();
    const stepId = randomUUID();
    const campaignId = randomUUID();
    const contactId = randomUUID();
    const mailboxId = randomUUID();
    const enrollmentId = randomUUID();
    const messageId = randomUUID();
    const sendAttemptId = randomUUID();
    const messageEventId = randomUUID();
    const suffix = randomUUID().slice(0, 8);
    const now = new Date();
    const futureClaim = new Date(now.getTime() + 5 * 60_000);

    const context = (activeWorkspaceId: string, activeUserId: string): OperationContext => ({
      db,
      workspaceId: activeWorkspaceId,
      userId: activeUserId,
      env: {
        edition: "selfhost",
        authSecret: "sequence-delete-test-auth-secret-at-least-32-chars",
        apiBaseUrl: "https://api.example.test",
      },
    });

    try {
      await db.insert(schema.users).values([
        { id: userId, email: `delete-${suffix}@example.com`, normalizedEmail: `delete-${suffix}@example.com`, displayName: "Delete Test" },
        { id: otherUserId, email: `delete-other-${suffix}@example.com`, normalizedEmail: `delete-other-${suffix}@example.com`, displayName: "Other Delete Test" },
      ]);
      await db.insert(schema.workspaces).values([
        { id: workspaceId, name: `Delete ${suffix}`, slug: `delete-${suffix}`, createdByUserId: userId },
        { id: otherWorkspaceId, name: `Delete other ${suffix}`, slug: `delete-other-${suffix}`, createdByUserId: otherUserId },
      ]);
      await db.insert(schema.memberships).values([
        { id: randomUUID(), workspaceId, userId, role: "owner", status: "active", joinedAt: now },
        { id: randomUUID(), workspaceId: otherWorkspaceId, userId: otherUserId, role: "owner", status: "active", joinedAt: now },
      ]);
      await db.insert(schema.emailAccounts).values({
        id: mailboxId,
        workspaceId,
        userId,
        provider: "gmail",
        composioConnectedAccountId: `delete-${suffix}`,
        email: `sender-${suffix}@example.com`,
        normalizedEmail: `sender-${suffix}@example.com`,
        alias: `delete-${suffix}`,
        status: "active",
      });
      await db.insert(schema.contacts).values({
        id: contactId,
        workspaceId,
        email: `lead-${suffix}@example.com`,
        normalizedEmail: `lead-${suffix}@example.com`,
        status: "active",
      });
      await db.insert(schema.sequences).values([
        { id: sequenceId, workspaceId, name: "Sequence to delete", status: "active", createdByUserId: userId },
        { id: otherSequenceId, workspaceId: otherWorkspaceId, name: "Other workspace sequence", status: "draft", createdByUserId: otherUserId },
      ]);
      await db.insert(schema.sequenceVersions).values({ id: versionId, workspaceId, sequenceId, version: 1, status: "active", snapshot: {}, createdByUserId: userId });
      await db.update(schema.sequences).set({ currentVersionId: versionId }).where(eq(schema.sequences.id, sequenceId));
      await db.insert(schema.sequenceSteps).values({ id: stepId, workspaceId, sequenceVersionId: versionId, stepOrder: 1, subject: "Delete me", bodyText: "Delete me" });
      await db.insert(schema.campaigns).values({ id: campaignId, workspaceId, sequenceId, emailAccountId: mailboxId, name: "Delete campaign", status: "active", createdByUserId: userId });
      await db.insert(schema.enrollments).values({ id: enrollmentId, workspaceId, contactId, sequenceId, sequenceVersionId: versionId, campaignId, emailAccountId: mailboxId, status: "active" });
      await db.insert(schema.messages).values({
        id: messageId,
        workspaceId,
        enrollmentId,
        sequenceStepId: stepId,
        emailAccountId: mailboxId,
        contactId,
        status: "sending",
        claimExpiresAt: futureClaim,
        idempotencyKey: `delete-${messageId}`,
        scheduledAt: now,
        acceptedAt: now,
        recipientEmail: `lead-${suffix}@example.com`,
        normalizedRecipientEmail: `lead-${suffix}@example.com`,
        subject: "Delete me",
        bodyHash: `delete-${messageId}`,
      });
      await db.insert(schema.sendAttempts).values({ id: sendAttemptId, workspaceId, messageId, attemptNumber: 1, status: "accepted", startedAt: now, finishedAt: now });
      await db.insert(schema.messageEvents).values({ id: messageEventId, workspaceId, messageId, eventType: "delivered", occurredAt: now });

      await expect(runOperation(operation("sequences.delete"), context(otherWorkspaceId, otherUserId), { id: sequenceId })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(db.select({ id: schema.sequences.id }).from(schema.sequences).where(eq(schema.sequences.id, sequenceId))).resolves.toHaveLength(1);

      await expect(runOperation(operation("sequences.delete"), context(workspaceId, userId), { id: sequenceId })).rejects.toMatchObject({
        code: "CONFLICT",
        message: "This campaign has sends in progress. Pause it and try again in a few minutes.",
      });
      await expect(db.select({ id: schema.sequences.id }).from(schema.sequences).where(eq(schema.sequences.id, sequenceId))).resolves.toHaveLength(1);
      await expect(db.select({ id: schema.sequenceVersions.id }).from(schema.sequenceVersions).where(eq(schema.sequenceVersions.id, versionId))).resolves.toHaveLength(1);
      await expect(db.select({ id: schema.sequenceSteps.id }).from(schema.sequenceSteps).where(eq(schema.sequenceSteps.id, stepId))).resolves.toHaveLength(1);
      await expect(db.select({ id: schema.campaigns.id }).from(schema.campaigns).where(eq(schema.campaigns.id, campaignId))).resolves.toHaveLength(1);
      await expect(db.select({ id: schema.enrollments.id }).from(schema.enrollments).where(eq(schema.enrollments.id, enrollmentId))).resolves.toHaveLength(1);
      await expect(db.select({ id: schema.messages.id }).from(schema.messages).where(eq(schema.messages.id, messageId))).resolves.toHaveLength(1);
      await expect(db.select({ id: schema.sendAttempts.id }).from(schema.sendAttempts).where(eq(schema.sendAttempts.id, sendAttemptId))).resolves.toHaveLength(1);
      await expect(db.select({ id: schema.messageEvents.id }).from(schema.messageEvents).where(eq(schema.messageEvents.id, messageEventId))).resolves.toHaveLength(1);

      await db.update(schema.messages).set({ claimExpiresAt: new Date(now.getTime() - 1) }).where(eq(schema.messages.id, messageId));
      await expect(runOperation(operation("sequences.delete"), context(workspaceId, userId), { id: sequenceId })).resolves.toEqual({ deleted: true, id: sequenceId });

      await expect(db.select({ id: schema.sequences.id }).from(schema.sequences).where(eq(schema.sequences.id, sequenceId))).resolves.toHaveLength(0);
      await expect(db.select({ id: schema.sequenceVersions.id }).from(schema.sequenceVersions).where(eq(schema.sequenceVersions.id, versionId))).resolves.toHaveLength(0);
      await expect(db.select({ id: schema.sequenceSteps.id }).from(schema.sequenceSteps).where(eq(schema.sequenceSteps.id, stepId))).resolves.toHaveLength(0);
      await expect(db.select({ id: schema.campaigns.id }).from(schema.campaigns).where(eq(schema.campaigns.id, campaignId))).resolves.toHaveLength(0);
      await expect(db.select({ id: schema.enrollments.id }).from(schema.enrollments).where(eq(schema.enrollments.id, enrollmentId))).resolves.toHaveLength(0);
      await expect(db.select({ id: schema.messages.id }).from(schema.messages).where(eq(schema.messages.id, messageId))).resolves.toHaveLength(0);
      await expect(db.select({ id: schema.sendAttempts.id }).from(schema.sendAttempts).where(eq(schema.sendAttempts.id, sendAttemptId))).resolves.toHaveLength(0);
      await expect(db.select({ id: schema.messageEvents.id }).from(schema.messageEvents).where(eq(schema.messageEvents.id, messageEventId))).resolves.toHaveLength(0);
      await expect(db.select({ id: schema.sequences.id }).from(schema.sequences).where(eq(schema.sequences.id, otherSequenceId))).resolves.toHaveLength(1);
    } finally {
      await db.delete(schema.sendAttempts).where(eq(schema.sendAttempts.id, sendAttemptId));
      await db.delete(schema.messageEvents).where(eq(schema.messageEvents.id, messageEventId));
      await db.delete(schema.messages).where(eq(schema.messages.id, messageId));
      await db.delete(schema.enrollments).where(eq(schema.enrollments.id, enrollmentId));
      await db.update(schema.sequences).set({ currentVersionId: null }).where(eq(schema.sequences.id, sequenceId));
      await db.delete(schema.sequenceSteps).where(eq(schema.sequenceSteps.id, stepId));
      await db.delete(schema.sequenceVersions).where(eq(schema.sequenceVersions.id, versionId));
      await db.delete(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
      await db.delete(schema.sequences).where(eq(schema.sequences.id, sequenceId));
      await db.delete(schema.sequences).where(eq(schema.sequences.id, otherSequenceId));
      await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
      await db.delete(schema.workspaces).where(eq(schema.workspaces.id, otherWorkspaceId));
      await db.delete(schema.users).where(eq(schema.users.id, userId));
      await db.delete(schema.users).where(eq(schema.users.id, otherUserId));
    }
  });
});
