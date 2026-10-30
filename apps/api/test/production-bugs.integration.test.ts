import { signWebhook, type ComposioClient } from "@inboxjoy/composio";
import { loadAppEnv } from "@inboxjoy/config";
import type { BillingClient } from "@inboxjoy/core";
import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { and, eq, inArray } from "drizzle-orm";
import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { createAuthenticatedSession } from "./auth-helper.js";

const databaseUrl = process.env.DATABASE_URL;
const authSecret = "production-bugs-auth-secret-at-least-32-characters";
const webhookSecret = "production-bugs-webhook-secret-at-least-32-chars";

describe.skipIf(!databaseUrl)("inbound webhook characterization", () => {
  const suffix = randomUUID().slice(0, 8);
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);
  const mailboxId = randomUUID();
  const sequenceId = randomUUID();
  const versionId = randomUUID();
  const accountId = `inbound-connected-${suffix}`;
  const mailboxEmail = `inbound-sender-${suffix}@example.com`;
  let workspaceId = "";
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    const env = loadAppEnv({
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl ?? "postgresql://localhost/inboxjoy_test",
      API_BASE_URL: "https://api.example.test",
      WEB_BASE_URL: "https://app.example.test",
      CORS_ORIGINS: "https://app.example.test",
      AUTH_SECRET: authSecret,
      COMPOSIO_WEBHOOK_SECRET: webhookSecret,
    });
    app = await buildApp({ env, db });
    const session = await createAuthenticatedSession(app);
    workspaceId = session.workspaceId;
    await db.insert(schema.emailAccounts).values({ id: mailboxId, workspaceId, userId: session.userId, provider: "gmail", composioConnectedAccountId: accountId, email: mailboxEmail, normalizedEmail: mailboxEmail, alias: "inbound", status: "active" });
    await db.insert(schema.sequences).values({ id: sequenceId, workspaceId, name: "Inbound characterization", status: "active" });
    await db.insert(schema.sequenceVersions).values({ id: versionId, workspaceId, sequenceId, version: 1, status: "active" });
    await db.update(schema.sequences).set({ currentVersionId: versionId }).where(eq(schema.sequences.id, sequenceId));
  });

  afterAll(async () => {
    await app?.close();
    if (workspaceId) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    await pool.end();
  });

  async function createEnrollment(email: string) {
    const contactId = randomUUID();
    const enrollmentId = randomUUID();
    await db.insert(schema.contacts).values({ id: contactId, workspaceId, email, normalizedEmail: email, status: "enrolled" });
    await db.insert(schema.enrollments).values({ id: enrollmentId, workspaceId, contactId, sequenceId, sequenceVersionId: versionId, emailAccountId: mailboxId, status: "active" });
    return { contactId, enrollmentId };
  }

  async function postWebhook(raw: string, eventId: string) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    return app.inject({ method: "POST", url: "/v1/webhooks/composio", payload: raw, headers: { "content-type": "application/json", "webhook-id": eventId, "webhook-timestamp": timestamp, "webhook-signature": signWebhook(raw, eventId, timestamp, webhookSecret) } });
  }

  it("ingests the same event id or log id only once without duplicate replies or message events", async () => {
    const email = `inbound-dedupe-${suffix}@example.com`;
    const { contactId, enrollmentId } = await createEnrollment(email);
    const eventId = `inbound-dedupe-event-${suffix}`;
    const logId = `inbound-dedupe-log-${suffix}`;
    const raw = JSON.stringify({
      type: "gmail_new_gmail_message",
      timestamp: new Date().toISOString(),
      metadata: { connected_account_id: accountId, trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE", log_id: logId },
      data: { message_id: `inbound-dedupe-message-${suffix}`, from: email, to: mailboxEmail, subject: "Automatic reply: Intro", message_text: "I am currently unavailable." },
    });

    const first = await postWebhook(raw, eventId);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ received: true, duplicate: false });
    const second = await postWebhook(raw, eventId);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ received: true, duplicate: true });
    const repeatedLog = await postWebhook(raw, `${eventId}-repeated-log`);
    expect(repeatedLog.statusCode).toBe(200);
    expect(repeatedLog.json()).toEqual({ received: true, duplicate: true });

    const replies = await db.select().from(schema.replies).where(and(eq(schema.replies.workspaceId, workspaceId), eq(schema.replies.contactId, contactId)));
    const events = await db.select().from(schema.messageEvents).where(eq(schema.messageEvents.workspaceId, workspaceId));
    const webhooks = await db.select().from(schema.providerWebhookEvents).where(and(eq(schema.providerWebhookEvents.provider, "composio"), eq(schema.providerWebhookEvents.logId, logId)));
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ enrollmentId, isAutoReply: true });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: "auto_reply", providerEventId: eventId });
    expect(webhooks).toHaveLength(1);
    expect(webhooks[0]).toMatchObject({ eventId, status: "processed" });
  });

  it("routes an unknown connected account by its unique matching mailbox email", async () => {
    const email = `inbound-fallback-${suffix}@example.com`;
    const { contactId, enrollmentId } = await createEnrollment(email);
    const eventId = `inbound-fallback-event-${suffix}`;
    const unknownAccountId = `unknown-connected-${suffix}`;
    const raw = JSON.stringify({
      type: "gmail_new_gmail_message",
      timestamp: new Date().toISOString(),
      metadata: { connected_account_id: unknownAccountId, trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE" },
      data: { message_id: `inbound-fallback-message-${suffix}`, from: email, to: { emailAddress: mailboxEmail }, subject: "Re: Intro", message_text: "Yes, let's talk next week." },
    });

    const response = await postWebhook(raw, eventId);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true, duplicate: false });
    const [reply] = await db.select().from(schema.replies).where(and(eq(schema.replies.workspaceId, workspaceId), eq(schema.replies.contactId, contactId)));
    const [enrollment] = await db.select().from(schema.enrollments).where(eq(schema.enrollments.id, enrollmentId));
    const [event] = await db.select().from(schema.messageEvents).where(eq(schema.messageEvents.providerEventId, eventId));
    const [webhook] = await db.select().from(schema.providerWebhookEvents).where(and(eq(schema.providerWebhookEvents.provider, "composio"), eq(schema.providerWebhookEvents.eventId, eventId)));
    expect(reply).toMatchObject({ emailAccountId: mailboxId, fromEmail: email, intent: "human" });
    expect(enrollment).toMatchObject({ status: "replied", stopReason: "reply_detected" });
    expect(event).toMatchObject({ workspaceId, eventType: "replied", metadata: { connectedAccountId: unknownAccountId } });
    expect(webhook).toMatchObject({ workspaceId, status: "processed" });
  });

  it("keeps a deleted mailbox deleted when its old connection expires", async () => {
    const [owner] = await db.select({ userId: schema.emailAccounts.userId }).from(schema.emailAccounts).where(eq(schema.emailAccounts.id, mailboxId));
    const mailboxes = (["removed", "active"] as const).map((status) => ({ id: randomUUID(), status, accountId: `expiry-${status}-${suffix}` }));
    await db.insert(schema.emailAccounts).values(mailboxes.map((mailbox) => ({
      id: mailbox.id, workspaceId, userId: owner!.userId, provider: "gmail" as const, composioConnectedAccountId: mailbox.accountId,
      email: `${mailbox.accountId}@example.com`, normalizedEmail: `${mailbox.accountId}@example.com`, alias: mailbox.accountId, status: mailbox.status,
    })));
    for (const mailbox of mailboxes) {
      const eventId = `expiry-event-${mailbox.status}-${suffix}`;
      const raw = JSON.stringify({ type: "composio.connected_account.expired", metadata: { connected_account_id: mailbox.accountId }, data: {} });
      expect((await postWebhook(raw, eventId)).statusCode).toBe(200);
    }
    const rows = await db.select({ id: schema.emailAccounts.id, status: schema.emailAccounts.status }).from(schema.emailAccounts).where(inArray(schema.emailAccounts.id, mailboxes.map((mailbox) => mailbox.id)));
    // The live mailbox proves the event was handled; the deleted one must not come back.
    expect(Object.fromEntries(rows.map((row) => [row.id, row.status]))).toEqual({ [mailboxes[0]!.id]: "removed", [mailboxes[1]!.id]: "expired" });
  });
});

describe.skipIf(!databaseUrl)("production bug regressions", () => {
  const suffix = randomUUID().slice(0, 8);
  const ids = {
    sequence: randomUUID(),
    version: randomUUID(),
    firstStep: randomUUID(),
    secondStep: randomUUID(),
    repliedContact: randomUUID(),
    repliedEnrollment: randomUUID(),
    firstMessage: randomUUID(),
    secondMessage: randomUUID(),
    bouncedContact: randomUUID(),
    bouncedEnrollment: randomUUID(),
    bouncedMessage: randomUUID(),
    otherAcceptedMessage: randomUUID(),
    pendingMessage: randomUUID(),
    autoReplyContact: randomUUID(),
    autoReplyEnrollment: randomUUID(),
    autoReplyMessage: randomUUID(),
    webhookReplyContact: randomUUID(),
    webhookReplyEnrollment: randomUUID(),
    authPausedContact: randomUUID(),
    authPausedEnrollment: randomUUID(),
    headerAutoReplyContact: randomUUID(),
    headerAutoReplyEnrollment: randomUUID(),
    headerAutoReplyMessage: randomUUID(),
    subjectAutoReplyContact: randomUUID(),
    subjectAutoReplyEnrollment: randomUUID(),
    subjectAutoReplyMessage: randomUUID(),
    humanReplyContact: randomUUID(),
    humanReplyEnrollment: randomUUID(),
    humanReplyMessage: randomUUID(),
    bodyMentionContact: randomUUID(),
    bodyMentionEnrollment: randomUUID(),
    bodyMentionMessage: randomUUID(),
  };
  const accountId = `connected-${suffix}`;
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);
  let workspaceId = "";
  let ownerId = "";
  let mailboxId = "";
  let callbackState = "";
  const composio: ComposioClient = {
    enabled: true,
    createConnectLink: async ({ callbackUrl }) => {
      callbackState = new URL(callbackUrl).searchParams.get("state") ?? "";
      return { url: "https://composio.example.test/connect", expiresAt: new Date(Date.now() + 60_000) };
    },
    getConnectedAccount: async () => ({ id: accountId, provider: "gmail", email: `sender-${suffix}@example.com` }),
    ensureInboundMessageTrigger: async () => ({ triggerId: "trigger", triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE" }),
    sendEmail: async () => ({ providerMessageId: "test-message" }),
    findSentMessage: async () => "unknown",
  };
  const env = loadAppEnv({
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl ?? "postgresql://localhost/inboxjoy_test",
    API_BASE_URL: "https://api.example.test",
    WEB_BASE_URL: "https://app.example.test",
    CORS_ORIGINS: "https://app.example.test",
    AUTH_SECRET: authSecret,
    COMPOSIO_API_KEY: "composio-api-key-at-least-32-characters",
    COMPOSIO_WEBHOOK_SECRET: webhookSecret,
    COMPOSIO_GMAIL_AUTH_CONFIG_ID: "gmail-auth-config",
  });
  let app: Awaited<ReturnType<typeof buildApp>>;
  let session: Awaited<ReturnType<typeof createAuthenticatedSession>>;

  const connectMailbox = async () => {
    const connect = await app.inject({ method: "POST", headers: { cookie: session.cookie }, url: "/v1/inboxes/connect-link", payload: { provider: "gmail" } });
    expect(connect.statusCode).toBe(200);
    expect(callbackState).not.toBe("");
    const callback = await app.inject({ method: "GET", headers: { cookie: session.cookie }, url: `/v1/inboxes/connect/callback?provider=gmail&state=${encodeURIComponent(callbackState)}&connectedAccountId=${accountId}` });
    expect(callback.statusCode).toBe(302);
  };

  beforeAll(async () => {
    app = await buildApp({ env, db, composio });
    session = await createAuthenticatedSession(app);
    workspaceId = session.workspaceId;
    ownerId = session.userId;
  });

  afterAll(async () => {
    await app?.close();
    if (ids.sequence) await db.delete(schema.sequences).where(eq(schema.sequences.id, ids.sequence));
    if (mailboxId) await db.delete(schema.emailAccounts).where(eq(schema.emailAccounts.id, mailboxId));
    await db.delete(schema.contacts).where(inArray(schema.contacts.id, [
      ids.repliedContact, ids.bouncedContact, ids.autoReplyContact, ids.webhookReplyContact, ids.authPausedContact,
      ids.headerAutoReplyContact, ids.subjectAutoReplyContact, ids.humanReplyContact, ids.bodyMentionContact,
    ]));
    await pool.end();
  });

  it("starts warm-up on first connect without resetting it on reconnect", async () => {
    await connectMailbox();
    const [mailbox] = await db.select().from(schema.emailAccounts).where(and(eq(schema.emailAccounts.workspaceId, workspaceId), eq(schema.emailAccounts.composioConnectedAccountId, accountId)));
    expect(mailbox?.rampStartedOn).toBe(new Date().toISOString().slice(0, 10));
    mailboxId = mailbox!.id;

    const inboxes = await app.inject({ method: "GET", headers: { cookie: session.cookie }, url: "/v1/inboxes" });
    expect(inboxes.statusCode).toBe(200);
    expect(inboxes.json().inboxes).toEqual(expect.arrayContaining([expect.objectContaining({ id: mailboxId, rampStartedOn: mailbox!.rampStartedOn, warmupPercent: 40 })]));

    await db.update(schema.emailAccounts).set({ rampStartedOn: "2000-01-01" }).where(eq(schema.emailAccounts.id, mailboxId));
    await connectMailbox();
    const [reconnected] = await db.select().from(schema.emailAccounts).where(eq(schema.emailAccounts.id, mailboxId));
    expect(reconnected?.rampStartedOn).toBe("2000-01-01");
  });

  it("attributes a replied enrollment to its final accepted step exactly once", async () => {
    const repliedEmail = `reply-${suffix}@example.com`;
    const firstAcceptedAt = new Date("2026-08-01T10:00:00.000Z");
    const secondAcceptedAt = new Date("2026-08-02T10:00:00.000Z");
    const repliedAt = new Date("2026-08-03T10:00:00.000Z");
    await db.insert(schema.sequences).values({ id: ids.sequence, workspaceId, name: `Analytics ${suffix}`, status: "active" });
    await db.insert(schema.sequenceVersions).values({ id: ids.version, workspaceId, sequenceId: ids.sequence, version: 1, status: "active" });
    await db.update(schema.sequences).set({ currentVersionId: ids.version }).where(eq(schema.sequences.id, ids.sequence));
    await db.insert(schema.sequenceSteps).values([
      { id: ids.firstStep, workspaceId, sequenceVersionId: ids.version, stepOrder: 1, subject: "First", bodyText: "First" },
      { id: ids.secondStep, workspaceId, sequenceVersionId: ids.version, stepOrder: 2, subject: "Second", bodyText: "Second" },
    ]);
    await db.insert(schema.contacts).values({ id: ids.repliedContact, workspaceId, email: repliedEmail, normalizedEmail: repliedEmail, status: "replied", repliedAt });
    await db.insert(schema.enrollments).values({ id: ids.repliedEnrollment, workspaceId, contactId: ids.repliedContact, sequenceId: ids.sequence, sequenceVersionId: ids.version, emailAccountId: mailboxId, status: "replied", stoppedAt: repliedAt });
    await db.insert(schema.messages).values([
      { id: ids.firstMessage, workspaceId, enrollmentId: ids.repliedEnrollment, sequenceStepId: ids.firstStep, emailAccountId: mailboxId, contactId: ids.repliedContact, status: "accepted", idempotencyKey: `${ids.repliedEnrollment}:1`, scheduledAt: firstAcceptedAt, acceptedAt: firstAcceptedAt, recipientEmail: repliedEmail, normalizedRecipientEmail: repliedEmail, subject: "First", bodyHash: "first" },
      { id: ids.secondMessage, workspaceId, enrollmentId: ids.repliedEnrollment, sequenceStepId: ids.secondStep, emailAccountId: mailboxId, contactId: ids.repliedContact, status: "accepted", idempotencyKey: `${ids.repliedEnrollment}:2`, scheduledAt: secondAcceptedAt, acceptedAt: secondAcceptedAt, recipientEmail: repliedEmail, normalizedRecipientEmail: repliedEmail, subject: "Second", bodyHash: "second" },
    ]);

    const analytics = await app.inject({ method: "GET", headers: { cookie: session.cookie }, url: `/v1/sequences/${ids.sequence}/analytics` });
    expect(analytics.statusCode).toBe(200);
    expect(analytics.json().totals.replied).toBe(1);
    expect(analytics.json().steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ stepId: ids.firstStep, replied: 0 }),
      expect.objectContaining({ stepId: ids.secondStep, replied: 1 }),
    ]));
  });

  it("resumes enrollments paused by mailbox authentication after reconnect", async () => {
    const email = `auth-paused-${suffix}@example.com`;
    await db.insert(schema.contacts).values({ id: ids.authPausedContact, workspaceId, email, normalizedEmail: email, status: "enrolled" });
    await db.insert(schema.enrollments).values({ id: ids.authPausedEnrollment, workspaceId, contactId: ids.authPausedContact, sequenceId: ids.sequence, sequenceVersionId: ids.version, emailAccountId: mailboxId, status: "paused", statusBeforePause: "active", pausedAt: new Date(), stopReason: "mailbox_auth_expired" });
    await db.update(schema.emailAccounts).set({ status: "expired" }).where(eq(schema.emailAccounts.id, mailboxId));

    await connectMailbox();

    const [enrollment] = await db.select().from(schema.enrollments).where(eq(schema.enrollments.id, ids.authPausedEnrollment));
    expect(enrollment).toMatchObject({ status: "active", statusBeforePause: null, pausedAt: null, stopReason: null });
  });

  it("records bounces, stops enrollments, and cancels pending messages", async () => {
    const bouncedEmail = `bounce-${suffix}@example.com`;
    await db.insert(schema.contacts).values({ id: ids.bouncedContact, workspaceId, email: bouncedEmail, normalizedEmail: bouncedEmail, status: "enrolled" });
    await db.insert(schema.enrollments).values({ id: ids.bouncedEnrollment, workspaceId, contactId: ids.bouncedContact, sequenceId: ids.sequence, sequenceVersionId: ids.version, emailAccountId: mailboxId, status: "active" });
    await db.insert(schema.messages).values([
      { id: ids.bouncedMessage, workspaceId, enrollmentId: ids.bouncedEnrollment, sequenceStepId: ids.firstStep, emailAccountId: mailboxId, contactId: ids.bouncedContact, status: "accepted", idempotencyKey: `${ids.bouncedEnrollment}:1`, scheduledAt: new Date("2026-08-10T10:00:00.000Z"), acceptedAt: new Date("2026-08-10T10:00:00.000Z"), providerMessageId: `provider-bounce-${suffix}`, recipientEmail: bouncedEmail, normalizedRecipientEmail: bouncedEmail, subject: "First", bodyHash: "accepted" },
      { id: ids.otherAcceptedMessage, workspaceId, enrollmentId: ids.bouncedEnrollment, sequenceStepId: ids.secondStep, emailAccountId: mailboxId, contactId: ids.bouncedContact, status: "accepted", idempotencyKey: `${ids.bouncedEnrollment}:other`, scheduledAt: new Date("2026-08-10T11:00:00.000Z"), acceptedAt: new Date("2026-08-10T11:00:00.000Z"), providerMessageId: `provider-other-${suffix}`, recipientEmail: bouncedEmail, normalizedRecipientEmail: bouncedEmail, subject: "Other", bodyHash: "other-accepted" },
      { id: ids.pendingMessage, workspaceId, enrollmentId: ids.bouncedEnrollment, sequenceStepId: ids.secondStep, emailAccountId: mailboxId, contactId: ids.bouncedContact, status: "scheduled", idempotencyKey: `${ids.bouncedEnrollment}:2`, scheduledAt: new Date("2026-08-11T10:00:00.000Z"), recipientEmail: bouncedEmail, normalizedRecipientEmail: bouncedEmail, subject: "Second", bodyHash: "pending" },
    ]);
    const eventId = `bounce-event-${suffix}`;
    const beforeAnalytics = await app.inject({ method: "GET", headers: { cookie: session.cookie }, url: "/v1/analytics/summary?range=90" });
    expect(beforeAnalytics.statusCode).toBe(200);
    const payload = { type: "trigger.event", data: { from: "MAILER-DAEMON@example.com", provider_message_id: `provider-bounce-${suffix}`, subject: "Delivery Status Notification (Failure)", body: `The address ${bouncedEmail} was not found.` }, metadata: { connected_account_id: accountId, trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE" } };
    const raw = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await app.inject({ method: "POST", url: "/v1/webhooks/composio", payload: raw, headers: { "content-type": "application/json", "webhook-id": eventId, "webhook-timestamp": timestamp, "webhook-signature": signWebhook(raw, eventId, timestamp, webhookSecret) } });
    expect(response.statusCode).toBe(200);

    const [contact] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, ids.bouncedContact));
    const [enrollment] = await db.select().from(schema.enrollments).where(eq(schema.enrollments.id, ids.bouncedEnrollment));
    const messages = await db.select().from(schema.messages).where(inArray(schema.messages.id, [ids.bouncedMessage, ids.otherAcceptedMessage, ids.pendingMessage]));
    const [event] = await db.select().from(schema.messageEvents).where(and(eq(schema.messageEvents.workspaceId, workspaceId), eq(schema.messageEvents.providerEventId, eventId)));
    const [notification] = await db.select().from(schema.notifications).where(and(eq(schema.notifications.workspaceId, workspaceId), eq(schema.notifications.type, "bounce")));
    const suppressions = await db.select().from(schema.suppressions).where(and(eq(schema.suppressions.workspaceId, workspaceId), eq(schema.suppressions.normalizedEmail, bouncedEmail)));
    const afterAnalytics = await app.inject({ method: "GET", headers: { cookie: session.cookie }, url: "/v1/analytics/summary?range=90" });
    expect(afterAnalytics.statusCode).toBe(200);
    expect(contact).toMatchObject({ status: "bounced" });
    expect(contact?.bouncedAt).toBeInstanceOf(Date);
    // The bounce is a hard, permanent failure (MAILER-DAEMON: address not found), so the
    // classifier tags every downstream record with the specific classification rather than a
    // generic "bounced" label -- see classifyBounceWebhook in modules/webhooks/index.ts.
    expect(enrollment).toMatchObject({ status: "bounced", stopReason: "hard_bounce" });
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: ids.bouncedMessage, status: "accepted", errorClass: "hard_bounce", bouncedAt: expect.any(Date) }),
      expect.objectContaining({ id: ids.otherAcceptedMessage, status: "accepted", errorClass: null, bouncedAt: null }),
      expect.objectContaining({ id: ids.pendingMessage, status: "cancelled", errorClass: "hard_bounce" }),
    ]));
    expect(event).toMatchObject({ messageId: ids.bouncedMessage, eventType: "hard_bounce", providerEventId: eventId });
    expect(notification).toMatchObject({ title: "Email permanently rejected" });
    expect(suppressions).toHaveLength(1);
    expect(afterAnalytics.json().summary.sent).toBe(beforeAnalytics.json().summary.sent);
    expect(afterAnalytics.json().summary.bounced).toBe(beforeAnalytics.json().summary.bounced + 1);
    expect(afterAnalytics.json().summary.bounceRate).toBeGreaterThan(beforeAnalytics.json().summary.bounceRate);
  });

  it("records out-of-office replies without suppressing contacts or counting a bounce", async () => {
    const email = `auto-reply-${suffix}@example.com`;
    const acceptedAt = new Date();
    await db.insert(schema.contacts).values({ id: ids.autoReplyContact, workspaceId, email, normalizedEmail: email, status: "active" });
    await db.insert(schema.enrollments).values({ id: ids.autoReplyEnrollment, workspaceId, contactId: ids.autoReplyContact, sequenceId: ids.sequence, sequenceVersionId: ids.version, emailAccountId: mailboxId, status: "active" });
    await db.insert(schema.messages).values({ id: ids.autoReplyMessage, workspaceId, enrollmentId: ids.autoReplyEnrollment, sequenceStepId: ids.firstStep, emailAccountId: mailboxId, contactId: ids.autoReplyContact, status: "accepted", idempotencyKey: `${ids.autoReplyEnrollment}:1`, scheduledAt: acceptedAt, acceptedAt, recipientEmail: email, normalizedRecipientEmail: email, subject: "First", bodyHash: "auto-reply" });

    const before = await app.inject({ method: "GET", headers: { cookie: session.cookie }, url: "/v1/analytics/summary?range=7" });
    expect(before.statusCode).toBe(200);
    const eventId = `auto-reply-event-${suffix}`;
    const payload = { type: "delivery.failed", data: { from: email, subject: "Automatic reply: out of office" }, metadata: { connected_account_id: accountId, trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE" } };
    const raw = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await app.inject({ method: "POST", url: "/v1/webhooks/composio", payload: raw, headers: { "content-type": "application/json", "webhook-id": eventId, "webhook-timestamp": timestamp, "webhook-signature": signWebhook(raw, eventId, timestamp, webhookSecret) } });
    expect(response.statusCode).toBe(200);

    const [contact] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, ids.autoReplyContact));
    const [enrollment] = await db.select().from(schema.enrollments).where(eq(schema.enrollments.id, ids.autoReplyEnrollment));
    const [message] = await db.select().from(schema.messages).where(eq(schema.messages.id, ids.autoReplyMessage));
    const [event] = await db.select().from(schema.messageEvents).where(and(eq(schema.messageEvents.workspaceId, workspaceId), eq(schema.messageEvents.providerEventId, eventId)));
    const suppressions = await db.select().from(schema.suppressions).where(and(eq(schema.suppressions.workspaceId, workspaceId), eq(schema.suppressions.normalizedEmail, email)));
    const after = await app.inject({ method: "GET", headers: { cookie: session.cookie }, url: "/v1/analytics/summary?range=7" });
    expect(after.statusCode).toBe(200);

    expect(contact).toMatchObject({ status: "active", bouncedAt: null });
    expect(enrollment).toMatchObject({ status: "active", stoppedAt: null });
    expect(message).toMatchObject({ status: "accepted" });
    expect(event).toMatchObject({ messageId: ids.autoReplyMessage, eventType: "auto_reply", providerEventId: eventId });
    expect(suppressions).toHaveLength(0);
    expect(after.json().summary).toMatchObject({
      bounced: before.json().summary.bounced,
      softBounced: before.json().summary.softBounced,
    });
  });

  it("emits a notification when an enrolled contact replies", async () => {
    const email = `webhook-reply-${suffix}@example.com`;
    await db.insert(schema.contacts).values({ id: ids.webhookReplyContact, workspaceId, email, normalizedEmail: email, status: "enrolled" });
    await db.insert(schema.enrollments).values({ id: ids.webhookReplyEnrollment, workspaceId, contactId: ids.webhookReplyContact, sequenceId: ids.sequence, sequenceVersionId: ids.version, emailAccountId: mailboxId, status: "active" });
    const eventId = `reply-event-${suffix}`;
    const payload = { type: "trigger.event", data: { from: email, subject: "Re: hello" }, metadata: { connected_account_id: accountId, trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE" } };
    const raw = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await app.inject({ method: "POST", url: "/v1/webhooks/composio", payload: raw, headers: { "content-type": "application/json", "webhook-id": eventId, "webhook-timestamp": timestamp, "webhook-signature": signWebhook(raw, eventId, timestamp, webhookSecret) } });
    expect(response.statusCode).toBe(200);
    const [notification] = await db.select().from(schema.notifications).where(and(eq(schema.notifications.workspaceId, workspaceId), eq(schema.notifications.type, "reply")));
    expect(notification).toMatchObject({ title: "New reply" });
  });

  // Real production webhook shape: payload.data.payload.headers is an array of
  // { name, value } RFC header pairs -- see isAutoReply in modules/webhooks/index.ts.
  it("does not stop the enrollment for a header-based autoresponder (X-Autorespond, X-Loop)", async () => {
    const email = `header-auto-reply-${suffix}@example.com`;
    await db.insert(schema.contacts).values({ id: ids.headerAutoReplyContact, workspaceId, email, normalizedEmail: email, status: "enrolled" });
    await db.insert(schema.enrollments).values({ id: ids.headerAutoReplyEnrollment, workspaceId, contactId: ids.headerAutoReplyContact, sequenceId: ids.sequence, sequenceVersionId: ids.version, emailAccountId: mailboxId, status: "active" });
    await db.insert(schema.messages).values({ id: ids.headerAutoReplyMessage, workspaceId, enrollmentId: ids.headerAutoReplyEnrollment, sequenceStepId: ids.secondStep, emailAccountId: mailboxId, contactId: ids.headerAutoReplyContact, status: "scheduled", idempotencyKey: `${ids.headerAutoReplyEnrollment}:2`, scheduledAt: new Date(Date.now() + 60_000), recipientEmail: email, normalizedRecipientEmail: email, subject: "Second", bodyHash: "header-auto-reply" });

    const eventId = `header-auto-reply-event-${suffix}`;
    const payload = {
      type: "trigger.event",
      data: {
        from: email,
        subject: "Re: Intro call",
        message_text: "I am currently unavailable and will respond when I return.",
        payload: { headers: [
          { name: "Delivered-To", value: `sender-${suffix}@example.com` },
          { name: "Return-Path", value: `<${email}>` },
          { name: "From", value: email },
          { name: "Subject", value: "Re: Intro call" },
          { name: "X-Autorespond", value: "yes" },
          { name: "X-Loop", value: "autoreply@example.com" },
          { name: "Mime-Version", value: "1.0" },
        ] },
      },
      metadata: { connected_account_id: accountId, trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE" },
    };
    const raw = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await app.inject({ method: "POST", url: "/v1/webhooks/composio", payload: raw, headers: { "content-type": "application/json", "webhook-id": eventId, "webhook-timestamp": timestamp, "webhook-signature": signWebhook(raw, eventId, timestamp, webhookSecret) } });
    expect(response.statusCode).toBe(200);

    const [contact] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, ids.headerAutoReplyContact));
    const [enrollment] = await db.select().from(schema.enrollments).where(eq(schema.enrollments.id, ids.headerAutoReplyEnrollment));
    const [message] = await db.select().from(schema.messages).where(eq(schema.messages.id, ids.headerAutoReplyMessage));
    const [event] = await db.select().from(schema.messageEvents).where(and(eq(schema.messageEvents.workspaceId, workspaceId), eq(schema.messageEvents.providerEventId, eventId)));
    const [reply] = await db.select().from(schema.replies).where(and(eq(schema.replies.workspaceId, workspaceId), eq(schema.replies.contactId, ids.headerAutoReplyContact)));

    expect(contact).toMatchObject({ status: "enrolled", repliedAt: null });
    expect(enrollment).toMatchObject({ status: "active", stoppedAt: null, stopReason: null });
    expect(message).toMatchObject({ status: "scheduled" });
    expect(event).toMatchObject({ eventType: "auto_reply", providerEventId: eventId });
    expect(reply).toMatchObject({ isAutoReply: true, fromEmail: email });
  });

  it("does not stop the enrollment for a subject-based autoresponder (\"Automatic reply: ...\")", async () => {
    const email = `subject-auto-reply-${suffix}@example.com`;
    await db.insert(schema.contacts).values({ id: ids.subjectAutoReplyContact, workspaceId, email, normalizedEmail: email, status: "enrolled" });
    await db.insert(schema.enrollments).values({ id: ids.subjectAutoReplyEnrollment, workspaceId, contactId: ids.subjectAutoReplyContact, sequenceId: ids.sequence, sequenceVersionId: ids.version, emailAccountId: mailboxId, status: "active" });
    await db.insert(schema.messages).values({ id: ids.subjectAutoReplyMessage, workspaceId, enrollmentId: ids.subjectAutoReplyEnrollment, sequenceStepId: ids.secondStep, emailAccountId: mailboxId, contactId: ids.subjectAutoReplyContact, status: "scheduled", idempotencyKey: `${ids.subjectAutoReplyEnrollment}:2`, scheduledAt: new Date(Date.now() + 60_000), recipientEmail: email, normalizedRecipientEmail: email, subject: "Second", bodyHash: "subject-auto-reply" });

    const eventId = `subject-auto-reply-event-${suffix}`;
    const payload = {
      type: "trigger.event",
      data: {
        from: email,
        subject: "Automatic reply: Re: Intro call",
        message_text: "I am currently out of the office and will reply when I return.",
        payload: { headers: [{ name: "From", value: email }, { name: "Subject", value: "Automatic reply: Re: Intro call" }] },
      },
      metadata: { connected_account_id: accountId, trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE" },
    };
    const raw = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await app.inject({ method: "POST", url: "/v1/webhooks/composio", payload: raw, headers: { "content-type": "application/json", "webhook-id": eventId, "webhook-timestamp": timestamp, "webhook-signature": signWebhook(raw, eventId, timestamp, webhookSecret) } });
    expect(response.statusCode).toBe(200);

    const [contact] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, ids.subjectAutoReplyContact));
    const [enrollment] = await db.select().from(schema.enrollments).where(eq(schema.enrollments.id, ids.subjectAutoReplyEnrollment));
    const [message] = await db.select().from(schema.messages).where(eq(schema.messages.id, ids.subjectAutoReplyMessage));
    const [event] = await db.select().from(schema.messageEvents).where(and(eq(schema.messageEvents.workspaceId, workspaceId), eq(schema.messageEvents.providerEventId, eventId)));
    const [reply] = await db.select().from(schema.replies).where(and(eq(schema.replies.workspaceId, workspaceId), eq(schema.replies.contactId, ids.subjectAutoReplyContact)));

    expect(contact).toMatchObject({ status: "enrolled", repliedAt: null });
    expect(enrollment).toMatchObject({ status: "active", stoppedAt: null, stopReason: null });
    expect(message).toMatchObject({ status: "scheduled" });
    expect(event).toMatchObject({ eventType: "auto_reply", providerEventId: eventId });
    expect(reply).toMatchObject({ isAutoReply: true, fromEmail: email });
  });

  it("stops the enrollment and cancels follow-ups for a genuine human reply", async () => {
    const email = `human-reply-${suffix}@example.com`;
    await db.insert(schema.contacts).values({ id: ids.humanReplyContact, workspaceId, email, normalizedEmail: email, status: "enrolled" });
    await db.insert(schema.enrollments).values({ id: ids.humanReplyEnrollment, workspaceId, contactId: ids.humanReplyContact, sequenceId: ids.sequence, sequenceVersionId: ids.version, emailAccountId: mailboxId, status: "active" });
    await db.insert(schema.messages).values({ id: ids.humanReplyMessage, workspaceId, enrollmentId: ids.humanReplyEnrollment, sequenceStepId: ids.secondStep, emailAccountId: mailboxId, contactId: ids.humanReplyContact, status: "scheduled", idempotencyKey: `${ids.humanReplyEnrollment}:2`, scheduledAt: new Date(Date.now() + 60_000), recipientEmail: email, normalizedRecipientEmail: email, subject: "Second", bodyHash: "human-reply" });

    const eventId = `human-reply-event-${suffix}`;
    const payload = {
      type: "trigger.event",
      data: {
        from: email,
        subject: "RE: We need to question your website",
        message_text: "Thanks for reaching out, can you send more detail on pricing?",
        payload: { headers: [{ name: "From", value: email }, { name: "Subject", value: "RE: We need to question your website" }] },
      },
      metadata: { connected_account_id: accountId, trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE" },
    };
    const raw = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await app.inject({ method: "POST", url: "/v1/webhooks/composio", payload: raw, headers: { "content-type": "application/json", "webhook-id": eventId, "webhook-timestamp": timestamp, "webhook-signature": signWebhook(raw, eventId, timestamp, webhookSecret) } });
    expect(response.statusCode).toBe(200);

    const [contact] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, ids.humanReplyContact));
    const [enrollment] = await db.select().from(schema.enrollments).where(eq(schema.enrollments.id, ids.humanReplyEnrollment));
    const [message] = await db.select().from(schema.messages).where(eq(schema.messages.id, ids.humanReplyMessage));
    const [event] = await db.select().from(schema.messageEvents).where(and(eq(schema.messageEvents.workspaceId, workspaceId), eq(schema.messageEvents.providerEventId, eventId)));
    const [reply] = await db.select().from(schema.replies).where(and(eq(schema.replies.workspaceId, workspaceId), eq(schema.replies.contactId, ids.humanReplyContact)));

    expect(contact).toMatchObject({ status: "replied" });
    expect(contact?.repliedAt).toBeInstanceOf(Date);
    expect(enrollment).toMatchObject({ status: "replied", stopReason: "reply_detected" });
    expect(message).toMatchObject({ status: "cancelled", errorClass: "reply_detected" });
    expect(event).toMatchObject({ eventType: "replied", providerEventId: eventId });
    expect(reply).toMatchObject({ isAutoReply: false, fromEmail: email });
  });

  it("still treats a reply as human when only the body -- not the subject -- mentions being out of office", async () => {
    const email = `body-mention-${suffix}@example.com`;
    await db.insert(schema.contacts).values({ id: ids.bodyMentionContact, workspaceId, email, normalizedEmail: email, status: "enrolled" });
    await db.insert(schema.enrollments).values({ id: ids.bodyMentionEnrollment, workspaceId, contactId: ids.bodyMentionContact, sequenceId: ids.sequence, sequenceVersionId: ids.version, emailAccountId: mailboxId, status: "active" });
    await db.insert(schema.messages).values({ id: ids.bodyMentionMessage, workspaceId, enrollmentId: ids.bodyMentionEnrollment, sequenceStepId: ids.secondStep, emailAccountId: mailboxId, contactId: ids.bodyMentionContact, status: "scheduled", idempotencyKey: `${ids.bodyMentionEnrollment}:2`, scheduledAt: new Date(Date.now() + 60_000), recipientEmail: email, normalizedRecipientEmail: email, subject: "Second", bodyHash: "body-mention" });

    const eventId = `body-mention-event-${suffix}`;
    const payload = {
      type: "trigger.event",
      data: {
        from: email,
        subject: "RE: We need to question your website",
        message_text: "Sorry for the slow reply, I was out of office last week but I'm back now.",
        payload: { headers: [{ name: "From", value: email }, { name: "Subject", value: "RE: We need to question your website" }] },
      },
      metadata: { connected_account_id: accountId, trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE" },
    };
    const raw = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await app.inject({ method: "POST", url: "/v1/webhooks/composio", payload: raw, headers: { "content-type": "application/json", "webhook-id": eventId, "webhook-timestamp": timestamp, "webhook-signature": signWebhook(raw, eventId, timestamp, webhookSecret) } });
    expect(response.statusCode).toBe(200);

    const [contact] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, ids.bodyMentionContact));
    const [enrollment] = await db.select().from(schema.enrollments).where(eq(schema.enrollments.id, ids.bodyMentionEnrollment));
    const [message] = await db.select().from(schema.messages).where(eq(schema.messages.id, ids.bodyMentionMessage));
    const [reply] = await db.select().from(schema.replies).where(and(eq(schema.replies.workspaceId, workspaceId), eq(schema.replies.contactId, ids.bodyMentionContact)));

    expect(contact).toMatchObject({ status: "replied" });
    expect(contact?.repliedAt).toBeInstanceOf(Date);
    expect(enrollment).toMatchObject({ status: "replied", stopReason: "reply_detected" });
    expect(message).toMatchObject({ status: "cancelled", errorClass: "reply_detected" });
    expect(reply).toMatchObject({ isAutoReply: false, fromEmail: email });
  });
  it.each([
    { path: "hard_bounce", status: "active", expected: "completed" },
    { path: "human", status: "active", expected: "completed" },
    { path: "human", status: "paused", expected: "paused" },
    { path: "opt_out", status: "active", expected: "completed" },
    { path: "human", status: "archived", expected: "archived" },
    { path: "hard_bounce", status: "archived", expected: "archived" },
    { path: "human", status: "draft", expected: "draft" },
  ] as const)("keeps campaign lifecycle correct for $path on a $status campaign", async ({ path, status, expected }) => {
    const contactId = randomUUID();
    const enrollmentId = randomUUID();
    const campaignId = randomUUID();
    const messageId = randomUUID();
    const email = `campaign-lifecycle-${contactId}@example.com`;
    await db.insert(schema.contacts).values({ id: contactId, workspaceId, email, normalizedEmail: email, status: "enrolled" });
    await db.insert(schema.campaigns).values({ id: campaignId, workspaceId, sequenceId: ids.sequence, emailAccountId: mailboxId, name: `Lifecycle ${campaignId}`, status, launchedAt: status === "draft" ? null : new Date() });
    await db.insert(schema.enrollments).values({ id: enrollmentId, workspaceId, contactId, campaignId, sequenceId: ids.sequence, sequenceVersionId: ids.version, emailAccountId: mailboxId, status: "active" });
    await db.insert(schema.messages).values({ id: messageId, workspaceId, enrollmentId, sequenceStepId: ids.firstStep, emailAccountId: mailboxId, contactId, status: "accepted", idempotencyKey: `${enrollmentId}:1`, scheduledAt: new Date(), acceptedAt: new Date(), providerMessageId: `provider-${messageId}`, recipientEmail: email, normalizedRecipientEmail: email, subject: "Hello", bodyHash: "lifecycle" });
    try {
      const eventId = `lifecycle-${randomUUID()}`;
      const payload = { type: "trigger.event", data: path === "hard_bounce"
        ? { from: "MAILER-DAEMON@example.com", provider_message_id: `provider-${messageId}`, subject: "Delivery Status Notification (Failure)", body: `The address ${email} was not found.` }
        : { from: email, subject: "Re: Hello", message_text: path === "opt_out" ? "Please unsubscribe me." : "Thanks, can you send pricing?" },
      metadata: { connected_account_id: accountId, trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE" } };
      const raw = JSON.stringify(payload);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const response = await app.inject({ method: "POST", url: "/v1/webhooks/composio", payload: raw, headers: { "content-type": "application/json", "webhook-id": eventId, "webhook-timestamp": timestamp, "webhook-signature": signWebhook(raw, eventId, timestamp, webhookSecret) } });
      expect(response.statusCode).toBe(200);
      const [campaign] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
      expect(campaign?.status).toBe(expected);
      expect(campaign?.completedAt instanceof Date).toBe(expected === "completed");
      const notifications = await db.select().from(schema.notifications).where(and(eq(schema.notifications.workspaceId, workspaceId), eq(schema.notifications.title, `Campaign completed: Lifecycle ${campaignId}`)));
      expect(notifications).toHaveLength(expected === "completed" ? 1 : 0);
      const campaignsResponse = await app.inject({ method: "GET", url: `/v1/campaigns/${campaignId}`, headers: { cookie: session.cookie } });
      expect(campaignsResponse.statusCode).toBe(200);
      expect(campaignsResponse.json().campaign).toMatchObject({ status: expected, displayStatus: expected === "completed" ? "finished" : expected, statusReason: null, completedAt: campaign?.completedAt?.toISOString() ?? null });
    } finally {
      await db.delete(schema.enrollments).where(eq(schema.enrollments.id, enrollmentId));
      await db.delete(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
      await db.delete(schema.contacts).where(eq(schema.contacts.id, contactId));
      await db.delete(schema.suppressions).where(and(eq(schema.suppressions.workspaceId, workspaceId), eq(schema.suppressions.normalizedEmail, email)));
    }
  });
});

// Regression for the 2026-09-21 incident: a customer deleted their workspace 11 minutes
// after checkout. workspace.delete didn't cancel the live Dodo subscription (fixed in
// packages/core/src/index.ts), and every subsequent Dodo webhook for that vanished
// workspace 500'd forever on the subscriptions FK, so Dodo retried indefinitely. This
// verifies the webhook handler now acknowledges (200) and skips all writes instead.
describe.skipIf(!databaseUrl)("Dodo webhook for a deleted workspace", () => {
  const dodoWebhookSecret = "production-bugs-dodo-webhook-secret";
  const dodoWebhookKey = `whsec_${Buffer.from(dodoWebhookSecret).toString("base64")}`;

  function dodoSignature(body: string, webhookId: string, timestamp: string): string {
    return `v1,${createHmac("sha256", dodoWebhookSecret).update(`${webhookId}.${timestamp}.${body}`).digest("base64")}`;
  }

  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);
  const deletedWorkspaceId = randomUUID();
  const processedWebhookIds: string[] = [];
  const dodo: BillingClient = {
    createCheckoutSession: async () => ({}),
    createCustomerPortal: async () => ({}),
    retrieveSubscription: async () => ({}),
    listSubscriptions: async () => [],
    updateSubscription: async () => ({}),
  };
  const env = loadAppEnv({
    ...process.env,
    NODE_ENV: "test",
    INBOXJOY_EDITION: "cloud",
    DATABASE_URL: databaseUrl ?? "postgresql://localhost/inboxjoy_test",
    API_BASE_URL: "https://api.example.test",
    WEB_BASE_URL: "https://app.example.test",
    AUTH_SECRET: "production-bugs-dodo-auth-secret-at-least-32-chars",
    DODO_PAYMENTS_API_KEY: "dodo_test_key",
    DODO_PAYMENTS_WEBHOOK_KEY: dodoWebhookKey,
    DODO_PAYMENTS_ENVIRONMENT: "test_mode",
  });
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    // Insert then delete the workspace, exactly like the real incident: the webhook
    // metadata references a workspaceId that used to exist but no longer does.
    await db.insert(schema.workspaces).values({ id: deletedWorkspaceId, name: "Deleted webhook workspace", slug: `deleted-webhook-${randomUUID().slice(0, 8)}` });
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, deletedWorkspaceId));
    app = await buildApp({ env, db, dodo });
  });

  afterAll(async () => {
    await app?.close();
    for (const webhookId of processedWebhookIds) {
      await db.delete(schema.processedWebhookEvents).where(eq(schema.processedWebhookEvents.webhookId, webhookId));
    }
    await pool.end();
  });

  it("acknowledges a subscription webhook for a deleted workspace and writes nothing", async () => {
    const webhookId = `wh_deleted_ws_${randomUUID()}`;
    processedWebhookIds.push(webhookId);
    const dodoSubscriptionId = `sub_deleted_ws_${randomUUID()}`;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({
      business_id: "bus_test",
      type: "subscription.active",
      timestamp: new Date().toISOString(),
      data: {
        subscription_id: dodoSubscriptionId,
        product_id: "pdt_test_monthly",
        status: "active",
        next_billing_date: "2026-09-30T00:00:00.000Z",
        cancel_at_next_billing_date: false,
        customer: { customer_id: `cus_test_${randomUUID()}`, email: "owner@example.com", name: "Owner" },
        metadata: { workspaceId: deletedWorkspaceId },
      },
    });
    const headers = {
      "content-type": "application/json",
      "webhook-id": webhookId,
      "webhook-timestamp": timestamp,
      "webhook-signature": dodoSignature(body, webhookId, timestamp),
    };

    const response = await app.inject({ method: "POST", url: "/v1/webhooks/dodo", headers, payload: body });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true, duplicate: false });
    expect(await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.dodoSubscriptionId, dodoSubscriptionId))).toHaveLength(0);
  });

  it("acknowledges a payment.failed webhook for a deleted workspace and writes nothing", async () => {
    const webhookId = `wh_deleted_ws_payment_${randomUUID()}`;
    processedWebhookIds.push(webhookId);
    const dodoSubscriptionId = `sub_deleted_ws_payment_${randomUUID()}`;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({
      business_id: "bus_test",
      type: "payment.failed",
      timestamp: new Date().toISOString(),
      data: {
        subscription_id: dodoSubscriptionId,
        product_id: "pdt_test_monthly",
        status: "failed",
        customer: { customer_id: `cus_test_${randomUUID()}` },
        metadata: { workspaceId: deletedWorkspaceId },
      },
    });
    const headers = {
      "content-type": "application/json",
      "webhook-id": webhookId,
      "webhook-timestamp": timestamp,
      "webhook-signature": dodoSignature(body, webhookId, timestamp),
    };

    const response = await app.inject({ method: "POST", url: "/v1/webhooks/dodo", headers, payload: body });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true, duplicate: false });
    expect(await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.dodoSubscriptionId, dodoSubscriptionId))).toHaveLength(0);
  });
});
