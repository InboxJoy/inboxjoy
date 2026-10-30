import { loadAppEnv } from "@inboxjoy/config";
import { followUpSendJitterMs } from "@inboxjoy/core";
import { createDb, createPgPool, schema } from "@inboxjoy/db";
import type { ComposioClient } from "@inboxjoy/composio";
import { disabledTransactionalEmailService, type TransactionalEmailService } from "@inboxjoy/email";
import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { createAuthenticatedSession } from "./auth-helper.js";

const databaseUrl = process.env.DATABASE_URL;
let workspaceId = "";
let ownerId = "";
const authSecret = "sequence-integration-auth-secret-at-least-32-characters";

describe.skipIf(!databaseUrl)("sequence campaign engine", () => {
  const suffix = randomUUID().slice(0, 8);
  const ids = { mailbox: randomUUID(), mailbox2: randomUUID(), list: randomUUID(), sequence: randomUUID(), duplicate: "", noPostal: "" };
  const contactIds = Array.from({ length: 6 }, () => randomUUID());
  const suppressionContactIds = Array.from({ length: 3 }, () => randomUUID());
  const suppressionEmails = suppressionContactIds.map((_, index) => `manual-suppression-${suffix}-${index}@example.com`);
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);
  const azureSent: Array<{ to: string; subject: string; body: string }> = [];
  const composio: ComposioClient = {
    enabled: true,
    createConnectLink: async () => null,
    getConnectedAccount: async () => null,
    ensureInboundMessageTrigger: async () => ({ triggerId: "test", triggerSlug: "test" }),
    sendEmail: async () => { throw new Error("Composio sendEmail should not run in sequence integration tests."); },
    findSentMessage: async () => "unknown",
  };
  const transactionalEmail: TransactionalEmailService = {
    ...disabledTransactionalEmailService,
    enabled: true,
    senderAddress: `azure-${suffix}@example.com`,
    async sendWelcome() {},
    async sendPasswordReset() {},
    async sendSequenceTest(input) { azureSent.push({ to: input.recipient.email, subject: input.subject, body: input.plainText }); },
  };
  const env = loadAppEnv({ ...process.env, NODE_ENV: "test", DATABASE_URL: databaseUrl ?? "postgresql://localhost/inboxjoy_test", API_BASE_URL: "https://api.example.test", WEB_BASE_URL: "https://app.example.test", CORS_ORIGINS: "https://app.example.test", AUTH_SECRET: authSecret });
  let app: Awaited<ReturnType<typeof buildApp>>;
  let session: Awaited<ReturnType<typeof createAuthenticatedSession>>;

  async function createSequenceEditFixture(input: {
    sequenceStatus?: "active" | "paused" | "archived";
    campaignStatus?: "active" | "paused" | "completed" | "archived";
    enrollmentStatuses?: Array<typeof schema.enrollments.$inferSelect.status>;
  } = {}) {
    const sequenceId = randomUUID();
    const listId = randomUUID();
    const campaignId = randomUUID();
    const mailboxId = randomUUID();
    const versionIds = [randomUUID(), randomUUID()];
    const enrollmentStatuses = input.enrollmentStatuses ?? ["completed", "replied", "bounced", "unsubscribed", "cancelled"];
    const historicalContactIds = enrollmentStatuses.map(() => randomUUID());
    const fixtureContactIds: string[] = [...historicalContactIds];
    const completedAt = new Date("2026-09-01T12:00:00Z");
    await db.insert(schema.emailAccounts).values({ id: mailboxId, workspaceId, userId: ownerId, provider: "gmail", composioConnectedAccountId: `sequence-edit-${sequenceId}`, email: `sender-${sequenceId}@example.com`, normalizedEmail: `sender-${sequenceId}@example.com`, alias: `sequence-edit-${sequenceId}`, status: "active" });
    await db.insert(schema.contactLists).values({ id: listId, workspaceId, name: `Sequence edit ${sequenceId}` });
    await db.insert(schema.sequences).values({ id: sequenceId, workspaceId, name: `Sequence edit ${sequenceId}`, status: input.sequenceStatus ?? "active" });
    await db.insert(schema.sequenceVersions).values(versionIds.map((versionId, index) => ({ id: versionId, workspaceId, sequenceId, version: index + 1, status: index === 1 ? input.sequenceStatus ?? "active" : "active", snapshot: { description: `Original version ${index + 1}`, lastSuccessfulTestSendAt: completedAt.toISOString(), enrolledCount: historicalContactIds.length } })));
    await db.update(schema.sequences).set({ currentVersionId: versionIds[1] }).where(eq(schema.sequences.id, sequenceId));
    await db.insert(schema.sequenceSteps).values(versionIds.flatMap((versionId, index) => [
      { id: randomUUID(), workspaceId, sequenceVersionId: versionId, stepOrder: 1, delayDays: 0, subject: `Original ${index + 1}`, bodyText: `Original body ${index + 1}` },
      { id: randomUUID(), workspaceId, sequenceVersionId: versionId, stepOrder: 2, delayDays: 2, subject: `Follow up ${index + 1}`, bodyText: `Follow up body ${index + 1}` },
    ]));
    await db.insert(schema.campaigns).values({ id: campaignId, workspaceId, sequenceId, contactListId: listId, emailAccountId: mailboxId, name: `Finished campaign ${sequenceId}`, status: input.campaignStatus ?? "completed", launchedAt: new Date("2026-08-01T12:00:00Z"), completedAt, createdByUserId: ownerId });
    await db.insert(schema.campaignContactLists).values({ campaignId, contactListId: listId, workspaceId });
    if (historicalContactIds.length) {
      await db.insert(schema.contacts).values(historicalContactIds.map((contactId) => ({ id: contactId, workspaceId, email: `past-${contactId}@example.com`, normalizedEmail: `past-${contactId}@example.com`, status: "active" })));
      await db.insert(schema.contactListMembers).values(historicalContactIds.map((contactId) => ({ contactId, contactListId: listId, workspaceId })));
      await db.insert(schema.enrollments).values(historicalContactIds.map((contactId, index) => ({ id: randomUUID(), workspaceId, contactId, sequenceId, sequenceVersionId: versionIds[index % versionIds.length]!, campaignId, emailAccountId: mailboxId, status: enrollmentStatuses[index]!, startedAt: new Date("2026-08-01T12:00:00Z"), stoppedAt: ["scheduled", "active", "paused"].includes(enrollmentStatuses[index]!) ? null : completedAt })));
    }
    const versions = await db.select().from(schema.sequenceVersions).where(eq(schema.sequenceVersions.sequenceId, sequenceId)).orderBy(schema.sequenceVersions.version);
    const steps = await db.select().from(schema.sequenceSteps).where(inArray(schema.sequenceSteps.sequenceVersionId, versionIds)).orderBy(schema.sequenceSteps.id);
    const enrollments = await db.select().from(schema.enrollments).where(eq(schema.enrollments.sequenceId, sequenceId)).orderBy(schema.enrollments.id);
    const contacts = historicalContactIds.length ? await db.select().from(schema.contacts).where(inArray(schema.contacts.id, historicalContactIds)).orderBy(schema.contacts.id) : [];
    const [campaign] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
    return {
      sequenceId, listId, campaignId, mailboxId, versionIds, fixtureContactIds, historicalContactIds, versions, steps, enrollments, contacts, campaign: campaign!,
      async cleanup() {
        if (fixtureContactIds.length) await db.delete(schema.contacts).where(inArray(schema.contacts.id, fixtureContactIds));
        await db.delete(schema.sequences).where(eq(schema.sequences.id, sequenceId));
        await db.delete(schema.contactLists).where(eq(schema.contactLists.id, listId));
        await db.delete(schema.emailAccounts).where(eq(schema.emailAccounts.id, mailboxId));
      },
    };
  }

  beforeAll(async () => {
    app = await buildApp({ env, db, composio, transactionalEmail });
    session = await createAuthenticatedSession(app);
    azureSent.length = 0;
    workspaceId = session.workspaceId;
    ownerId = session.userId;
    await db.update(schema.workspaces).set({ postalAddress: "123 Main St\nAustin, TX 78701" }).where(eq(schema.workspaces.id, workspaceId));
    await db.insert(schema.emailAccounts).values({ id: ids.mailbox, workspaceId, userId: ownerId, provider: "gmail", composioConnectedAccountId: `sequence-${suffix}`, email: `sender-${suffix}@example.com`, normalizedEmail: `sender-${suffix}@example.com`, alias: `sender-${suffix}`, status: "active" });
    await db.insert(schema.emailAccounts).values({ id: ids.mailbox2, workspaceId, userId: ownerId, provider: "outlook", composioConnectedAccountId: `sequence-selected-${suffix}`, email: `selected-sender-${suffix}@example.com`, normalizedEmail: `selected-sender-${suffix}@example.com`, alias: `selected-sender-${suffix}`, status: "active" });
    await db.insert(schema.contactLists).values({ id: ids.list, workspaceId, name: `Campaign ${suffix}` });
    await db.insert(schema.contacts).values(contactIds.map((id, index) => ({ id, workspaceId, email: `campaign-${suffix}-${index}@example.com`, normalizedEmail: `campaign-${suffix}-${index}@example.com`, firstName: `Lead${index}`, status: index === 2 ? "suppressed" : index === 3 ? "replied" : index === 4 ? "bounced" : index === 5 ? "unsubscribed" : "active" })));
    await db.insert(schema.contactListMembers).values(contactIds.map((contactId) => ({ workspaceId, contactListId: ids.list, contactId })));
  });

  afterAll(async () => {
    await app?.close();
    await db.delete(schema.contactLists).where(eq(schema.contactLists.id, ids.list));
    await db.delete(schema.sequences).where(inArray(schema.sequences.id, [ids.sequence, ids.duplicate, ids.noPostal].filter(Boolean)));
    await db.delete(schema.contacts).where(inArray(schema.contacts.id, [...contactIds, ...suppressionContactIds]));
    await db.delete(schema.emailAccounts).where(inArray(schema.emailAccounts.id, [ids.mailbox, ids.mailbox2]));
    await pool.end();
  });

  it("saves, reads, replaces and clears sender mailboxes through the sequence route", async () => {
    const created = await app.inject({ method: "POST", headers: { cookie: session.cookie }, url: "/v1/sequences", payload: { name: `Saved mailboxes ${suffix}`, steps: [{ delayDays: 1, subject: "Hello", body: "Hello" }] } });
    expect(created.statusCode).toBe(201);
    const sequenceId = created.json().sequence.id as string;
    try {
      const initial = await app.inject({ method: "GET", headers: { cookie: session.cookie }, url: `/v1/sequences/${sequenceId}` });
      expect(initial.json()).toMatchObject({ mailboxIds: [] });
      const saved = await app.inject({ method: "PUT", headers: { cookie: session.cookie }, url: `/v1/sequences/${sequenceId}/mailboxes`, payload: { mailboxIds: [ids.mailbox, ids.mailbox] } });
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toMatchObject({ sequence: { id: sequenceId, mailboxIds: [ids.mailbox] }, mailboxIds: [ids.mailbox], reassigned: 0 });
      const get = await app.inject({ method: "GET", headers: { cookie: session.cookie }, url: `/v1/sequences/${sequenceId}` });
      expect(get.json()).toMatchObject({ mailboxIds: [ids.mailbox] });
      const list = await app.inject({ method: "GET", headers: { cookie: session.cookie }, url: "/v1/sequences" });
      expect(list.json().sequences).toEqual(expect.arrayContaining([expect.objectContaining({ id: sequenceId, mailboxIds: [ids.mailbox] })]));
      const replaced = await app.inject({ method: "PUT", headers: { cookie: session.cookie }, url: `/v1/sequences/${sequenceId}/mailboxes`, payload: { mailboxIds: [ids.mailbox2] } });
      expect(replaced.statusCode).toBe(200);
      expect(replaced.json()).toMatchObject({ mailboxIds: [ids.mailbox2] });
      const invalid = await app.inject({ method: "PUT", headers: { cookie: session.cookie }, url: `/v1/sequences/${sequenceId}/mailboxes`, payload: { mailboxIds: [randomUUID()] } });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ code: "BAD_INPUT" });
      const cleared = await app.inject({ method: "PUT", headers: { cookie: session.cookie }, url: `/v1/sequences/${sequenceId}/mailboxes`, payload: { mailboxIds: [] } });
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json()).toMatchObject({ mailboxIds: [], reassigned: 0 });
      const missing = await app.inject({ method: "PUT", headers: { cookie: session.cookie }, url: `/v1/sequences/${sequenceId}/mailboxes`, payload: {} });
      expect(missing.statusCode).toBe(400);
      await db.update(schema.sequences).set({ status: "archived" }).where(eq(schema.sequences.id, sequenceId));
      const archived = await app.inject({ method: "PUT", headers: { cookie: session.cookie }, url: `/v1/sequences/${sequenceId}/mailboxes`, payload: { mailboxIds: [ids.mailbox] } });
      expect(archived.statusCode).toBe(409);
      expect(archived.json()).toMatchObject({ code: "CONFLICT" });
    } finally {
      await db.delete(schema.sequences).where(eq(schema.sequences.id, sequenceId));
    }
  });

  it("creates, publishes, previews, test-sends, enrolls from a list, and reports analytics", async () => {
    const create = await app.inject({ method: "POST", headers: { cookie: session.cookie }, url: "/v1/sequences", payload: { name: `Campaign ${suffix}`, description: "Hello {{company}}", steps: [{ delayDays: 0, subject: "Hi {{firstName}}", body: "Hello {{company}}" }, { delayDays: 2, subject: "Follow up", body: "Checking in" }] } });
    expect(create.statusCode).toBe(201);
    const sequenceId = create.json().sequence.id as string;
    ids.sequence = sequenceId;

    const publishBeforeTest = await app.inject({ method: "POST", headers: { cookie: session.cookie }, url: `/v1/sequences/${sequenceId}/publish` });
    expect(publishBeforeTest.statusCode).toBe(200);
    const preview = await app.inject({ method: "POST", headers: { cookie: session.cookie }, url: `/v1/sequences/${sequenceId}/preview`, payload: { contactId: contactIds[0] } });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().steps[0].subject).toBe("Hi Lead0");

    const testSend = await app.inject({ method: "POST", headers: { cookie: session.cookie }, url: `/v1/sequences/${sequenceId}/test-send`, payload: { stepOrder: 1, to: session.email, contactId: contactIds[0] } });
    expect(testSend.statusCode).toBe(200);
    expect(testSend.json()).toMatchObject({ sent: true, sender: `azure-${suffix}@example.com`, provider: "azure-communication-email" });
    expect(azureSent).toHaveLength(1);
    expect(azureSent[0]?.to).toBe(session.email);
    expect(azureSent[0]?.subject).toContain("[TEST]");
    expect(azureSent[0]?.body).toContain("123 Main St\nAustin, TX 78701");
    expect(azureSent[0]?.body).toContain("/v1/unsubscribe?token=");
    // Only legacy Free carries the footer, and this workspace has no legacy window.
    expect(azureSent[0]?.body).not.toContain("Sent via InboxJoy");
    const [storedSequence] = await db.select({ currentVersionId: schema.sequences.currentVersionId }).from(schema.sequences).where(eq(schema.sequences.id, sequenceId));
    const [testedVersion] = await db.select({ snapshot: schema.sequenceVersions.snapshot }).from(schema.sequenceVersions).where(eq(schema.sequenceVersions.id, storedSequence!.currentVersionId!));
    expect(testedVersion?.snapshot).toMatchObject({ lastSuccessfulTestSender: `azure-${suffix}@example.com`, lastSuccessfulTestProvider: "azure-communication-email", lastSuccessfulTestSendAt: expect.any(String) });
    expect((await app.inject({ method: "POST", headers: { cookie: session.cookie }, url: `/v1/sequences/${sequenceId}/publish` })).statusCode).toBe(200);

    const forbiddenTestSend = await app.inject({ method: "POST", headers: { cookie: session.cookie }, url: `/v1/sequences/${sequenceId}/test-send`, payload: { stepOrder: 1, to: `outsider-${suffix}@example.com` } });
    expect(forbiddenTestSend.statusCode).toBe(403);
    expect(forbiddenTestSend.json()).toEqual({ error: "Test emails can only be sent to members of this workspace." });

    const suppressedTestEmail = session.email;
    const suppressed = await app.inject({ method: "POST", headers: { cookie: session.cookie }, url: "/v1/suppressions", payload: { email: suppressedTestEmail } });
    const sentBeforeSuppressedAttempt = azureSent.length;
    const suppressedTestSend = await app.inject({ method: "POST", headers: { cookie: session.cookie }, url: `/v1/sequences/${sequenceId}/test-send`, payload: { stepOrder: 1, to: suppressedTestEmail } });
    expect(suppressedTestSend.statusCode).toBe(409);
    expect(azureSent).toHaveLength(sentBeforeSuppressedAttempt);
    await app.inject({ method: "DELETE", headers: { cookie: session.cookie }, url: `/v1/suppressions/${suppressed.json().suppression.id}` });

    await db.update(schema.usageCounters).set({ value: 20 }).where(and(eq(schema.usageCounters.workspaceId, workspaceId), eq(schema.usageCounters.counterKey, "test_sends")));
    const quotaTestSend = await app.inject({ method: "POST", headers: { cookie: session.cookie }, url: `/v1/sequences/${sequenceId}/test-send`, payload: { stepOrder: 1, to: session.email } });
    expect(quotaTestSend.statusCode).toBe(429);
    expect(quotaTestSend.json()).toMatchObject({ code: "test_send_quota_exceeded", details: { limit: 20 } });
    await db.update(schema.usageCounters).set({ value: 1 }).where(and(eq(schema.usageCounters.workspaceId, workspaceId), eq(schema.usageCounters.counterKey, "test_sends")));

    const enrollmentStartedAt = Date.now();
    const enroll = await app.inject({ method: "POST", headers: { cookie: session.cookie }, url: `/v1/sequences/${sequenceId}/enroll`, payload: { listId: ids.list, inboxId: ids.mailbox } });
    expect(enroll.statusCode).toBe(200);
    expect(enroll.json().enrolled).toBe(2);
    expect(enroll.json().skipped).toMatchObject({ suppressed: 1, replied: 1, bounced: 1, unsubscribed: 1 });
    const scheduledMessages = await db.select({ scheduledAt: schema.messages.scheduledAt }).from(schema.messages).where(and(eq(schema.messages.workspaceId, workspaceId), inArray(schema.messages.contactId, [contactIds[0]!, contactIds[1]!])));
    expect(scheduledMessages).toHaveLength(2);
    expect(new Set(scheduledMessages.map((message) => message.scheduledAt.getTime())).size).toBe(2);
    for (const message of scheduledMessages) {
      expect(message.scheduledAt.getTime()).toBeGreaterThanOrEqual(enrollmentStartedAt);
      expect(message.scheduledAt.getTime()).toBeLessThanOrEqual(enrollmentStartedAt + 90 * 60_000 + 5_000);
    }
    const bouncedEnrollment = await app.inject({ method: "POST", headers: { cookie: session.cookie }, url: `/v1/sequences/${sequenceId}/enroll`, payload: { leadIds: [contactIds[4]], inboxId: ids.mailbox } });
    expect(bouncedEnrollment.statusCode).toBe(200);
    expect(bouncedEnrollment.json()).toMatchObject({ enrolled: 0, skipped: { bounced: 1 } });
    const repeatEnroll = await app.inject({ method: "POST", headers: { cookie: session.cookie }, url: `/v1/sequences/${sequenceId}/enroll`, payload: { listId: ids.list, inboxId: ids.mailbox } });
    expect(repeatEnroll.statusCode).toBe(200);
    expect(repeatEnroll.json().skipped.already_enrolled).toBe(2);

    const analytics = await app.inject({ method: "GET", headers: { cookie: session.cookie }, url: `/v1/sequences/${sequenceId}/analytics` });
    expect(analytics.statusCode).toBe(200);
    expect(analytics.json().totals.scheduled).toBe(2);
    expect(analytics.json().steps).toHaveLength(2);
  });

  it("lists workspace contact lists and manages suppression and mailbox schedules", async () => {
    const lists = await app.inject({ method: "GET", headers: { cookie: session.cookie }, url: "/v1/lists" });
    expect(lists.statusCode).toBe(200);
    expect(lists.json().lists).toEqual(expect.arrayContaining([expect.objectContaining({ id: ids.list, name: `Campaign ${suffix}`, count: 6 })]));

    const workspace = await app.inject({ method: "GET", headers: { cookie: session.cookie }, url: "/v1/workspace" });
    expect(workspace.statusCode).toBe(200);
    expect(workspace.json().workspace).toMatchObject({ id: workspaceId, dailySendCap: 200, killSwitchEnabled: false, postalAddress: "123 Main St\nAustin, TX 78701" });
    expect(workspace.json().user.email).toContain("@example.com");
    const updatedWorkspace = await app.inject({ method: "PATCH", headers: { cookie: session.cookie }, url: "/v1/workspace", payload: { postalAddress: "456 Market St\nSan Francisco, CA 94105" } });
    expect(updatedWorkspace.statusCode).toBe(200);
    expect(updatedWorkspace.json().workspace.postalAddress).toBe("456 Market St\nSan Francisco, CA 94105");
    await app.inject({ method: "PATCH", headers: { cookie: session.cookie }, url: "/v1/workspace", payload: { postalAddress: "123 Main St\nAustin, TX 78701" } });

    const created = await app.inject({ method: "POST", headers: { cookie: session.cookie }, url: "/v1/suppressions", payload: { email: `suppressed-${suffix}@example.com`, reason: "integration_test" } });
    expect(created.statusCode).toBe(201);
    const suppressionId = created.json().suppression.id as string;
    expect((await app.inject({ method: "GET", headers: { cookie: session.cookie }, url: "/v1/suppressions" })).json().suppressions).toEqual(expect.arrayContaining([expect.objectContaining({ id: suppressionId })]));
    expect((await app.inject({ method: "DELETE", headers: { cookie: session.cookie }, url: `/v1/suppressions/${suppressionId}` })).statusCode).toBe(204);

    const schedules = [{ dayOfWeek: 1, startTime: "09:00", endTime: "17:00", timezone: "America/New_York", isActive: true }, { dayOfWeek: 2, startTime: "09:00", endTime: "17:00", timezone: "America/New_York", isActive: true }];
    const saved = await app.inject({ method: "PUT", headers: { cookie: session.cookie }, url: `/v1/inboxes/${ids.mailbox}/schedules`, payload: { schedules } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().schedules).toEqual(schedules);
    expect((await app.inject({ method: "GET", headers: { cookie: session.cookie }, url: `/v1/inboxes/${ids.mailbox}/schedules` })).json().schedules).toEqual(schedules);
    expect((await app.inject({ method: "PUT", headers: { cookie: session.cookie }, url: `/v1/inboxes/${ids.mailbox}/schedules`, payload: { schedules: [{ ...schedules[0], dayOfWeek: 7 }] } })).statusCode).toBe(400);
  });

  it("returns email_unverified and does not send a test email for an unverified owner", async () => {
    const sentBeforeAttempt = azureSent.length;
    await db.update(schema.authUsers).set({ emailVerified: false }).where(eq(schema.authUsers.id, ownerId));
    try {
      const response = await app.inject({
        method: "POST",
        headers: { cookie: session.cookie },
        url: `/v1/sequences/${ids.sequence}/test-send`,
        payload: { stepOrder: 1, to: session.email },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        error: "Verify your email address before sending. Check your inbox for the verification link.",
        code: "email_unverified",
        details: { code: "email_unverified" },
        correlationId: expect.any(String),
      });
      expect(azureSent).toHaveLength(sentBeforeAttempt);
    } finally {
      await db.update(schema.authUsers).set({ emailVerified: true }).where(eq(schema.authUsers.id, ownerId));
    }
  });

  it("publishes even when the workspace postal address is missing (address is optional)", async () => {
    const create = await app.inject({ method: "POST", headers: { cookie: session.cookie }, url: "/v1/sequences", payload: { name: `No postal ${suffix}`, steps: [{ delayDays: 0, subject: "Hello", body: "Hello" }] } });
    ids.noPostal = create.json().sequence.id as string;
    await db.update(schema.workspaces).set({ postalAddress: null }).where(eq(schema.workspaces.id, workspaceId));
    const publish = await app.inject({ method: "POST", headers: { cookie: session.cookie }, url: `/v1/sequences/${ids.noPostal}/publish` });
    expect(publish.statusCode).toBe(200);
    const sentBefore = azureSent.length;
    const testSend = await app.inject({ method: "POST", headers: { cookie: session.cookie }, url: `/v1/sequences/${ids.noPostal}/test-send`, payload: { stepOrder: 1, to: session.email } });
    expect(testSend.statusCode).toBe(200);
    expect(azureSent).toHaveLength(sentBefore + 1);
    expect(azureSent.at(-1)?.body).not.toContain("123 Main St");
    expect(azureSent.at(-1)?.body).toContain("Prefer not to receive these emails?");
    await db.update(schema.workspaces).set({ postalAddress: "123 Main St\nAustin, TX 78701" }).where(eq(schema.workspaces.id, workspaceId));
  });

  it("stores three manual suppressions and blocks all three from sending", async () => {
    await db.insert(schema.contacts).values(suppressionContactIds.map((id, index) => ({
      id,
      workspaceId,
      email: suppressionEmails[index]!,
      normalizedEmail: suppressionEmails[index]!,
      status: "active",
    })));

    const created = [];
    for (const email of suppressionEmails) {
      const response = await app.inject({ method: "POST", headers: { cookie: session.cookie }, url: "/v1/suppressions", payload: { email, reason: "production_regression" } });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ suppression: { email }, alreadySuppressed: false });
      created.push(response.json().suppression.id as string);
    }

    const duplicate = await app.inject({ method: "POST", headers: { cookie: session.cookie }, url: "/v1/suppressions", payload: { email: suppressionEmails[0], reason: "production_regression" } });
    expect(duplicate.statusCode).toBe(201);
    expect(duplicate.json()).toMatchObject({ suppression: { id: created[0], email: suppressionEmails[0] }, alreadySuppressed: true });

    const stored = await db.select().from(schema.suppressions).where(and(
      eq(schema.suppressions.workspaceId, workspaceId),
      inArray(schema.suppressions.normalizedEmail, suppressionEmails),
    ));
    expect(stored).toHaveLength(3);
    expect(new Set(stored.map((item) => item.emailHash)).size).toBe(3);

    const enroll = await app.inject({ method: "POST", headers: { cookie: session.cookie }, url: `/v1/sequences/${ids.sequence}/enroll`, payload: { leadIds: suppressionContactIds, inboxId: ids.mailbox } });
    expect(enroll.statusCode).toBe(200);
    expect(enroll.json()).toMatchObject({ enrolled: 0, skipped: { suppressed: 3 } });
    const messages = await db.select({ id: schema.messages.id }).from(schema.messages).where(inArray(schema.messages.contactId, suppressionContactIds));
    expect(messages).toHaveLength(0);
  });

  it("returns 400 for operation validation errors and accepts bodies above Fastify's default limit", async () => {
    const invalidDraft = await app.inject({ method: "POST", headers: { cookie: session.cookie }, url: "/v1/sequences/draft", payload: {} });
    expect(invalidDraft.statusCode).toBe(400);
    expect(invalidDraft.json()).toMatchObject({ code: "BAD_INPUT" });

    const oversizedInvalidCsv = await app.inject({ method: "POST", headers: { cookie: session.cookie, "content-type": "application/json" }, url: "/v1/imports/preview", payload: JSON.stringify({ csv: " ".repeat(1_100_000) }) });
    expect(oversizedInvalidCsv.statusCode).toBe(400);
    expect(oversizedInvalidCsv.statusCode).not.toBe(413);
  });

  it("pauses, versions paused edits, resumes pending work on the edited copy, duplicates, and archives", async () => {
    const pause = await app.inject({ method: "POST", headers: { cookie: session.cookie }, url: `/v1/sequences/${ids.sequence}/pause` });
    expect(pause.statusCode).toBe(200);
    const [before] = await db.select().from(schema.messages).where(eq(schema.messages.contactId, contactIds[0]));
    expect(before?.status).toBe("scheduled");
    const [pausedEnrollment] = await db.select().from(schema.enrollments).where(and(eq(schema.enrollments.sequenceId, ids.sequence), eq(schema.enrollments.contactId, contactIds[0])));
    expect(pausedEnrollment?.status).toBe("paused");

    const edit = await app.inject({ method: "PATCH", headers: { cookie: session.cookie }, url: `/v1/sequences/${ids.sequence}`, payload: { name: `Campaign ${suffix} revised`, description: "Revised", steps: [{ delayDays: 1, subject: "New {{firstName}}", body: "New body" }] } });
    expect(edit.statusCode).toBe(200);
    const versions = await db.select().from(schema.sequenceVersions).where(eq(schema.sequenceVersions.sequenceId, ids.sequence));
    expect(versions).toHaveLength(2);
    const currentAnalytics = await app.inject({ method: "GET", headers: { cookie: session.cookie }, url: `/v1/sequences/${ids.sequence}/analytics` });
    expect(currentAnalytics.statusCode).toBe(200);
    expect(currentAnalytics.json()).toMatchObject({ currentVersion: 2, selectedVersion: 2, totals: { scheduled: 2, sent: 0, replied: 0 }, steps: [{ version: 2, subject: "New {{firstName}}" }] });
    expect(currentAnalytics.json().versions).toEqual(expect.arrayContaining([expect.objectContaining({ version: 1, current: false }), expect.objectContaining({ version: 2, current: true })]));
    const historicalAnalytics = await app.inject({ method: "GET", headers: { cookie: session.cookie }, url: `/v1/sequences/${ids.sequence}/analytics?version=1` });
    expect(historicalAnalytics.statusCode).toBe(200);
    expect(historicalAnalytics.json()).toMatchObject({ selectedVersion: 1, totals: { scheduled: 2 }, steps: [expect.objectContaining({ version: 1, subject: "Hi {{firstName}}", scheduled: 2 }), expect.objectContaining({ version: 1, subject: "Follow up" })] });
    const allAnalytics = await app.inject({ method: "GET", headers: { cookie: session.cookie }, url: `/v1/sequences/${ids.sequence}/analytics?version=all` });
    expect(allAnalytics.statusCode).toBe(200);
    expect(allAnalytics.json()).toMatchObject({ selectedVersion: "all", totals: { scheduled: 2 }, steps: expect.arrayContaining([expect.objectContaining({ version: 1, subject: "Hi {{firstName}}", scheduled: 2 }), expect.objectContaining({ version: 1, subject: "Follow up" }), expect.objectContaining({ version: 2, subject: "New {{firstName}}" })]) });
    expect(allAnalytics.json().steps).toHaveLength(3);
    const missingVersionAnalytics = await app.inject({ method: "GET", headers: { cookie: session.cookie }, url: `/v1/sequences/${ids.sequence}/analytics?version=999` });
    expect(missingVersionAnalytics.statusCode).toBe(404);
    const invalidVersionAnalytics = await app.inject({ method: "GET", headers: { cookie: session.cookie }, url: `/v1/sequences/${ids.sequence}/analytics?version=invalid` });
    expect(invalidVersionAnalytics.statusCode).toBe(400);
    expect(invalidVersionAnalytics.json()).toMatchObject({ code: "BAD_INPUT" });
    const pausedTestSend = await app.inject({ method: "POST", headers: { cookie: session.cookie }, url: `/v1/sequences/${ids.sequence}/test-send`, payload: { stepOrder: 1, to: session.email, inboxId: ids.mailbox } });
    expect(pausedTestSend.statusCode).toBe(200);
    expect(pausedTestSend.json()).toMatchObject({ sender: `azure-${suffix}@example.com` });

    await new Promise((resolve) => setTimeout(resolve, 5));
    const resume = await app.inject({ method: "POST", headers: { cookie: session.cookie }, url: `/v1/sequences/${ids.sequence}/resume` });
    expect(resume.statusCode).toBe(200);
    const [after] = await db.select().from(schema.messages).where(eq(schema.messages.id, before!.id));
    // A first email keeps its time; the pause does not push it later.
    expect(after!.scheduledAt.getTime()).toBe(before!.scheduledAt.getTime());
    // The unsent email now carries the copy saved while paused.
    const currentVersion = versions.find((version) => version.version === 2)!;
    const [editedStep] = await db.select().from(schema.sequenceSteps).where(eq(schema.sequenceSteps.sequenceVersionId, currentVersion.id));
    expect(after).toMatchObject({ status: "scheduled", sequenceStepId: editedStep!.id, subject: "New Lead0", idempotencyKey: before!.idempotencyKey });
    expect(String((after!.metadata as Record<string, unknown>).bodyText)).toMatch(/^New body\n\n---\n123 Main St/);
    expect((after!.metadata as Record<string, unknown>).unsubscribeUrl).toBe((before!.metadata as Record<string, unknown>).unsubscribeUrl);
    const [resumedEnrollment] = await db.select().from(schema.enrollments).where(eq(schema.enrollments.id, pausedEnrollment!.id));
    expect(resumedEnrollment?.sequenceVersionId).toBe(currentVersion.id);

    const duplicate = await app.inject({ method: "POST", headers: { cookie: session.cookie }, url: `/v1/sequences/${ids.sequence}/duplicate` });
    expect(duplicate.statusCode).toBe(201);
    ids.duplicate = duplicate.json().sequence.id as string;
    expect(duplicate.json().sequence.name).toBe(`Campaign ${suffix} revised (copy)`);

    expect((await app.inject({ method: "POST", headers: { cookie: session.cookie }, url: `/v1/sequences/${ids.sequence}/pause` })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", headers: { cookie: session.cookie }, url: `/v1/sequences/${ids.sequence}/archive` })).statusCode).toBe(200);
  });

  // Production regression (UAE Architects batches, 2026-10-24): the final email was paused,
  // reworded and resumed, then neither went out on time nor carried the new wording. The
  // scheduler had kept bumping the overdue email while paused, resume added the whole pause on
  // top, and the email had been rendered from the old copy when email 2 went out.
  async function createMidSequenceFixture(input: { sequenceStatus: "active" | "paused"; campaignStatus: "active" | "paused" }) {
    const sequenceId = randomUUID();
    const campaignId = randomUUID();
    const versionId = randomUUID();
    const stepIds: string[] = [randomUUID(), randomUUID(), randomUUID()];
    const contacts = [randomUUID(), randomUUID()];
    const enrollmentIds = [randomUUID(), randomUUID()];
    const now = Date.now();
    const pausedAt = new Date(now - 2 * 86_400_000);
    const secondSentAt = new Date(now - 6 * 86_400_000);
    await db.insert(schema.contacts).values(contacts.map((id, index) => ({ id, workspaceId, email: `mid-${id}@example.com`, normalizedEmail: `mid-${id}@example.com`, firstName: `Mid${index}`, company: `Firm${index}`, status: "enrolled" as const, customFields: index === 0 ? { opener: "Loved the Marina tower" } : {} })));
    await db.insert(schema.sequences).values({ id: sequenceId, workspaceId, name: `Mid sequence ${sequenceId}`, status: input.sequenceStatus, pausedAt: input.sequenceStatus === "paused" ? pausedAt : null });
    await db.insert(schema.sequenceVersions).values({ id: versionId, workspaceId, sequenceId, version: 1, status: "active", snapshot: {} });
    await db.update(schema.sequences).set({ currentVersionId: versionId }).where(eq(schema.sequences.id, sequenceId));
    await db.insert(schema.sequenceSteps).values([
      { id: stepIds[0]!, workspaceId, sequenceVersionId: versionId, stepOrder: 1, delayDays: 0, subject: "{{company}} website", bodyText: "Hello {{firstName}}" },
      { id: stepIds[1]!, workspaceId, sequenceVersionId: versionId, stepOrder: 2, delayDays: 3, subject: "Re: {{company}} website", bodyText: "Following up" },
      { id: stepIds[2]!, workspaceId, sequenceVersionId: versionId, stepOrder: 3, delayDays: 5, subject: "Re: {{company}} website", bodyText: "Old last email" },
    ]);
    await db.insert(schema.campaigns).values({ id: campaignId, workspaceId, sequenceId, emailAccountId: ids.mailbox, name: `Mid campaign ${sequenceId}`, status: input.campaignStatus, launchedAt: new Date(now - 10 * 86_400_000), createdByUserId: ownerId });
    await db.insert(schema.enrollments).values(contacts.map((contactId, index) => ({ id: enrollmentIds[index]!, workspaceId, contactId, sequenceId, sequenceVersionId: versionId, campaignId, emailAccountId: ids.mailbox, status: "paused" as const, statusBeforePause: "active" as const, pausedAt, nextStepOrder: 3, nextDueAt: new Date(now + 5 * 60_000), startedAt: new Date(now - 10 * 86_400_000) })));
    const unsubscribeUrl = (contactId: string) => `https://api.example.test/v1/unsubscribe?token=${contactId}`;
    for (const [index, contactId] of contacts.entries()) {
      const enrollmentId = enrollmentIds[index]!;
      const base = { workspaceId, enrollmentId, emailAccountId: ids.mailbox, contactId, recipientEmail: `mid-${contactId}@example.com`, normalizedRecipientEmail: `mid-${contactId}@example.com`, bodyHash: "old" };
      await db.insert(schema.messages).values([
        { ...base, id: randomUUID(), sequenceStepId: stepIds[0]!, status: "accepted" as const, idempotencyKey: `${enrollmentId}:1`, scheduledAt: new Date(now - 9 * 86_400_000), acceptedAt: new Date(now - 9 * 86_400_000), subject: `Firm${index} website`, metadata: { bodyText: "Hello", unsubscribeUrl: unsubscribeUrl(contactId) } },
        { ...base, id: randomUUID(), sequenceStepId: stepIds[1]!, status: "accepted" as const, idempotencyKey: `${enrollmentId}:2`, scheduledAt: secondSentAt, acceptedAt: secondSentAt, subject: `Re: Firm${index} website`, metadata: { bodyText: "Following up", unsubscribeUrl: unsubscribeUrl(contactId) } },
        // Due a day ago, then bumped a few minutes ahead on every scheduler tick while paused.
        { ...base, id: randomUUID(), sequenceStepId: stepIds[2]!, status: "scheduled" as const, idempotencyKey: `${enrollmentId}:3`, scheduledAt: new Date(now + 5 * 60_000), blockedReason: "enrollment_inactive", subject: `Re: Firm${index} website`, metadata: { bodyText: `Old last email\n\n---\nPrefer not to receive these emails? Unsubscribe: ${unsubscribeUrl(contactId)}`, sequenceStepOrder: 3, unsubscribeUrl: unsubscribeUrl(contactId) } },
      ]);
    }
    const lastEmail = async (enrollmentId: string) => (await db.select().from(schema.messages).where(and(eq(schema.messages.enrollmentId, enrollmentId), eq(schema.messages.idempotencyKey, `${enrollmentId}:3`))))[0]!;
    const expectedDue = (enrollmentId: string, delayDays: number) => secondSentAt.getTime() + delayDays * 86_400_000 + followUpSendJitterMs(`${enrollmentId}:3`);
    return {
      sequenceId, campaignId, versionId, stepIds, contacts, enrollmentIds, lastEmail, expectedDue,
      async cleanup() {
        await db.delete(schema.contacts).where(inArray(schema.contacts.id, contacts));
        await db.delete(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
        await db.delete(schema.sequences).where(eq(schema.sequences.id, sequenceId));
      },
    };
  }

  it("resumes an overdue final email right away on the copy edited while paused", async () => {
    const fixture = await createMidSequenceFixture({ sequenceStatus: "paused", campaignStatus: "active" });
    try {
      const before = await Promise.all(fixture.enrollmentIds.map(fixture.lastEmail));
      const edit = await app.inject({ method: "PATCH", headers: { cookie: session.cookie }, url: `/v1/sequences/${fixture.sequenceId}`, payload: { name: `Mid sequence ${fixture.sequenceId}`, steps: [
        { delayDays: 0, subject: "{{company}} website", body: "Hello {{firstName}}" },
        { delayDays: 3, subject: "Re: {{company}} website", body: "Following up" },
        { delayDays: 4, subject: "Re: {{company}} website", body: "{{opener}} - new last email for {{firstName}}" },
      ] } });
      expect(edit.statusCode).toBe(200);
      const [currentVersion] = await db.select().from(schema.sequenceVersions).where(and(eq(schema.sequenceVersions.sequenceId, fixture.sequenceId), eq(schema.sequenceVersions.version, 2)));
      const [newLastStep] = await db.select().from(schema.sequenceSteps).where(and(eq(schema.sequenceSteps.sequenceVersionId, currentVersion!.id), eq(schema.sequenceSteps.stepOrder, 3)));

      const resume = await app.inject({ method: "POST", headers: { cookie: session.cookie }, url: `/v1/sequences/${fixture.sequenceId}/resume` });
      expect(resume.statusCode).toBe(200);

      // Lead 0 has every value: new copy, new wait, due from when email 2 went out (so now).
      const edited = await fixture.lastEmail(fixture.enrollmentIds[0]!);
      expect(edited).toMatchObject({ status: "scheduled", sequenceStepId: newLastStep!.id, subject: "Re: Firm0 website", idempotencyKey: before[0]!.idempotencyKey });
      expect((edited.metadata as Record<string, unknown>).bodyText).toBe(`Loved the Marina tower - new last email for Mid0\n\n---\n123 Main St\nAustin, TX 78701\nPrefer not to receive these emails? Unsubscribe: https://api.example.test/v1/unsubscribe?token=${fixture.contacts[0]}`);
      expect(edited.scheduledAt.getTime()).toBe(fixture.expectedDue(fixture.enrollmentIds[0]!, 4));
      expect(edited.scheduledAt.getTime()).toBeLessThan(Date.now());
      const [movedEnrollment] = await db.select().from(schema.enrollments).where(eq(schema.enrollments.id, fixture.enrollmentIds[0]!));
      expect(movedEnrollment).toMatchObject({ status: "active", sequenceVersionId: currentVersion!.id, nextStepOrder: 3, pausedAt: null });
      expect(movedEnrollment!.nextDueAt?.getTime()).toBe(edited.scheduledAt.getTime());

      // Lead 1 has no {{opener}}: it keeps the old copy and version instead of a blank line, but
      // is still not held back by the pause.
      const kept = await fixture.lastEmail(fixture.enrollmentIds[1]!);
      expect(kept).toMatchObject({ status: "scheduled", sequenceStepId: fixture.stepIds[2], subject: before[1]!.subject, bodyHash: before[1]!.bodyHash });
      expect(kept.scheduledAt.getTime()).toBe(fixture.expectedDue(fixture.enrollmentIds[1]!, 5));
      const [keptEnrollment] = await db.select().from(schema.enrollments).where(eq(schema.enrollments.id, fixture.enrollmentIds[1]!));
      expect(keptEnrollment).toMatchObject({ status: "active", sequenceVersionId: fixture.versionId });

      // Mail already sent keeps its original step and version.
      const sent = await db.select().from(schema.messages).where(and(inArray(schema.messages.enrollmentId, fixture.enrollmentIds), eq(schema.messages.status, "accepted")));
      expect(sent).toHaveLength(4);
      expect(sent.every((message) => fixture.stepIds.slice(0, 2).includes(message.sequenceStepId))).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it("resumes a paused campaign without pushing its overdue follow-ups later", async () => {
    const fixture = await createMidSequenceFixture({ sequenceStatus: "active", campaignStatus: "paused" });
    try {
      await db.update(schema.enrollments).set({ pausedAt: new Date(Date.now() - 86_400_000) }).where(inArray(schema.enrollments.id, fixture.enrollmentIds));
      const resume = await app.inject({ method: "POST", headers: { cookie: session.cookie }, url: `/v1/campaigns/${fixture.campaignId}/resume` });
      expect(resume.statusCode).toBe(200);
      for (const enrollmentId of fixture.enrollmentIds) {
        const lastEmail = await fixture.lastEmail(enrollmentId);
        expect(lastEmail).toMatchObject({ status: "scheduled", sequenceStepId: fixture.stepIds[2] });
        expect(lastEmail.scheduledAt.getTime()).toBe(fixture.expectedDue(enrollmentId, 5));
        expect(lastEmail.scheduledAt.getTime()).toBeLessThan(Date.now());
      }
      const resumed = await db.select().from(schema.enrollments).where(inArray(schema.enrollments.id, fixture.enrollmentIds));
      expect(resumed.every((enrollment) => enrollment.status === "active" && enrollment.sequenceVersionId === fixture.versionId)).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it("edits a completed campaign and published sequence without changing history, then enrolls a new linked-list lead on the new version", async () => {
    const fixture = await createSequenceEditFixture();
    try {
      const campaignName = fixture.campaign.name;

      const originalStep = fixture.steps.find((step) => step.sequenceVersionId === fixture.versionIds[1] && step.stepOrder === 1)!;
      const sequenceEdit = await app.inject({ method: "PATCH", headers: { cookie: session.cookie }, url: `/v1/sequences/${fixture.sequenceId}`, payload: { name: `Revised sequence ${fixture.sequenceId}`, description: "New published content", steps: [{ id: originalStep.id, delayDays: 0, subject: "New {{firstName}}", body: "New body {{firstName}}" }] } });
      expect(sequenceEdit.statusCode).toBe(200);
      expect(sequenceEdit.json()).toMatchObject({ sequence: { id: fixture.sequenceId, status: "published", steps: [expect.objectContaining({ subject: "New {{firstName}}" })] } });
      const [sequence] = await db.select().from(schema.sequences).where(eq(schema.sequences.id, fixture.sequenceId));
      expect(sequence).toMatchObject({ status: "active", name: `Revised sequence ${fixture.sequenceId}` });
      expect(fixture.versionIds).not.toContain(sequence!.currentVersionId);
      const versions = await db.select().from(schema.sequenceVersions).where(eq(schema.sequenceVersions.sequenceId, fixture.sequenceId)).orderBy(schema.sequenceVersions.version);
      expect(versions).toHaveLength(3);
      expect(versions.slice(0, 2)).toEqual(fixture.versions);
      expect(versions[2]).toMatchObject({ id: sequence!.currentVersionId, version: 3, status: "active", snapshot: { description: "New published content" } });
      expect(await db.select().from(schema.sequenceSteps).where(inArray(schema.sequenceSteps.sequenceVersionId, fixture.versionIds)).orderBy(schema.sequenceSteps.id)).toEqual(fixture.steps);
      expect(await db.select().from(schema.enrollments).where(eq(schema.enrollments.sequenceId, fixture.sequenceId)).orderBy(schema.enrollments.id)).toEqual(fixture.enrollments);
      const [campaignBeforeAdd] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, fixture.campaignId));
      expect(campaignBeforeAdd).toMatchObject({ name: campaignName, status: "completed", launchedAt: fixture.campaign.launchedAt, completedAt: fixture.campaign.completedAt });

      const created = await app.inject({ method: "POST", headers: { cookie: session.cookie }, url: "/v1/leads", payload: { email: `new-${fixture.sequenceId}@example.com`, firstName: "New lead", listId: fixture.listId } });
      expect(created.statusCode).toBe(201);
      const leadId = created.json().lead.id as string;
      fixture.fixtureContactIds.push(leadId);
      expect(created.json().campaignUpdates).toEqual([{ campaignId: fixture.campaignId, name: campaignName, enrolled: 1, restarted: true, blockedReason: null }]);
      expect(await db.select().from(schema.contactListMembers).where(and(eq(schema.contactListMembers.contactListId, fixture.listId), eq(schema.contactListMembers.contactId, leadId)))).toHaveLength(1);
      const enrollments = await db.select().from(schema.enrollments).where(eq(schema.enrollments.sequenceId, fixture.sequenceId)).orderBy(schema.enrollments.id);
      expect(enrollments).toHaveLength(fixture.enrollments.length + 1);
      expect(enrollments.filter((enrollment) => enrollment.contactId !== leadId)).toEqual(fixture.enrollments);
      const enrollment = enrollments.find((row) => row.contactId === leadId)!;
      expect(enrollment).toMatchObject({ campaignId: fixture.campaignId, sequenceVersionId: sequence!.currentVersionId, emailAccountId: fixture.mailboxId, status: "scheduled" });
      const [newStep] = await db.select().from(schema.sequenceSteps).where(eq(schema.sequenceSteps.sequenceVersionId, sequence!.currentVersionId!));
      expect(newStep!.id).not.toBe(originalStep.id);
      const messages = await db.select().from(schema.messages).where(eq(schema.messages.enrollmentId, enrollment.id));
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ sequenceStepId: newStep!.id, subject: "New New lead", status: "scheduled" });
      expect(await db.select().from(schema.contacts).where(inArray(schema.contacts.id, fixture.historicalContactIds)).orderBy(schema.contacts.id)).toEqual(fixture.contacts);
      expect(await db.select().from(schema.sequenceSteps).where(inArray(schema.sequenceSteps.sequenceVersionId, fixture.versionIds)).orderBy(schema.sequenceSteps.id)).toEqual(fixture.steps);
      expect(await db.select().from(schema.sequenceVersions).where(inArray(schema.sequenceVersions.id, fixture.versionIds)).orderBy(schema.sequenceVersions.version)).toEqual(fixture.versions);
      const [campaignAfterAdd] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, fixture.campaignId));
      expect(campaignAfterAdd).toMatchObject({ status: "active", completedAt: fixture.campaign.completedAt });
    } finally {
      await fixture.cleanup();
    }
  });

  it("creates a new active version when a published sequence has no enrollments", async () => {
    const fixture = await createSequenceEditFixture({ campaignStatus: "active", enrollmentStatuses: [] });
    try {
      const response = await app.inject({ method: "PATCH", headers: { cookie: session.cookie }, url: `/v1/sequences/${fixture.sequenceId}`, payload: { name: "Published without enrollments", steps: [{ delayDays: 0, subject: "New content", body: "New body" }] } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ sequence: { status: "published" } });
      const [sequence] = await db.select().from(schema.sequences).where(eq(schema.sequences.id, fixture.sequenceId));
      expect(sequence!.status).toBe("active");
      expect(fixture.versionIds).not.toContain(sequence!.currentVersionId);
      const versions = await db.select().from(schema.sequenceVersions).where(eq(schema.sequenceVersions.sequenceId, fixture.sequenceId)).orderBy(schema.sequenceVersions.version);
      expect(versions).toHaveLength(3);
      expect(versions.slice(0, 2)).toEqual(fixture.versions);
      expect(versions[2]).toMatchObject({ id: sequence!.currentVersionId, version: 3, status: "active" });
      expect(await db.select().from(schema.sequenceSteps).where(inArray(schema.sequenceSteps.sequenceVersionId, fixture.versionIds)).orderBy(schema.sequenceSteps.id)).toEqual(fixture.steps);
      expect(await db.select().from(schema.enrollments).where(eq(schema.enrollments.sequenceId, fixture.sequenceId))).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each(["scheduled", "active", "paused"] as const)("rejects editing a published sequence when another campaign has a %s enrollment on an older version", async (status) => {
    const fixture = await createSequenceEditFixture();
    try {
      const otherCampaignId = randomUUID();
      const contactId = randomUUID();
      fixture.fixtureContactIds.push(contactId);
      await db.insert(schema.contacts).values({ id: contactId, workspaceId, email: `${contactId}@example.com`, normalizedEmail: `${contactId}@example.com`, status: "enrolled" });
      await db.insert(schema.campaigns).values({ id: otherCampaignId, workspaceId, sequenceId: fixture.sequenceId, emailAccountId: fixture.mailboxId, name: "Other in-progress campaign", status: status === "paused" ? "paused" : "active", launchedAt: new Date() });
      await db.insert(schema.enrollments).values({ id: randomUUID(), workspaceId, contactId, sequenceId: fixture.sequenceId, sequenceVersionId: fixture.versionIds[0]!, campaignId: otherCampaignId, emailAccountId: fixture.mailboxId, status });
      const [before] = await db.select().from(schema.sequences).where(eq(schema.sequences.id, fixture.sequenceId));
      const enrollmentsBefore = await db.select().from(schema.enrollments).where(eq(schema.enrollments.sequenceId, fixture.sequenceId)).orderBy(schema.enrollments.id);
      const response = await app.inject({ method: "PATCH", headers: { cookie: session.cookie }, url: `/v1/sequences/${fixture.sequenceId}`, payload: { name: "Must not change", steps: [{ delayDays: 0, subject: "Must not replace", body: "Must not replace" }] } });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: expect.any(String) });
      const [after] = await db.select().from(schema.sequences).where(eq(schema.sequences.id, fixture.sequenceId));
      expect(after).toEqual(before);
      expect(await db.select().from(schema.sequenceVersions).where(eq(schema.sequenceVersions.sequenceId, fixture.sequenceId)).orderBy(schema.sequenceVersions.version)).toEqual(fixture.versions);
      expect(await db.select().from(schema.sequenceSteps).where(inArray(schema.sequenceSteps.sequenceVersionId, fixture.versionIds)).orderBy(schema.sequenceSteps.id)).toEqual(fixture.steps);
      expect(await db.select().from(schema.enrollments).where(eq(schema.enrollments.sequenceId, fixture.sequenceId)).orderBy(schema.enrollments.id)).toEqual(enrollmentsBefore);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each(["sequence", "campaign"] as const)("rejects editing an archived %s without changing history", async (target) => {
    const fixture = await createSequenceEditFixture(target === "sequence" ? { sequenceStatus: "archived" } : { campaignStatus: "archived" });
    try {
      const [sequenceBefore] = await db.select().from(schema.sequences).where(eq(schema.sequences.id, fixture.sequenceId));
      const response = await app.inject({ method: "PATCH", headers: { cookie: session.cookie }, url: target === "sequence" ? `/v1/sequences/${fixture.sequenceId}` : `/v1/campaigns/${fixture.campaignId}`, payload: target === "sequence" ? { name: "Must not change", steps: [{ delayDays: 0, subject: "Must not change", body: "Must not change" }] } : { name: "Must not change" } });
      expect(response.statusCode).toBe(409);
      const [sequenceAfter] = await db.select().from(schema.sequences).where(eq(schema.sequences.id, fixture.sequenceId));
      const [campaignAfter] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, fixture.campaignId));
      expect(sequenceAfter).toEqual(sequenceBefore);
      expect(campaignAfter).toEqual(fixture.campaign);
      expect(await db.select().from(schema.sequenceVersions).where(eq(schema.sequenceVersions.sequenceId, fixture.sequenceId)).orderBy(schema.sequenceVersions.version)).toEqual(fixture.versions);
      expect(await db.select().from(schema.sequenceSteps).where(inArray(schema.sequenceSteps.sequenceVersionId, fixture.versionIds)).orderBy(schema.sequenceSteps.id)).toEqual(fixture.steps);
      expect(await db.select().from(schema.enrollments).where(eq(schema.enrollments.sequenceId, fixture.sequenceId)).orderBy(schema.enrollments.id)).toEqual(fixture.enrollments);
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps paused edits on the draft-version path even with a paused enrollment", async () => {
    const fixture = await createSequenceEditFixture({ sequenceStatus: "paused", campaignStatus: "paused", enrollmentStatuses: ["paused"] });
    try {
      const response = await app.inject({ method: "PATCH", headers: { cookie: session.cookie }, url: `/v1/sequences/${fixture.sequenceId}`, payload: { name: "Paused revision", steps: [{ delayDays: 1, subject: "Draft revision", body: "Draft body" }] } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ sequence: { status: "paused" } });
      const [sequence] = await db.select().from(schema.sequences).where(eq(schema.sequences.id, fixture.sequenceId));
      expect(sequence).toMatchObject({ status: "paused" });
      expect(fixture.versionIds).not.toContain(sequence!.currentVersionId);
      const versions = await db.select().from(schema.sequenceVersions).where(eq(schema.sequenceVersions.sequenceId, fixture.sequenceId)).orderBy(schema.sequenceVersions.version);
      expect(versions).toHaveLength(3);
      expect(versions.slice(0, 2)).toEqual(fixture.versions);
      expect(versions[2]).toMatchObject({ id: sequence!.currentVersionId, version: 3, status: "draft" });
      expect(await db.select().from(schema.sequenceSteps).where(inArray(schema.sequenceSteps.sequenceVersionId, fixture.versionIds)).orderBy(schema.sequenceSteps.id)).toEqual(fixture.steps);
      expect(await db.select().from(schema.enrollments).where(eq(schema.enrollments.sequenceId, fixture.sequenceId)).orderBy(schema.enrollments.id)).toEqual(fixture.enrollments);
    } finally {
      await fixture.cleanup();
    }
  });

  it("requires a manager to edit published copy even with no in-progress enrollments", async () => {
    const fixture = await createSequenceEditFixture({ enrollmentStatuses: [] });
    try {
      await db.update(schema.memberships).set({ role: "member" }).where(and(eq(schema.memberships.workspaceId, workspaceId), eq(schema.memberships.userId, ownerId)));
      const response = await app.inject({ method: "PATCH", headers: { cookie: session.cookie }, url: `/v1/sequences/${fixture.sequenceId}`, payload: { name: "Member live edit", steps: [{ delayDays: 0, subject: "Changed", body: "Changed" }] } });
      expect(response.statusCode).toBe(403);
      expect(response.json().error).toContain("Only workspace owners and admins");
      expect(await db.select().from(schema.sequenceVersions).where(eq(schema.sequenceVersions.sequenceId, fixture.sequenceId)).orderBy(schema.sequenceVersions.version)).toEqual(fixture.versions);
    } finally {
      await db.update(schema.memberships).set({ role: "owner" }).where(and(eq(schema.memberships.workspaceId, workspaceId), eq(schema.memberships.userId, ownerId)));
      await fixture.cleanup();
    }
  });

  it("pauses every enrollment, edits a draft version, and resumes a legacy campaign", async () => {
    const fixture = await createSequenceEditFixture({ campaignStatus: "active", enrollmentStatuses: ["active", "active"] });
    try {
      await db.update(schema.enrollments).set({ campaignId: null }).where(eq(schema.enrollments.id, fixture.enrollments[1]!.id));
      const pause = await app.inject({ method: "POST", headers: { cookie: session.cookie }, url: `/v1/sequences/${fixture.sequenceId}/pause` });
      expect(pause.statusCode).toBe(200);
      const paused = await db.select().from(schema.enrollments).where(eq(schema.enrollments.sequenceId, fixture.sequenceId));
      expect(paused.every((enrollment) => enrollment.status === "paused")).toBe(true);
      const campaign = await app.inject({ method: "GET", headers: { cookie: session.cookie }, url: `/v1/campaigns/${fixture.campaignId}` });
      expect(campaign.json().campaign).toMatchObject({ status: "active", displayStatus: "paused", statusReason: null });
      const edit = await app.inject({ method: "PATCH", headers: { cookie: session.cookie }, url: `/v1/sequences/${fixture.sequenceId}`, payload: { name: "Paused then edited", steps: [{ delayDays: 0, subject: "Edited", body: "Edited" }] } });
      expect(edit.statusCode).toBe(200);
      const [sequence] = await db.select().from(schema.sequences).where(eq(schema.sequences.id, fixture.sequenceId));
      const [draft] = await db.select().from(schema.sequenceVersions).where(eq(schema.sequenceVersions.id, sequence!.currentVersionId!));
      expect(draft?.status).toBe("draft");
      const resume = await app.inject({ method: "POST", headers: { cookie: session.cookie }, url: `/v1/sequences/${fixture.sequenceId}/resume` });
      expect(resume.statusCode).toBe(200);
      expect(resume.json().sequence.status).toBe("published");
      const resumed = await db.select().from(schema.enrollments).where(eq(schema.enrollments.sequenceId, fixture.sequenceId));
      expect(resumed.every((enrollment) => enrollment.status === "active")).toBe(true);
      expect(resumed.map((enrollment) => enrollment.sequenceVersionId).sort()).toEqual(fixture.enrollments.map((enrollment) => enrollment.sequenceVersionId).sort());
      expect((await db.select().from(schema.sequenceVersions).where(eq(schema.sequenceVersions.id, draft!.id)))[0]?.status).toBe("active");
    } finally {
      await fixture.cleanup();
    }
  });

  it("sends tests through Azure when no mailbox is active", async () => {
    await db.update(schema.emailAccounts).set({ status: "paused" }).where(inArray(schema.emailAccounts.id, [ids.mailbox, ids.mailbox2]));
    const response = await app.inject({ method: "POST", headers: { cookie: session.cookie }, url: `/v1/sequences/${ids.duplicate}/test-send`, payload: { stepOrder: 1, to: session.email } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ sent: true, sender: `azure-${suffix}@example.com` });
    await db.update(schema.emailAccounts).set({ status: "active" }).where(inArray(schema.emailAccounts.id, [ids.mailbox, ids.mailbox2]));
  });

  it("returns the delivery-control reason when the workspace kill switch is enabled", async () => {
    await db.update(schema.workspaces).set({ killSwitchEnabled: true }).where(eq(schema.workspaces.id, workspaceId));
    const response = await app.inject({ method: "POST", headers: { cookie: session.cookie }, url: `/v1/sequences/${ids.duplicate}/test-send`, payload: { stepOrder: 1, to: session.email } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "kill_switch", error: expect.stringContaining("kill switch") });
    await db.update(schema.workspaces).set({ killSwitchEnabled: false }).where(eq(schema.workspaces.id, workspaceId));
  });

  it("blocks test sends while the founder stop has paused the workspace", async () => {
    // What the founder stop writes.
    await db.update(schema.workspaces).set({ status: "paused" }).where(eq(schema.workspaces.id, workspaceId));
    const response = await app.inject({ method: "POST", headers: { cookie: session.cookie }, url: `/v1/sequences/${ids.duplicate}/test-send`, payload: { stepOrder: 1, to: session.email } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "workspace_inactive" });
    await db.update(schema.workspaces).set({ status: "active" }).where(eq(schema.workspaces.id, workspaceId));
  });
});
