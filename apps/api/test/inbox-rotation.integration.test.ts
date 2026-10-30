import type { ComposioClient } from "@inboxjoy/composio";
import { loadAppEnv } from "@inboxjoy/config";
import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { createAuthenticatedSession } from "./auth-helper.js";

const databaseUrl = process.env.DATABASE_URL;
const authSecret = "inbox-rotation-auth-secret-at-least-32-characters";

describe.skipIf(!databaseUrl)("inbox rotation", () => {
  const suffix = randomUUID().slice(0, 8);
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);
  const mailboxIds = { high: randomUUID(), low: randomUUID(), unhealthy: randomUUID(), critical: randomUUID(), pendingAddress: randomUUID(), foreign: randomUUID(), smtp: randomUUID() };
  const composio: ComposioClient = {
    enabled: true,
    createConnectLink: async () => null,
    getConnectedAccount: async () => null,
    ensureInboundMessageTrigger: async () => ({ triggerId: "test", triggerSlug: "test" }),
    sendEmail: async () => ({ providerMessageId: "test-message" }),
    findSentMessage: async () => "unknown",
  };
  const env = loadAppEnv({ ...process.env, NODE_ENV: "test", DATABASE_URL: databaseUrl ?? "postgresql://localhost/inboxjoy_test", API_BASE_URL: "https://api.example.test", WEB_BASE_URL: "https://app.example.test", CORS_ORIGINS: "https://app.example.test", AUTH_SECRET: authSecret });
  let app: Awaited<ReturnType<typeof buildApp>>;
  let session: Awaited<ReturnType<typeof createAuthenticatedSession>>;
  let otherSession: Awaited<ReturnType<typeof createAuthenticatedSession>>;

  const createContacts = async (count: number, label: string) => {
    const contacts = Array.from({ length: count }, (_, index) => ({
      id: randomUUID(),
      workspaceId: session.workspaceId,
      email: `${label}-${suffix}-${index}@example.com`,
      normalizedEmail: `${label}-${suffix}-${index}@example.com`,
      status: "active" as const,
    }));
    await db.insert(schema.contacts).values(contacts);
    return contacts.map((contact) => contact.id);
  };

  const createPublishedSequence = async (label: string) => {
    const created = await app.inject({ method: "POST", headers: { cookie: session.cookie }, url: "/v1/sequences", payload: { name: `${label} ${suffix}`, steps: [{ delayDays: 0, subject: "Hello", body: "Hello there" }, { delayDays: 1, subject: "Following up", body: "Checking in" }] } });
    expect(created.statusCode).toBe(201);
    const sequenceId = created.json().sequence.id as string;
    const [sequence] = await db.select({ currentVersionId: schema.sequences.currentVersionId }).from(schema.sequences).where(eq(schema.sequences.id, sequenceId));
    await db.update(schema.sequenceVersions).set({ snapshot: { lastSuccessfulTestSendAt: new Date().toISOString() } }).where(eq(schema.sequenceVersions.id, sequence!.currentVersionId!));
    const published = await app.inject({ method: "POST", headers: { cookie: session.cookie }, url: `/v1/sequences/${sequenceId}/publish` });
    expect(published.statusCode).toBe(200);
    return sequenceId;
  };

  beforeAll(async () => {
    app = await buildApp({ env, db, composio });
    session = await createAuthenticatedSession(app, "Inbox Rotation Test");
    otherSession = await createAuthenticatedSession(app, "Inbox Rotation Other Workspace");
    await db.update(schema.workspaces).set({ postalAddress: "123 Main St\nAustin, TX 78701" }).where(eq(schema.workspaces.id, session.workspaceId));
    await db.insert(schema.emailAccounts).values([
      { id: mailboxIds.high, workspaceId: session.workspaceId, userId: session.userId, provider: "gmail", composioConnectedAccountId: `rotation-high-${suffix}`, email: `rotation-high-${suffix}@example.com`, normalizedEmail: `rotation-high-${suffix}@example.com`, alias: `rotation-high-${suffix}`, status: "active", dailyLimit: 10 },
      { id: mailboxIds.low, workspaceId: session.workspaceId, userId: session.userId, provider: "gmail", composioConnectedAccountId: `rotation-low-${suffix}`, email: `rotation-low-${suffix}@example.com`, normalizedEmail: `rotation-low-${suffix}@example.com`, alias: `rotation-low-${suffix}`, status: "active", dailyLimit: 10 },
      { id: mailboxIds.unhealthy, workspaceId: session.workspaceId, userId: session.userId, provider: "gmail", composioConnectedAccountId: `rotation-unhealthy-${suffix}`, email: `rotation-unhealthy-${suffix}@example.com`, normalizedEmail: `rotation-unhealthy-${suffix}@example.com`, alias: `rotation-unhealthy-${suffix}`, status: "active", dailyLimit: 100 },
      { id: mailboxIds.critical, workspaceId: session.workspaceId, userId: session.userId, provider: "gmail", composioConnectedAccountId: `rotation-critical-${suffix}`, email: `rotation-critical-${suffix}@example.com`, normalizedEmail: `rotation-critical-${suffix}@example.com`, alias: `rotation-critical-${suffix}`, status: "active", dailyLimit: 100 },
      { id: mailboxIds.pendingAddress, workspaceId: session.workspaceId, userId: session.userId, provider: "gmail", composioConnectedAccountId: `rotation-pending-${suffix}`, email: null, normalizedEmail: null, alias: `rotation-pending-${suffix}`, status: "active", dailyLimit: 100 },
      { id: mailboxIds.foreign, workspaceId: otherSession.workspaceId, userId: otherSession.userId, provider: "gmail", composioConnectedAccountId: `rotation-foreign-${suffix}`, email: `rotation-foreign-${suffix}@example.com`, normalizedEmail: `rotation-foreign-${suffix}@example.com`, alias: `rotation-foreign-${suffix}`, status: "active", dailyLimit: 100 },
    ]);
    const usageDate = new Date().toISOString().slice(0, 10);
    await db.insert(schema.mailboxDailyUsage).values([
      { workspaceId: session.workspaceId, emailAccountId: mailboxIds.high, usageDate, acceptedCount: 6 },
      { workspaceId: session.workspaceId, emailAccountId: mailboxIds.low, usageDate, acceptedCount: 8 },
    ]);
    await db.insert(schema.mailboxHealth).values([
      { id: randomUUID(), workspaceId: session.workspaceId, emailAccountId: mailboxIds.unhealthy, state: "auth_error", effectiveDailyLimit: 100 },
      { id: randomUUID(), workspaceId: session.workspaceId, emailAccountId: mailboxIds.critical, state: "critical", effectiveDailyLimit: 100 },
    ]);
  });

  afterAll(async () => {
    await app?.close();
    if (session) {
      await db.delete(schema.workspaces).where(eq(schema.workspaces.id, session.workspaceId));
      await db.delete(schema.users).where(eq(schema.users.id, session.userId));
    }
    if (otherSession) {
      await db.delete(schema.workspaces).where(eq(schema.workspaces.id, otherSession.workspaceId));
      await db.delete(schema.users).where(eq(schema.users.id, otherSession.userId));
    }
    await pool.end();
  });

  it("rotates across all healthy inboxes by default and stores every assignment", async () => {
    const sequenceId = await createPublishedSequence("Default rotation");
    const leadIds = await createContacts(2, "default");
    const response = await app.inject({ method: "POST", headers: { cookie: session.cookie }, url: `/v1/sequences/${sequenceId}/enroll`, payload: { leadIds } });
    expect(response.statusCode).toBe(200);
    expect(response.json().enrolled).toBe(2);

    const enrollments = await db.select({ emailAccountId: schema.enrollments.emailAccountId }).from(schema.enrollments).where(eq(schema.enrollments.sequenceId, sequenceId));
    expect(enrollments).toHaveLength(2);
    expect(enrollments.every((enrollment) => enrollment.emailAccountId !== null)).toBe(true);
    expect(new Set(enrollments.map((enrollment) => enrollment.emailAccountId))).toEqual(new Set([mailboxIds.high, mailboxIds.low]));
  });

  it("rejects inboxes from another workspace without enrolling leads", async () => {
    const sequenceId = await createPublishedSequence("Cross-workspace rotation");
    const leadIds = await createContacts(2, "cross-workspace");
    const response = await app.inject({ method: "POST", headers: { cookie: session.cookie }, url: `/v1/sequences/${sequenceId}/enroll`, payload: { leadIds, inboxIds: [mailboxIds.high, mailboxIds.foreign] } });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("BAD_INPUT");

    const enrollments = await db.select({ id: schema.enrollments.id }).from(schema.enrollments).where(eq(schema.enrollments.sequenceId, sequenceId));
    expect(enrollments).toHaveLength(0);
  });

  it("distributes leads by remaining capacity and stores the assigned inbox", async () => {
    const sequenceId = await createPublishedSequence("Capacity rotation");
    const leadIds = await createContacts(6, "capacity");
    const response = await app.inject({ method: "POST", headers: { cookie: session.cookie }, url: `/v1/sequences/${sequenceId}/enroll`, payload: { leadIds, inboxIds: [mailboxIds.high, mailboxIds.low] } });
    expect(response.statusCode).toBe(200);
    expect(response.json().enrolled).toBe(6);

    const enrollments = await db.select({ id: schema.enrollments.id, emailAccountId: schema.enrollments.emailAccountId }).from(schema.enrollments).where(eq(schema.enrollments.sequenceId, sequenceId));
    expect(enrollments.filter((enrollment) => enrollment.emailAccountId === mailboxIds.high)).toHaveLength(4);
    expect(enrollments.filter((enrollment) => enrollment.emailAccountId === mailboxIds.low)).toHaveLength(2);
    const messages = await db.select({ enrollmentId: schema.messages.enrollmentId, emailAccountId: schema.messages.emailAccountId }).from(schema.messages).where(inArray(schema.messages.enrollmentId, enrollments.map((enrollment) => enrollment.id)));
    const messageMailboxByEnrollment = new Map(messages.map((message) => [message.enrollmentId, message.emailAccountId]));
    expect(enrollments.every((enrollment) => enrollment.emailAccountId && messageMailboxByEnrollment.get(enrollment.id) === enrollment.emailAccountId)).toBe(true);
  });

  it("never assigns a mailbox with auth_error health", async () => {
    const sequenceId = await createPublishedSequence("Healthy rotation");
    const leadIds = await createContacts(3, "healthy");
    const response = await app.inject({ method: "POST", headers: { cookie: session.cookie }, url: `/v1/sequences/${sequenceId}/enroll`, payload: { leadIds, inboxId: mailboxIds.low, inboxIds: [mailboxIds.unhealthy, mailboxIds.high] } });
    expect(response.statusCode).toBe(200);
    const enrollments = await db.select({ emailAccountId: schema.enrollments.emailAccountId }).from(schema.enrollments).where(eq(schema.enrollments.sequenceId, sequenceId));
    expect(enrollments).toHaveLength(3);
    expect(enrollments.every((enrollment) => enrollment.emailAccountId === mailboxIds.high)).toBe(true);
  });

  it("never assigns critical or address-pending inboxes even when requested", async () => {
    const sequenceId = await createPublishedSequence("Unavailable rotation candidates");
    const leadIds = await createContacts(3, "unavailable");
    const response = await app.inject({ method: "POST", headers: { cookie: session.cookie }, url: `/v1/sequences/${sequenceId}/enroll`, payload: { leadIds, inboxIds: [mailboxIds.critical, mailboxIds.pendingAddress, mailboxIds.high] } });
    expect(response.statusCode).toBe(200);
    const enrollments = await db.select({ emailAccountId: schema.enrollments.emailAccountId }).from(schema.enrollments).where(eq(schema.enrollments.sequenceId, sequenceId));
    expect(enrollments).toHaveLength(3);
    expect(enrollments.every((enrollment) => enrollment.emailAccountId === mailboxIds.high)).toBe(true);
  });

  it("keeps single inboxId enrollment pinned for backward compatibility", async () => {
    const sequenceId = await createPublishedSequence("Pinned sender");
    const leadIds = await createContacts(3, "pinned");
    const response = await app.inject({ method: "POST", headers: { cookie: session.cookie }, url: `/v1/sequences/${sequenceId}/enroll`, payload: { leadIds, inboxId: mailboxIds.low } });
    expect(response.statusCode).toBe(200);
    const enrollments = await db.select({ emailAccountId: schema.enrollments.emailAccountId }).from(schema.enrollments).where(eq(schema.enrollments.sequenceId, sequenceId));
    expect(enrollments).toHaveLength(3);
    expect(enrollments.every((enrollment) => enrollment.emailAccountId === mailboxIds.low)).toBe(true);
  });

  it("rotates through SMTP and preserves an SMTP conversation sender when selection changes", async () => {
    await db.insert(schema.emailAccounts).values({
      id: mailboxIds.smtp, workspaceId: session.workspaceId, userId: session.userId, provider: "smtp",
      composioConnectedAccountId: `smtp:${mailboxIds.smtp}`, email: `rotation-smtp-${suffix}@example.com`,
      normalizedEmail: `rotation-smtp-${suffix}@example.com`, alias: `rotation-smtp-${suffix}`, status: "active", dailyLimit: 4,
    });
    const sequenceId = await createPublishedSequence("SMTP rotation");
    const leadIds = await createContacts(4, "smtp-rotation");
    const response = await app.inject({ method: "POST", headers: { cookie: session.cookie }, url: `/v1/sequences/${sequenceId}/enroll`, payload: { leadIds, inboxIds: [mailboxIds.high, mailboxIds.smtp] } });
    expect(response.statusCode).toBe(200);
    expect(response.json().enrolled).toBe(4);

    const enrollments = await db.select({ id: schema.enrollments.id, emailAccountId: schema.enrollments.emailAccountId }).from(schema.enrollments).where(eq(schema.enrollments.sequenceId, sequenceId));
    expect(enrollments.filter((enrollment) => enrollment.emailAccountId === mailboxIds.high)).toHaveLength(2);
    const smtpEnrollments = enrollments.filter((enrollment) => enrollment.emailAccountId === mailboxIds.smtp);
    expect(smtpEnrollments).toHaveLength(2);
    const messages = await db.select({ id: schema.messages.id, enrollmentId: schema.messages.enrollmentId, emailAccountId: schema.messages.emailAccountId }).from(schema.messages).where(inArray(schema.messages.enrollmentId, enrollments.map((enrollment) => enrollment.id)));
    const mailboxByEnrollment = new Map(enrollments.map((enrollment) => [enrollment.id, enrollment.emailAccountId]));
    expect(messages).toHaveLength(4);
    expect(messages.every((message) => message.emailAccountId === mailboxByEnrollment.get(message.enrollmentId))).toBe(true);
    const pinnedEnrollmentId = smtpEnrollments[0]!.id;
    const pinnedMessage = messages.find((message) => message.enrollmentId === pinnedEnrollmentId)!;
    const internetMessageId = `<${pinnedMessage.id}@messages.inboxjoy.online>`;
    await db.update(schema.messages).set({ status: "accepted", acceptedAt: new Date(), internetMessageId, providerMessageId: internetMessageId, providerThreadId: internetMessageId }).where(eq(schema.messages.id, pinnedMessage.id));

    const changed = await app.inject({ method: "PUT", headers: { cookie: session.cookie }, url: `/v1/sequences/${sequenceId}/mailboxes`, payload: { mailboxIds: [mailboxIds.high] } });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().reassigned).toBe(1);
    const updatedEnrollments = await db.select({ id: schema.enrollments.id, emailAccountId: schema.enrollments.emailAccountId }).from(schema.enrollments).where(eq(schema.enrollments.sequenceId, sequenceId));
    expect(updatedEnrollments.find((enrollment) => enrollment.id === pinnedEnrollmentId)?.emailAccountId).toBe(mailboxIds.smtp);
    expect(updatedEnrollments.filter((enrollment) => enrollment.id !== pinnedEnrollmentId).every((enrollment) => enrollment.emailAccountId === mailboxIds.high)).toBe(true);
    const [storedMessage] = await db.select().from(schema.messages).where(eq(schema.messages.id, pinnedMessage.id));
    expect(storedMessage).toMatchObject({ status: "accepted", emailAccountId: mailboxIds.smtp, internetMessageId, providerMessageId: internetMessageId, providerThreadId: internetMessageId });
    const [waitingMessage] = await db.select({ emailAccountId: schema.messages.emailAccountId }).from(schema.messages).where(eq(schema.messages.enrollmentId, smtpEnrollments[1]!.id));
    expect(waitingMessage?.emailAccountId).toBe(mailboxIds.high);
  });
});
