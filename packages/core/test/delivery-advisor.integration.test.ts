import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { readDeliveryAdvisor, type DeliveryAdvisorFinding } from "../src/delivery/advisor.js";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("delivery advisor read projection", () => {
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);

  let userId: string;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let mailboxId: string;
  let sequenceId: string;
  let versionId: string;
  let stepId: string;

  function findingCodes(findings: DeliveryAdvisorFinding[]): string[] {
    return findings.map((finding) => finding.code);
  }

  async function createMailbox(overrides: Partial<typeof schema.emailAccounts.$inferInsert> = {}) {
    const id = overrides.id ?? randomUUID();
    const email = `${id}@example.com`;
    await db.insert(schema.emailAccounts).values({
      id,
      workspaceId,
      userId,
      provider: "gmail",
      composioConnectedAccountId: id,
      email,
      normalizedEmail: email,
      alias: id,
      status: "active",
      dailyLimit: 20,
      hourlyLimit: 5,
      ...overrides,
    });
    return id;
  }

  async function createCampaign(overrides: Partial<typeof schema.campaigns.$inferInsert> = {}) {
    const id = overrides.id ?? randomUUID();
    await db.insert(schema.campaigns).values({
      id,
      workspaceId,
      sequenceId,
      emailAccountId: mailboxId,
      name: "Advisor test campaign",
      status: "active",
      launchedAt: new Date(),
      createdByUserId: userId,
      ...overrides,
    });
    return id;
  }

  async function createContact() {
    const id = randomUUID();
    const email = `${id}@lead.example.com`;
    await db.insert(schema.contacts).values({ id, workspaceId, email, normalizedEmail: email, status: "active" });
    return id;
  }

  async function createEnrollment(campaignId: string, overrides: Partial<typeof schema.enrollments.$inferInsert> = {}) {
    const id = overrides.id ?? randomUUID();
    const contactId = overrides.contactId ?? await createContact();
    await db.insert(schema.enrollments).values({
      id,
      workspaceId,
      sequenceId,
      sequenceVersionId: versionId,
      campaignId,
      emailAccountId: mailboxId,
      status: "scheduled",
      startedAt: new Date(),
      ...overrides,
      contactId,
    });
    return id;
  }

  async function createMessage(enrollmentId: string, overrides: Partial<typeof schema.messages.$inferInsert> = {}) {
    const id = overrides.id ?? randomUUID();
    const [enrollment] = await db.select({ contactId: schema.enrollments.contactId, emailAccountId: schema.enrollments.emailAccountId }).from(schema.enrollments).where(eq(schema.enrollments.id, enrollmentId));
    await db.insert(schema.messages).values({
      id,
      workspaceId,
      enrollmentId,
      sequenceStepId: stepId,
      emailAccountId: enrollment!.emailAccountId ?? mailboxId,
      contactId: enrollment!.contactId,
      status: "scheduled",
      idempotencyKey: `${enrollmentId}:${id}`,
      scheduledAt: new Date(),
      recipientEmail: "lead@example.com",
      normalizedRecipientEmail: "lead@example.com",
      subject: "Hello",
      bodyHash: "hash",
      ...overrides,
    });
    return id;
  }

  async function activateSubscription(status = "active") {
    await db.insert(schema.subscriptions).values({ id: randomUUID(), workspaceId, status }).onConflictDoUpdate({ target: schema.subscriptions.workspaceId, set: { status } });
  }

  async function manualReplyEvent(eventType: "manual_reply_pending" | "manual_reply_sent" = "manual_reply_pending") {
    await db.insert(schema.messageEvents).values({
      id: randomUUID(),
      workspaceId,
      eventType,
      occurredAt: new Date(),
      metadata: { emailAccountId: mailboxId },
    });
  }

  beforeAll(async () => {
    await pool.query("select 1");
  });

  beforeEach(async () => {
    userId = randomUUID();
    workspaceId = randomUUID();
    otherWorkspaceId = randomUUID();
    sequenceId = randomUUID();
    versionId = randomUUID();
    stepId = randomUUID();
    const email = `${userId}@example.com`;
    await db.insert(schema.authUsers).values({ id: userId, name: "Advisor test", email, emailVerified: true });
    await db.insert(schema.users).values({ id: userId, email, normalizedEmail: email, displayName: "Advisor test" });
    await db.insert(schema.workspaces).values([
      { id: workspaceId, name: "Advisor workspace", slug: workspaceId, createdByUserId: userId },
      { id: otherWorkspaceId, name: "Foreign workspace", slug: otherWorkspaceId, createdByUserId: userId },
    ]);
    await db.insert(schema.memberships).values({ id: randomUUID(), workspaceId, userId, role: "owner", status: "active", joinedAt: new Date() });
    mailboxId = await createMailbox();
    await db.insert(schema.sequences).values({ id: sequenceId, workspaceId, name: "Advisor sequence", status: "active", createdByUserId: userId });
    await db.insert(schema.sequenceVersions).values({ id: versionId, workspaceId, sequenceId, version: 1, status: "active", createdByUserId: userId });
    await db.update(schema.sequences).set({ currentVersionId: versionId }).where(eq(schema.sequences.id, sequenceId));
    await db.insert(schema.sequenceSteps).values({ id: stepId, workspaceId, sequenceVersionId: versionId, stepOrder: 1, delayDays: 0, subject: "Hello", bodyText: "Hello" });
    await activateSubscription();
  });

  afterEach(async () => {
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, otherWorkspaceId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await db.delete(schema.authUsers).where(eq(schema.authUsers.id, userId));
  });

  afterAll(async () => {
    await pool.end();
  });

  it("returns found:false for a campaign outside the authorized workspace", async () => {
    const foreignMailboxId = await createMailbox({ workspaceId: otherWorkspaceId });
    const foreignCampaignId = await createCampaign({ workspaceId: otherWorkspaceId, emailAccountId: foreignMailboxId });
    await expect(readDeliveryAdvisor(db, { edition: "cloud", workspaceId, campaignId: foreignCampaignId })).resolves.toEqual({ found: false });
    // Also the normal not-found case: an id that never existed anywhere.
    await expect(readDeliveryAdvisor(db, { edition: "cloud", workspaceId, campaignId: randomUUID() })).resolves.toEqual({ found: false });
  });

  it("performs no writes to campaigns, enrollments or messages across repeated reads", async () => {
    const campaignId = await createCampaign();
    const enrollmentId = await createEnrollment(campaignId);
    await createMessage(enrollmentId, { scheduledAt: new Date(Date.now() + 3_600_000) });

    const before = {
      campaign: await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId)),
      enrollment: await db.select().from(schema.enrollments).where(eq(schema.enrollments.id, enrollmentId)),
      messages: await db.select().from(schema.messages).where(eq(schema.messages.enrollmentId, enrollmentId)),
    };

    for (let i = 0; i < 3; i += 1) {
      const result = await readDeliveryAdvisor(db, { edition: "cloud", workspaceId, campaignId });
      expect(result.found).toBe(true);
    }

    const after = {
      campaign: await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId)),
      enrollment: await db.select().from(schema.enrollments).where(eq(schema.enrollments.id, enrollmentId)),
      messages: await db.select().from(schema.messages).where(eq(schema.messages.enrollmentId, enrollmentId)),
    };
    expect(after).toEqual(before);
  });

  it("reports a healthy pinned sender, its capacity and the next recorded scheduled message with no blocking findings", async () => {
    const campaignId = await createCampaign();
    const enrollmentId = await createEnrollment(campaignId);
    const scheduledAt = new Date(Date.now() + 3_600_000);
    await createMessage(enrollmentId, { scheduledAt });

    const result = await readDeliveryAdvisor(db, { edition: "cloud", workspaceId, campaignId });
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.status).toBe("ready");
    expect(result.snapshot.senders).toHaveLength(1);
    expect(result.snapshot.senders[0]).toMatchObject({ emailAccountId: mailboxId, pendingEnrollments: 1 });
    expect(result.snapshot.senders[0]!.capacity).toMatchObject({ dailyLimit: 20, hourlyLimit: 5, sentToday: 0, sentLastHour: 0 });
    expect(result.snapshot.nextScheduledAt).toBe(scheduledAt.toISOString());
    expect(result.snapshot.nextScheduledNote).toBeNull();
    expect(findingCodes(result.snapshot.findings)).not.toEqual(expect.arrayContaining(["mailbox_inactive", "payment_required", "kill_switch", "campaign_paused"]));
  });

  it("falls back to the campaign's own selected sender when nothing is pending yet", async () => {
    const campaignId = await createCampaign();
    const result = await readDeliveryAdvisor(db, { edition: "cloud", workspaceId, campaignId });
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.snapshot.senders).toEqual([expect.objectContaining({ emailAccountId: mailboxId, pendingEnrollments: 0 })]);
    expect(result.snapshot.nextScheduledAt).toBeNull();
  });

  it("flags an explicitly failed selected sender without letting an unrelated healthy mailbox mask it", async () => {
    await createMailbox(); // An unrelated healthy mailbox with no pending enrollments.
    await db.update(schema.emailAccounts).set({ status: "expired" }).where(eq(schema.emailAccounts.id, mailboxId));
    const campaignId = await createCampaign();
    const enrollmentId = await createEnrollment(campaignId, { status: "paused", stopReason: "mailbox_auth_expired" });
    await createMessage(enrollmentId, { status: "scheduled" });

    const result = await readDeliveryAdvisor(db, { edition: "cloud", workspaceId, campaignId });
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.snapshot.senders.map((sender) => sender.emailAccountId)).toEqual([mailboxId]);
    expect(result.snapshot.senders[0]!.status).toBe("expired");
    expect(findingCodes(result.snapshot.findings)).toContain("mailbox_inactive");
  });

  it("surfaces a failed sequence-rotation mailbox on a draft campaign even though nothing has been pinned to it yet", async () => {
    const campaignId = await createCampaign({ status: "draft", launchedAt: null });
    const secondMailboxId = await createMailbox();
    const expiredMailboxId = await createMailbox({ status: "expired" });
    // A 3-mailbox saved rotation (campaign's own sender plus two more); one
    // of the other two is expired and has never been used by an enrollment.
    await db.insert(schema.sequenceEmailAccounts).values([
      { sequenceId, emailAccountId: mailboxId, workspaceId },
      { sequenceId, emailAccountId: secondMailboxId, workspaceId },
      { sequenceId, emailAccountId: expiredMailboxId, workspaceId },
    ]);

    const result = await readDeliveryAdvisor(db, { edition: "cloud", workspaceId, campaignId });
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(new Set(result.snapshot.senders.map((sender) => sender.emailAccountId))).toEqual(new Set([mailboxId, secondMailboxId, expiredMailboxId]));
    const expiredSender = result.snapshot.senders.find((sender) => sender.emailAccountId === expiredMailboxId);
    expect(expiredSender?.status).toBe("expired");
    expect(findingCodes(result.snapshot.findings)).toContain("mailbox_inactive");
  });

  it("treats a draft campaign as having no forecast", async () => {
    const campaignId = await createCampaign({ status: "draft", launchedAt: null });
    const result = await readDeliveryAdvisor(db, { edition: "cloud", workspaceId, campaignId });
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.snapshot.nextScheduledAt).toBeNull();
    expect(findingCodes(result.snapshot.findings)).toContain("campaign_draft");
  });

  it("keeps a paused campaign's pending timestamp but notes the pause beside it", async () => {
    const campaignId = await createCampaign({ status: "paused" });
    const enrollmentId = await createEnrollment(campaignId, { status: "paused" });
    const scheduledAt = new Date(Date.now() + 7_200_000);
    await createMessage(enrollmentId, { scheduledAt });

    const result = await readDeliveryAdvisor(db, { edition: "cloud", workspaceId, campaignId });
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.snapshot.nextScheduledAt).toBe(scheduledAt.toISOString());
    expect(result.snapshot.nextScheduledNote).toBe("campaign_paused");
    expect(findingCodes(result.snapshot.findings)).toContain("campaign_paused");
  });

  it("shows no forecast for a finished campaign", async () => {
    const campaignId = await createCampaign({ status: "completed", completedAt: new Date() });
    const result = await readDeliveryAdvisor(db, { edition: "cloud", workspaceId, campaignId });
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.snapshot.nextScheduledAt).toBeNull();
    expect(findingCodes(result.snapshot.findings)).toContain("campaign_finished");
  });

  it("counts accepted, in-flight and unknown-result messages plus manual replies toward capacity, never as zero", async () => {
    const campaignId = await createCampaign();
    const acceptedEnrollment = await createEnrollment(campaignId, { status: "completed" });
    await createMessage(acceptedEnrollment, { status: "accepted", acceptedAt: new Date() });
    const sendingEnrollment = await createEnrollment(campaignId);
    await createMessage(sendingEnrollment, { status: "sending", claimExpiresAt: new Date(Date.now() + 600_000) });
    const unknownEnrollment = await createEnrollment(campaignId);
    await createMessage(unknownEnrollment, { status: "failed", errorClass: "unknown_provider_result" });
    await manualReplyEvent("manual_reply_pending");
    await manualReplyEvent("manual_reply_sent");

    const result = await readDeliveryAdvisor(db, { edition: "cloud", workspaceId, campaignId });
    expect(result.found).toBe(true);
    if (!result.found) return;
    const sender = result.snapshot.senders.find((candidate) => candidate.emailAccountId === mailboxId);
    expect(sender?.capacity?.sentToday).toBe(5);
    expect(sender?.capacity?.remainingToday).toBe(Math.max(0, (sender?.capacity?.warmupDailyLimit ?? 20) - 5));
    expect(result.snapshot.workspaceCapacity?.sentToday).toBe(5);
  });

  async function throttledFindings(throttledUntil: Date | null, now: Date) {
    await db.insert(schema.mailboxHealth).values({ id: randomUUID(), workspaceId, emailAccountId: mailboxId, state: "throttled", throttledUntil });
    const campaignId = await createCampaign();
    const enrollmentId = await createEnrollment(campaignId);
    await createMessage(enrollmentId, { status: "scheduled" });
    const result = await readDeliveryAdvisor(db, { edition: "cloud", workspaceId, campaignId, now });
    expect(result.found).toBe(true);
    if (!result.found) throw new Error("campaign not found");
    return result.snapshot.findings.filter((finding) => finding.severity === "danger").map((finding) => finding.code);
  }

  it("does not report a throttled mailbox as blocking once throttled_until has passed", async () => {
    const now = new Date();
    expect(await throttledFindings(new Date(now.getTime() - 60_000), now)).not.toContain("mailbox_throttled");
  });

  it("does not report a throttled mailbox with no throttle deadline as blocking (canSend allows it)", async () => {
    expect(await throttledFindings(null, new Date())).not.toContain("mailbox_throttled");
  });

  it("still reports a throttled mailbox as blocking while throttled_until is in the future", async () => {
    const now = new Date();
    expect(await throttledFindings(new Date(now.getTime() + 60 * 60_000), now)).toContain("mailbox_throttled");
  });

  it("records a historical blocked reason with its own timestamp, separate from live findings", async () => {
    const campaignId = await createCampaign();
    const enrollmentId = await createEnrollment(campaignId, { status: "cancelled" });
    const blockedAt = new Date("2026-01-01T00:00:00.000Z");
    await createMessage(enrollmentId, { status: "cancelled", blockedReason: "payment_required", updatedAt: blockedAt });

    const result = await readDeliveryAdvisor(db, { edition: "cloud", workspaceId, campaignId });
    expect(result.found).toBe(true);
    if (!result.found) return;
    const recorded = result.snapshot.findings.find((finding) => finding.source === "recorded");
    expect(recorded).toMatchObject({ code: "recorded_payment_required", source: "recorded", observedAt: blockedAt.toISOString() });
  });

  async function planFindings(edition: "cloud" | "selfhost") {
    const campaignId = await createCampaign();
    const result = await readDeliveryAdvisor(db, { edition, workspaceId, campaignId });
    if (!result.found) throw new Error("campaign not found");
    return result.snapshot.findings.filter((finding) => finding.source === "observed" && finding.navigationTarget === "billing");
  }

  it("points an unlicensed cloud workspace at the lifetime license", async () => {
    await db.delete(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, workspaceId));
    const findings = await planFindings("cloud");
    expect(findings).toEqual([expect.objectContaining({ code: "payment_required", severity: "danger" })]);
    expect(findings[0]!.message).toContain("$79 lifetime license");
  });

  it("names the end date of legacy Free, as information while sends are left", async () => {
    await db.delete(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, workspaceId));
    await db.update(schema.workspaces).set({ legacyFreeUntil: new Date(Date.now() + 10 * 86_400_000) }).where(eq(schema.workspaces.id, workspaceId));
    const findings = await planFindings("cloud");
    expect(findings).toEqual([expect.objectContaining({ code: "legacy_free_ending", severity: "info" })]);
    expect(findings[0]!.message).toContain("10,000");
  });

  it("reports no plan finding for an entitled cloud workspace or any self-hosted one", async () => {
    expect(await planFindings("cloud")).toEqual([]);
    await db.delete(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, workspaceId));
    expect(await planFindings("selfhost")).toEqual([]);
  });
});
