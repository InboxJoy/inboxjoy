import { loadAppEnv } from "@inboxjoy/config";
import { ComposioRequestError, type ComposioClient } from "@inboxjoy/composio";
import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { and, eq, inArray } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { createAuthenticatedSession } from "./auth-helper.js";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("MCP-oriented operations", () => {
  const suffix = randomUUID().slice(0, 8);
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);
  const mailboxId = randomUUID();
  const secondMailboxId = randomUUID();
  const env = loadAppEnv({ ...process.env, NODE_ENV: "test", DATABASE_URL: databaseUrl ?? "postgresql://localhost/inboxjoy_test", API_BASE_URL: "https://api.example.test", WEB_BASE_URL: "https://app.example.test", CORS_ORIGINS: "https://app.example.test", AUTH_SECRET: "mcp-ops-test-secret-at-least-32-characters" });
  let providerSendCount = 0;
  let nextProviderSendError: unknown;
  const composio: ComposioClient = {
    enabled: true,
    createConnectLink: async () => null,
    getConnectedAccount: async () => null,
    ensureInboundMessageTrigger: async () => ({ triggerId: "test", triggerSlug: "test" }),
    sendEmail: async () => {
      providerSendCount++;
      if (nextProviderSendError !== undefined) {
        const error = nextProviderSendError;
        nextProviderSendError = undefined;
        throw error;
      }
      return { providerMessageId: "test-message" };
    },
    findSentMessage: async () => "unknown",
  };
  let app: Awaited<ReturnType<typeof buildApp>>;
  let session: Awaited<ReturnType<typeof createAuthenticatedSession>>;

  const markSequenceTested = async (sequenceId: string) => {
    const [sequence] = await db.select({ currentVersionId: schema.sequences.currentVersionId }).from(schema.sequences).where(eq(schema.sequences.id, sequenceId));
    await db.update(schema.sequenceVersions).set({ snapshot: { lastSuccessfulTestSendAt: new Date().toISOString() } }).where(eq(schema.sequenceVersions.id, sequence!.currentVersionId!));
  };

  const ensureActiveSubscription = async () => {
    const [subscription] = await db.select({ id: schema.subscriptions.id }).from(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, session.workspaceId)).limit(1);
    if (subscription) {
      await db.update(schema.subscriptions).set({ status: "active" }).where(eq(schema.subscriptions.id, subscription.id));
    } else {
      await db.insert(schema.subscriptions).values({ id: randomUUID(), workspaceId: session.workspaceId, status: "active" });
    }
  };

  const createManualReply = async (label: string) => {
    const contactId = randomUUID();
    const replyId = randomUUID();
    const recipient = `${label}-${suffix}@example.com`;
    await db.insert(schema.contacts).values({ id: contactId, workspaceId: session.workspaceId, email: recipient, normalizedEmail: recipient, status: "replied", repliedAt: new Date() });
    await db.insert(schema.replies).values({
      id: replyId, workspaceId: session.workspaceId, contactId, emailAccountId: secondMailboxId,
      subject: "Re: Hello", bodyText: "Can you share more?", fromEmail: recipient, receivedAt: new Date(),
    });
    return replyId;
  };

  const pendingManualReplyEvents = async (replyId: string) => {
    const events = await db.select().from(schema.messageEvents).where(and(
      eq(schema.messageEvents.workspaceId, session.workspaceId),
      eq(schema.messageEvents.eventType, "manual_reply_pending"),
    ));
    return events.filter((event) => event.metadata?.replyId === replyId);
  };

  beforeAll(async () => {
    app = await buildApp({ env, db, composio });
    session = await createAuthenticatedSession(app, "MCP Ops Test User");
    await db.update(schema.workspaces).set({ postalAddress: "123 Main St\nAustin, TX 78701" }).where(eq(schema.workspaces.id, session.workspaceId));
    await db.insert(schema.emailAccounts).values([
      { id: mailboxId, workspaceId: session.workspaceId, userId: session.userId, provider: "gmail", composioConnectedAccountId: `mcp-ops-${suffix}`, email: `sender-${suffix}@example.com`, normalizedEmail: `sender-${suffix}@example.com`, alias: `mcp-ops-${suffix}`, status: "active" },
      { id: secondMailboxId, workspaceId: session.workspaceId, userId: session.userId, provider: "gmail", composioConnectedAccountId: `mcp-ops-second-${suffix}`, email: `sender-second-${suffix}@example.com`, normalizedEmail: `sender-second-${suffix}@example.com`, alias: `mcp-ops-second-${suffix}`, status: "active" },
    ]);
  });

  afterAll(async () => {
    await app?.close();
    if (session) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, session.workspaceId));
    await pool.end();
  });

  it("imports, updates, suppresses, skips invalid rows, and attaches a list", async () => {
    const suppressedEmail = `suppressed-${suffix}@example.com`;
    await db.insert(schema.suppressions).values({ id: randomUUID(), workspaceId: session.workspaceId, email: suppressedEmail, normalizedEmail: suppressedEmail, emailHash: createHash("sha256").update(suppressedEmail).digest("hex"), reason: "manual", source: "manual" });
    const listName = `Imported ${suffix}`;
    const firstEmail = `First-${suffix}@Example.com`;
    const secondEmail = `second-${suffix}@example.com`;
    const imported = await app.inject({
      method: "POST",
      url: "/v1/leads/import",
      headers: { cookie: session.cookie },
      payload: { listName, leads: [{ email: ` ${firstEmail} `, firstName: "First" }, { email: secondEmail, company: "Original" }, { email: suppressedEmail }, { email: "not-an-email" }] },
    });

    expect(imported.statusCode).toBe(200);
    expect(imported.json()).toMatchObject({ imported: 2, updated: 0, skippedSuppressed: 1, skippedInvalid: 1 });
    expect(imported.json().listId).toEqual(expect.any(String));

    const reimported = await app.inject({
      method: "POST",
      url: "/v1/leads/import",
      headers: { cookie: session.cookie },
      payload: { leads: [{ email: firstEmail.toLowerCase(), firstName: "Updated" }, { email: secondEmail, company: "Updated Company" }] },
    });
    expect(reimported.json()).toMatchObject({ imported: 0, updated: 2, skippedSuppressed: 0, skippedInvalid: 0 });

    const contacts = await db.select().from(schema.contacts).where(and(eq(schema.contacts.workspaceId, session.workspaceId), inArray(schema.contacts.normalizedEmail, [firstEmail.toLowerCase(), secondEmail, suppressedEmail])));
    expect(contacts).toHaveLength(2);
    expect(contacts.find((contact) => contact.normalizedEmail === firstEmail.toLowerCase())?.firstName).toBe("Updated");
    expect(contacts.find((contact) => contact.normalizedEmail === secondEmail)?.company).toBe("Updated Company");

    const lead = contacts.find((contact) => contact.normalizedEmail === firstEmail.toLowerCase())!;
    const detail = await app.inject({ method: "GET", url: `/v1/leads/${lead.id}`, headers: { cookie: session.cookie } });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().lists).toEqual(expect.arrayContaining([expect.objectContaining({ id: imported.json().listId, name: listName })]));
    expect((await app.inject({ method: "GET", url: "/v1/lists", headers: { cookie: session.cookie } })).json().lists).toEqual(expect.arrayContaining([expect.objectContaining({ id: imported.json().listId, count: 2 })]));
  });

  it("launch composes publish and enroll with the same skip behavior", async () => {
    const listId = randomUUID();
    const activeContact = randomUUID();
    const secondActiveContact = randomUUID();
    const suppressedContact = randomUUID();
    const suppressedEmail = `launch-suppressed-${suffix}@example.com`;
    await db.insert(schema.contactLists).values({ id: listId, workspaceId: session.workspaceId, name: `Launch ${suffix}` });
    await db.insert(schema.contacts).values([
      { id: activeContact, workspaceId: session.workspaceId, email: `launch-active-${suffix}@example.com`, normalizedEmail: `launch-active-${suffix}@example.com`, status: "active" },
      { id: secondActiveContact, workspaceId: session.workspaceId, email: `launch-active-second-${suffix}@example.com`, normalizedEmail: `launch-active-second-${suffix}@example.com`, status: "active" },
      { id: suppressedContact, workspaceId: session.workspaceId, email: suppressedEmail, normalizedEmail: suppressedEmail, status: "active" },
    ]);
    await db.insert(schema.contactListMembers).values([{ workspaceId: session.workspaceId, contactListId: listId, contactId: activeContact }, { workspaceId: session.workspaceId, contactListId: listId, contactId: secondActiveContact }, { workspaceId: session.workspaceId, contactListId: listId, contactId: suppressedContact }]);
    await db.insert(schema.suppressions).values({ id: randomUUID(), workspaceId: session.workspaceId, email: suppressedEmail, normalizedEmail: suppressedEmail, emailHash: createHash("sha256").update(suppressedEmail).digest("hex"), reason: "manual", source: "manual" });

    const createSequence = async (name: string) => (await app.inject({ method: "POST", url: "/v1/sequences", headers: { cookie: session.cookie }, payload: { name, steps: [{ delayDays: 0, subject: "Hello", body: "Hello" }] } })).json().sequence.id as string;
    const launchedSequenceId = await createSequence(`Launch composed ${suffix}`);
    const directSequenceId = await createSequence(`Launch direct ${suffix}`);
    await markSequenceTested(launchedSequenceId);
    await markSequenceTested(directSequenceId);
    const launched = await app.inject({ method: "POST", url: `/v1/sequences/${launchedSequenceId}/launch`, headers: { cookie: session.cookie }, payload: { listId, mailboxIds: [mailboxId, secondMailboxId] } });
    await db.update(schema.contacts).set({ status: "active" }).where(inArray(schema.contacts.id, [activeContact, secondActiveContact]));
    const published = await app.inject({ method: "POST", url: `/v1/sequences/${directSequenceId}/publish`, headers: { cookie: session.cookie } });
    const direct = await app.inject({ method: "POST", url: `/v1/sequences/${directSequenceId}/enroll`, headers: { cookie: session.cookie }, payload: { listId, inboxId: mailboxId } });

    expect(launched.statusCode).toBe(200);
    expect(published.statusCode).toBe(200);
    expect(direct.statusCode).toBe(200);
    expect(launched.json().sequence.status).toBe("published");
    expect(launched.json()).toMatchObject({ enrolled: direct.json().enrolled, skipped: direct.json().skipped });
    expect(launched.json()).toMatchObject({ enrolled: 2, skipped: { suppressed: 1 } });
    const rotated = await db.select({ emailAccountId: schema.enrollments.emailAccountId }).from(schema.enrollments).where(eq(schema.enrollments.sequenceId, launchedSequenceId));
    expect(new Set(rotated.map((enrollment) => enrollment.emailAccountId))).toEqual(new Set([mailboxId, secondMailboxId]));

    const sequence = await app.inject({ method: "GET", url: `/v1/sequences/${launchedSequenceId}`, headers: { cookie: session.cookie } });
    expect(sequence.json()).toMatchObject({ id: launchedSequenceId, status: "published", version: 1, versionStatus: "active" });
    const enrollments = await app.inject({ method: "GET", url: `/v1/enrollments?sequenceId=${launchedSequenceId}&status=scheduled`, headers: { cookie: session.cookie } });
    expect(enrollments.json()).toMatchObject({ pagination: { total: 2 }, enrollments: [expect.objectContaining({ status: "scheduled" }), expect.objectContaining({ status: "scheduled" })] });
  });

  it("reports the sequence funnel and best-performing sent step", async () => {
    const create = await app.inject({ method: "POST", url: "/v1/sequences", headers: { cookie: session.cookie }, payload: { name: `Report ${suffix}`, steps: [{ delayDays: 0, subject: "First", body: "First" }, { delayDays: 1, subject: "Second", body: "Second" }] } });
    const sequenceId = create.json().sequence.id as string;
    await markSequenceTested(sequenceId);
    await app.inject({ method: "POST", url: `/v1/sequences/${sequenceId}/publish`, headers: { cookie: session.cookie } });
    const [sequence] = await db.select().from(schema.sequences).where(eq(schema.sequences.id, sequenceId));
    const steps = await db.select().from(schema.sequenceSteps).where(eq(schema.sequenceSteps.sequenceVersionId, sequence!.currentVersionId!));
    const firstStep = steps.find((step) => step.stepOrder === 1)!;
    const contactIds = [randomUUID(), randomUUID()];
    const replyAt = new Date();
    await db.insert(schema.contacts).values([
      { id: contactIds[0], workspaceId: session.workspaceId, email: `report-reply-${suffix}@example.com`, normalizedEmail: `report-reply-${suffix}@example.com`, status: "replied", repliedAt: replyAt },
      { id: contactIds[1], workspaceId: session.workspaceId, email: `report-active-${suffix}@example.com`, normalizedEmail: `report-active-${suffix}@example.com`, status: "enrolled" },
    ]);
    const enrollmentIds = [randomUUID(), randomUUID()];
    await db.insert(schema.enrollments).values([
      { id: enrollmentIds[0], workspaceId: session.workspaceId, contactId: contactIds[0], sequenceId, sequenceVersionId: sequence!.currentVersionId!, emailAccountId: mailboxId, status: "replied", startedAt: replyAt, stoppedAt: replyAt },
      { id: enrollmentIds[1], workspaceId: session.workspaceId, contactId: contactIds[1], sequenceId, sequenceVersionId: sequence!.currentVersionId!, emailAccountId: mailboxId, status: "active", startedAt: replyAt },
    ]);
    const firstMessageId = randomUUID();
    await db.insert(schema.messages).values({ id: firstMessageId, workspaceId: session.workspaceId, enrollmentId: enrollmentIds[0], sequenceStepId: firstStep.id, emailAccountId: mailboxId, contactId: contactIds[0], status: "accepted", idempotencyKey: `${enrollmentIds[0]}:1`, scheduledAt: replyAt, acceptedAt: replyAt, recipientEmail: `report-reply-${suffix}@example.com`, normalizedRecipientEmail: `report-reply-${suffix}@example.com`, subject: "First", bodyHash: "report-first" });
    // Replies are now sourced from the `replies` table (populated by the inbound
    // webhook and the backfill job), not derived from contacts.repliedAt.
    await db.insert(schema.replies).values({ id: randomUUID(), workspaceId: session.workspaceId, contactId: contactIds[0], enrollmentId: enrollmentIds[0], sequenceId, emailAccountId: mailboxId, inReplyToMessageId: firstMessageId, providerMessageId: `report-reply-msg-${suffix}`, providerThreadId: `report-reply-thread-${suffix}`, subject: "Re: First", bodyText: "Sounds good, let us talk.", snippet: "Sounds good, let us talk.", fromEmail: `report-reply-${suffix}@example.com`, receivedAt: replyAt });

    const report = await app.inject({ method: "GET", url: `/v1/reports/campaign/${sequenceId}`, headers: { cookie: session.cookie } });
    expect(report.statusCode).toBe(200);
    expect(report.json().funnel).toEqual({ enrolled: 2, sent: 1, opened: 0, replied: 1, bounced: 0 });
    expect(report.json().bestPerformingStep).toMatchObject({ stepId: firstStep.id, stepOrder: 1, sent: 1, replied: 1, replyRate: 100 });

    const replies = await app.inject({ method: "GET", url: "/v1/replies", headers: { cookie: session.cookie } });
    expect(replies.json().replies).toEqual(expect.arrayContaining([expect.objectContaining({ contactId: contactIds[0], sequenceId, stepId: firstStep.id, stepOrder: 1 })]));
    const overview = await app.inject({ method: "GET", url: "/v1/analytics/overview", headers: { cookie: session.cookie } });
    expect(overview.json()).toMatchObject({ sent: expect.any(Number), delivered: expect.any(Number), opened: expect.any(Number), replied: expect.any(Number), bounced: expect.any(Number), activeSequences: expect.any(Number), healthyMailboxes: expect.any(Number) });
    expect(overview.json().sent).toBeGreaterThanOrEqual(1);
    expect(overview.json().replied).toBeGreaterThanOrEqual(1);
  });

  it("gates manual replies, records them in the thread, and deduplicates a retry", async () => {
    const contactId = randomUUID();
    const replyId = randomUUID();
    const idempotencyKey = randomUUID();
    const recipient = `manual-reply-${suffix}@example.com`;
    await db.insert(schema.contacts).values({ id: contactId, workspaceId: session.workspaceId, email: recipient, normalizedEmail: recipient, status: "replied", repliedAt: new Date() });
    await db.insert(schema.replies).values({
      id: replyId, workspaceId: session.workspaceId, contactId, emailAccountId: secondMailboxId,
      subject: "Re: Hello", bodyText: "Can you share more?", fromEmail: recipient, receivedAt: new Date(),
    });
    const send = () => app.inject({
      method: "POST", url: `/v1/replies/${replyId}/send`, headers: { cookie: session.cookie },
      payload: { body: "Yes, I can.", idempotencyKey },
    });
    const before = providerSendCount;

    await db.update(schema.workspaces).set({ killSwitchEnabled: true }).where(eq(schema.workspaces.id, session.workspaceId));
    const paused = await send();
    expect(paused.statusCode).toBe(403);
    expect(paused.json().error).toBe("Sending is paused for this workspace.");
    await db.update(schema.workspaces).set({ killSwitchEnabled: false }).where(eq(schema.workspaces.id, session.workspaceId));
    // No subscription: the free plan still sends manual replies (never capped).
    await db.update(schema.emailAccounts).set({ status: "paused" }).where(eq(schema.emailAccounts.id, secondMailboxId));
    const inactiveMailbox = await send();
    expect(inactiveMailbox.statusCode).toBe(403);
    expect(inactiveMailbox.json().error).toBe("This mailbox is inactive and cannot send email.");
    await db.update(schema.emailAccounts).set({ status: "active" }).where(eq(schema.emailAccounts.id, secondMailboxId));
    expect(providerSendCount).toBe(before);

    const first = await send();
    expect(first.statusCode).toBe(200);
    expect((await send()).statusCode).toBe(200);
    expect(providerSendCount).toBe(before + 1);
    const detail = await app.inject({ method: "GET", url: `/v1/replies/${replyId}`, headers: { cookie: session.cookie } });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().reply.thread).toEqual(expect.arrayContaining([
      expect.objectContaining({ direction: "outbound", body: "Yes, I can." }),
    ]));
  });

  it("releases a manual reply reservation after a definite provider rejection", async () => {
    await ensureActiveSubscription();
    const replyId = await createManualReply("manual-reply-rejected");
    const send = () => app.inject({
      method: "POST", url: `/v1/replies/${replyId}/send`, headers: { cookie: session.cookie },
      payload: { body: "I can help with that." },
    });
    const before = providerSendCount;
    nextProviderSendError = new ComposioRequestError(401, { error: "unauthorized" });

    const rejected = await send();
    expect(rejected.statusCode).toBe(503);
    expect(rejected.json().error).toBe("Reconnect this mailbox and try again.");
    expect(await pendingManualReplyEvents(replyId)).toHaveLength(0);

    expect((await send()).statusCode).toBe(200);
    expect(providerSendCount).toBe(before + 2);
  });

  it("retains a manual reply reservation when the provider result is unknown", async () => {
    await ensureActiveSubscription();
    const replyId = await createManualReply("manual-reply-timeout");
    const send = () => app.inject({
      method: "POST", url: `/v1/replies/${replyId}/send`, headers: { cookie: session.cookie },
      payload: { body: "Let me check and get back to you." },
    });
    const before = providerSendCount;
    nextProviderSendError = new Error("socket timeout");

    const timedOut = await send();
    expect(timedOut.statusCode).toBe(503);
    expect(timedOut.json().error).toBe("The send result is unknown. Check the conversation before trying again.");
    expect(await pendingManualReplyEvents(replyId)).toHaveLength(1);

    const retry = await send();
    expect(retry.statusCode).toBe(409);
    expect(retry.json().error).toBe("This reply may already have been sent. Check the conversation before trying again.");
    expect(providerSendCount).toBe(before + 1);
  });
});
