import { loadAppEnv } from "@inboxjoy/config";
import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { createUnsubscribeToken } from "@inboxjoy/email";
import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { createAuthenticatedSession } from "./auth-helper.js";

const databaseUrl = process.env.DATABASE_URL;
let workspaceId = "";
let ownerId = "";
const authSecret = "integration-test-auth-secret-at-least-32-characters";

describe.skipIf(!databaseUrl)("unsubscribe persistence", () => {
  const ids = {
    mailbox: randomUUID(),
    contact: randomUUID(),
    sequence: randomUUID(),
    version: randomUUID(),
    step: randomUUID(),
    enrollment: randomUUID(),
    message: randomUUID(),
    attempt: randomUUID(),
    campaign: randomUUID(),
  };
  const suffix = randomUUID().slice(0, 8);
  const recipient = `unsubscribe-${suffix}@example.com`;
  const manualRecipient = `manual-${suffix}@example.com`;
  const pool = createPgPool(databaseUrl ?? "postgresql://postgres:postgres@localhost:5432/inboxjoy?sslmode=disable");
  const db = createDb(pool);
  const env = loadAppEnv({
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl ?? "postgresql://postgres:postgres@localhost:5432/inboxjoy?sslmode=disable",
    API_BASE_URL: "https://api.example.test",
    WEB_BASE_URL: "https://app.example.test",
    CORS_ORIGINS: "https://app.example.test",
    AUTH_SECRET: authSecret,
  });
  let app: Awaited<ReturnType<typeof buildApp>>;
  let session: Awaited<ReturnType<typeof createAuthenticatedSession>>;
  let seeded = false;

  beforeAll(async () => {
    app = await buildApp({ env, db });
    session = await createAuthenticatedSession(app);
    workspaceId = session.workspaceId;
    ownerId = session.userId;
    await db.insert(schema.emailAccounts).values({
      id: ids.mailbox,
      workspaceId,
      userId: ownerId,
      provider: "gmail",
      composioConnectedAccountId: `test-${suffix}`,
      email: `sender-${suffix}@example.com`,
      normalizedEmail: `sender-${suffix}@example.com`,
      alias: `sender-${suffix}`,
      status: "active",
    });
    await db.insert(schema.contacts).values({ id: ids.contact, workspaceId, email: recipient, normalizedEmail: recipient, status: "enrolled" });
    await db.insert(schema.sequences).values({ id: ids.sequence, workspaceId, name: `Test ${suffix}`, status: "active" });
    await db.insert(schema.sequenceVersions).values({ id: ids.version, workspaceId, sequenceId: ids.sequence, version: 1, status: "active" });
    await db.update(schema.sequences).set({ currentVersionId: ids.version }).where(eq(schema.sequences.id, ids.sequence));
    await db.insert(schema.sequenceSteps).values({ id: ids.step, workspaceId, sequenceVersionId: ids.version, stepOrder: 1, subject: "Hello", bodyText: "Hi" });
    await db.insert(schema.campaigns).values({ id: ids.campaign, workspaceId, sequenceId: ids.sequence, emailAccountId: ids.mailbox, name: "One-click finish", status: "active", launchedAt: new Date() });
    await db.insert(schema.enrollments).values({ id: ids.enrollment, workspaceId, campaignId: ids.campaign, contactId: ids.contact, sequenceId: ids.sequence, sequenceVersionId: ids.version, emailAccountId: ids.mailbox, status: "active" });
    await db.insert(schema.messages).values({
      id: ids.message,
      workspaceId,
      enrollmentId: ids.enrollment,
      sequenceStepId: ids.step,
      emailAccountId: ids.mailbox,
      contactId: ids.contact,
      status: "sending",
      idempotencyKey: `test:${ids.enrollment}:1`,
      scheduledAt: new Date(),
      claimedAt: new Date(),
      claimExpiresAt: new Date(Date.now() + 600_000),
      recipientEmail: recipient,
      normalizedRecipientEmail: recipient,
      subject: "Hello",
      bodyHash: "test",
    });
    await db.insert(schema.sendAttempts).values({ id: ids.attempt, workspaceId, messageId: ids.message, attemptNumber: 1, status: "sending" });
    seeded = true;
  });

  afterAll(async () => {
    await app?.close();
    if (seeded) {
      await db.delete(schema.unsubscribes).where(eq(schema.unsubscribes.contactId, ids.contact));
      await db.delete(schema.suppressions).where(and(eq(schema.suppressions.workspaceId, workspaceId), inArray(schema.suppressions.normalizedEmail, [recipient, manualRecipient])));
      await db.delete(schema.messages).where(eq(schema.messages.id, ids.message));
      await db.delete(schema.enrollments).where(eq(schema.enrollments.id, ids.enrollment));
      await db.delete(schema.sequences).where(eq(schema.sequences.id, ids.sequence));
      await db.delete(schema.contacts).where(eq(schema.contacts.id, ids.contact));
      await db.delete(schema.emailAccounts).where(eq(schema.emailAccounts.id, ids.mailbox));
    }
    await pool.end();
  });

  it("previews unsubscribe on GET and persists one-click POST", async () => {
    const token = createUnsubscribeToken({ workspaceId, contactId: ids.contact, normalizedEmail: recipient }, authSecret);
    const preview = await app.inject({ method: "GET", url: `/v1/unsubscribe?token=${encodeURIComponent(token)}` });
    expect(preview.statusCode).toBe(200);
    expect(preview.body).toContain("Confirm unsubscribe");

    const [previewContact] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, ids.contact));
    const previewRows = await db.select().from(schema.unsubscribes).where(eq(schema.unsubscribes.contactId, ids.contact));
    expect(previewContact?.status).toBe("enrolled");
    expect(previewRows).toHaveLength(0);

    const first = await app.inject({
      method: "POST",
      url: `/v1/unsubscribe?token=${encodeURIComponent(token)}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "List-Unsubscribe=One-Click",
    });
    expect(first.statusCode).toBe(200);

    const [contact] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, ids.contact));
    const [enrollment] = await db.select().from(schema.enrollments).where(eq(schema.enrollments.id, ids.enrollment));
    const [message] = await db.select().from(schema.messages).where(eq(schema.messages.id, ids.message));
    const [attempt] = await db.select().from(schema.sendAttempts).where(eq(schema.sendAttempts.id, ids.attempt));
    expect(contact?.status).toBe("suppressed");
    expect(enrollment?.status).toBe("unsubscribed");
    expect(message?.status).toBe("cancelled");
    expect(attempt?.status).toBe("cancelled");
    const [campaign] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, ids.campaign));
    expect(campaign).toMatchObject({ status: "completed" });
    expect(campaign?.completedAt).toBeInstanceOf(Date);

    const duplicate = await app.inject({ method: "POST", url: "/v1/unsubscribe", payload: { token } });
    expect(duplicate.statusCode).toBe(200);
    const unsubscribeRows = await db.select().from(schema.unsubscribes).where(eq(schema.unsubscribes.contactId, ids.contact));
    expect(unsubscribeRows).toHaveLength(1);
    const notifications = await db.select().from(schema.notifications).where(and(eq(schema.notifications.workspaceId, workspaceId), eq(schema.notifications.title, "Campaign completed: One-click finish")));
    expect(notifications).toHaveLength(1);
  });

  it("allows a manual suppression before a lead is imported", async () => {
    const response = await app.inject({ method: "POST", url: "/v1/suppressions", headers: { cookie: session.cookie }, payload: { email: manualRecipient, reason: "customer_request" } });
    expect(response.statusCode).toBe(201);
    const [suppression] = await db.select().from(schema.suppressions).where(and(eq(schema.suppressions.workspaceId, workspaceId), eq(schema.suppressions.normalizedEmail, manualRecipient)));
    expect(suppression?.source).toBe("manual");
  });

  it.each(["pause", "archive"] as const)("persists a one-click unsubscribe concurrently with campaign %s", async (action) => {
    const contactId = randomUUID();
    const enrollmentId = randomUUID();
    const campaignId = randomUUID();
    const messageId = randomUUID();
    const email = `concurrent-unsubscribe-${contactId}@example.com`;
    await db.insert(schema.contacts).values({ id: contactId, workspaceId, email, normalizedEmail: email, status: "enrolled" });
    await db.insert(schema.campaigns).values({ id: campaignId, workspaceId, sequenceId: ids.sequence, emailAccountId: ids.mailbox, name: "Concurrent unsubscribe", status: "active", launchedAt: new Date() });
    await db.insert(schema.enrollments).values({ id: enrollmentId, workspaceId, contactId, campaignId, sequenceId: ids.sequence, sequenceVersionId: ids.version, emailAccountId: ids.mailbox, status: "active" });
    await db.insert(schema.messages).values({ id: messageId, workspaceId, enrollmentId, sequenceStepId: ids.step, emailAccountId: ids.mailbox, contactId, status: "scheduled", idempotencyKey: messageId, scheduledAt: new Date(), recipientEmail: email, normalizedRecipientEmail: email, subject: "Concurrent", bodyHash: "concurrent" });
    try {
      const token = createUnsubscribeToken({ workspaceId, contactId, normalizedEmail: email }, authSecret);
      const [unsubscribe, lifecycle] = await Promise.all([
        app.inject({ method: "POST", url: `/v1/unsubscribe?token=${encodeURIComponent(token)}`, payload: { "List-Unsubscribe": "One-Click" } }),
        app.inject({ method: "POST", headers: { cookie: session.cookie }, url: `/v1/campaigns/${campaignId}/${action}` }),
      ]);
      expect(unsubscribe.statusCode).toBe(200);
      expect(action === "pause" ? [200, 409] : [200]).toContain(lifecycle.statusCode);
      expect(unsubscribe.json()).toMatchObject({ unsubscribed: true });
      const [suppression] = await db.select().from(schema.suppressions).where(and(eq(schema.suppressions.workspaceId, workspaceId), eq(schema.suppressions.normalizedEmail, email)));
      expect(suppression).toMatchObject({ source: "one_click_unsubscribe" });
      expect(await db.select().from(schema.unsubscribes).where(eq(schema.unsubscribes.contactId, contactId))).toHaveLength(1);
      expect((await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId)))[0]?.status).toBe("suppressed");
      expect(["unsubscribed", "cancelled"]).toContain((await db.select().from(schema.enrollments).where(eq(schema.enrollments.id, enrollmentId)))[0]?.status);
      expect((await db.select().from(schema.messages).where(eq(schema.messages.id, messageId)))[0]?.status).toBe("cancelled");
    } finally {
      await db.delete(schema.contacts).where(eq(schema.contacts.id, contactId));
      await db.delete(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
      await db.delete(schema.suppressions).where(and(eq(schema.suppressions.workspaceId, workspaceId), eq(schema.suppressions.normalizedEmail, email)));
    }
  });

  // Regression: the manual operation used to write only the suppression row, so a
  // manually suppressed contact kept status "enrolled" with live enrollments and
  // queued messages. Sends were blocked (the send path checks suppressions), but
  // the records lied, and the one-click path cascaded while this one did not.
  it("cascades a manual suppression to the contact, enrollments and queued messages", async () => {
    const cascadeIds = { contact: randomUUID(), enrollment: randomUUID(), message: randomUUID() };
    const cascadeEmail = `cascade-${suffix}@example.com`;
    await db.insert(schema.contacts).values({ id: cascadeIds.contact, workspaceId, email: cascadeEmail, normalizedEmail: cascadeEmail, status: "enrolled" });
    await db.insert(schema.enrollments).values({ id: cascadeIds.enrollment, workspaceId, contactId: cascadeIds.contact, sequenceId: ids.sequence, sequenceVersionId: ids.version, emailAccountId: ids.mailbox, status: "active" });
    await db.insert(schema.messages).values({
      id: cascadeIds.message,
      workspaceId,
      enrollmentId: cascadeIds.enrollment,
      sequenceStepId: ids.step,
      emailAccountId: ids.mailbox,
      contactId: cascadeIds.contact,
      status: "scheduled",
      idempotencyKey: `cascade:${cascadeIds.enrollment}:1`,
      scheduledAt: new Date(),
      recipientEmail: cascadeEmail,
      normalizedRecipientEmail: cascadeEmail,
      subject: "Hello",
      bodyHash: "cascade",
    });

    try {
      const response = await app.inject({ method: "POST", url: "/v1/suppressions", headers: { cookie: session.cookie }, payload: { email: cascadeEmail, reason: "customer_request" } });
      expect(response.statusCode).toBe(201);

      const [contact] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, cascadeIds.contact));
      expect(contact?.status).toBe("suppressed");
      expect(contact?.unsubscribedAt).not.toBeNull();

      const [enrollment] = await db.select().from(schema.enrollments).where(eq(schema.enrollments.id, cascadeIds.enrollment));
      expect(enrollment?.status).toBe("unsubscribed");

      const [message] = await db.select().from(schema.messages).where(eq(schema.messages.id, cascadeIds.message));
      expect(message?.status).toBe("cancelled");
      expect(message?.errorClass).toBe("recipient_suppressed");
    } finally {
      await db.delete(schema.suppressions).where(and(eq(schema.suppressions.workspaceId, workspaceId), eq(schema.suppressions.normalizedEmail, cascadeEmail)));
      await db.delete(schema.messages).where(eq(schema.messages.id, cascadeIds.message));
      await db.delete(schema.enrollments).where(eq(schema.enrollments.id, cascadeIds.enrollment));
      await db.delete(schema.contacts).where(eq(schema.contacts.id, cascadeIds.contact));
    }
  });
});
