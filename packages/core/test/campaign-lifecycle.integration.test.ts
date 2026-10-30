import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { cascadeSuppression, FREE_PLAN_CONTACT_LIMIT, OpError, operationByName, reconcileCampaignStatus, runOperation, type OperationContext } from "../src/index.js";
import { createSendingAnalyticsOperations } from "../src/sending-analytics.js";
import { enrollNewListLeads } from "../src/enroll-new-list-leads.js";
import { reconcileCampaignStatuses } from "../../../apps/worker/src/jobs/reconcile-campaign-statuses.js";

const databaseUrl = process.env.DATABASE_URL;

function operation(name: string) {
  const found = operationByName.get(name);
  if (!found) throw new Error(`Missing operation ${name}`);
  return found;
}

describe.skipIf(!databaseUrl)("campaign lifecycle operations", () => {
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
        authSecret: "campaign-lifecycle-test-auth-secret-at-least-32-chars",
        apiBaseUrl: "https://api.example.test",
      },
    };
  }

  async function createContact(label: string) {
    const contactId = randomUUID();
    const email = `${label}-${randomUUID()}@example.com`;
    await db.insert(schema.contacts).values({
      id: contactId,
      workspaceId,
      email,
      normalizedEmail: email,
      status: "active",
    });
    return contactId;
  }

  async function createList(label: string) {
    const listId = randomUUID();
    await db.insert(schema.contactLists).values({ id: listId, workspaceId, name: `${label} ${randomUUID().slice(0, 8)}`, createdByUserId: userId });
    return listId;
  }

  async function createCampaign(label: string, status: "draft" | "active" | "paused" | "completed" | "archived" = "active") {
    const campaignId = randomUUID();
    await db.insert(schema.campaigns).values({
      id: campaignId,
      workspaceId,
      sequenceId,
      emailAccountId: mailboxId,
      name: label,
      status,
      launchedAt: status === "active" || status === "paused" || status === "completed" ? new Date() : null,
      createdByUserId: userId,
    });
    return campaignId;
  }

  async function createCampaignWithLists(label: string, status: "draft" | "active" | "paused" | "completed" | "archived", listIds: string[]) {
    const campaignId = await createCampaign(label, status);
    await db.update(schema.campaigns).set({ contactListId: listIds[0] ?? null }).where(eq(schema.campaigns.id, campaignId));
    if (listIds.length) await db.insert(schema.campaignContactLists).values(listIds.map((contactListId) => ({ campaignId, contactListId, workspaceId })));
    return campaignId;
  }

  async function addToList(listId: string, contactId: string) {
    await db.insert(schema.contactListMembers).values({ workspaceId, contactListId: listId, contactId });
  }

  async function listExists(listId: string) {
    const rows = await db.select({ id: schema.contactLists.id }).from(schema.contactLists).where(eq(schema.contactLists.id, listId));
    return rows.length === 1;
  }

  async function enrolledContactIds(campaignId: string) {
    const rows = await db.select({ contactId: schema.enrollments.contactId }).from(schema.enrollments).where(eq(schema.enrollments.campaignId, campaignId));
    return rows.map((row) => row.contactId);
  }

  async function finishCampaign(campaignId: string) {
    const contactIds = await enrolledContactIds(campaignId);
    expect(contactIds.length).toBeGreaterThan(0);
    await db.update(schema.enrollments).set({ status: "completed", stoppedAt: new Date(), stopReason: "sequence_completed" }).where(eq(schema.enrollments.campaignId, campaignId));
    await db.update(schema.contacts).set({ status: "active" }).where(and(eq(schema.contacts.workspaceId, workspaceId), inArray(schema.contacts.id, contactIds)));
    await expect(reconcileCampaignStatus(db, { workspaceId, campaignId })).resolves.toMatchObject({ status: "completed", change: "finished" });
  }

  async function createFinishedCampaign(label: string, listIds: string[]) {
    const firstListId = listIds[0];
    if (!firstListId) throw new Error("A finished campaign fixture needs a list.");
    const contactId = await createContact("finished-campaign-seed");
    await addToList(firstListId, contactId);
    const campaignId = await createCampaignWithLists(label, "draft", listIds);
    await expect(runOperation(operation("campaigns.launch"), context(), { id: campaignId })).resolves.toMatchObject({ campaign: { status: "active" }, enrollment: { enrolled: 1 } });
    await finishCampaign(campaignId);
    return { campaignId, contactId };
  }

  async function expectNewLeadsReady(campaignId: string, count: number) {
    await expect(runOperation(operation("campaigns.get"), context(), { id: campaignId })).resolves.toMatchObject({
      newLeadsReady: count,
      campaign: { id: campaignId, newLeadsReady: count },
    });
  }

  async function restartNotifications() {
    return db.select().from(schema.notifications).where(and(eq(schema.notifications.workspaceId, workspaceId), eq(schema.notifications.type, "campaign_restarted")));
  }

  async function enrollCampaign(campaignId: string, contactId: string) {
    await expect(runOperation(operation("sequences.enroll"), context(), { id: sequenceId, leadIds: [contactId], inboxId: mailboxId, campaignId })).resolves.toMatchObject({ enrolled: 1 });
    return enrollmentFor(campaignId);
  }

  async function campaignStatus(campaignId: string) {
    const [campaign] = await db.select({ status: schema.campaigns.status }).from(schema.campaigns).where(eq(schema.campaigns.id, campaignId)).limit(1);
    return campaign?.status;
  }

  async function enrollmentFor(campaignId: string) {
    const [enrollment] = await db.select({ id: schema.enrollments.id, status: schema.enrollments.status, statusBeforePause: schema.enrollments.statusBeforePause, pausedAt: schema.enrollments.pausedAt, nextDueAt: schema.enrollments.nextDueAt, stoppedAt: schema.enrollments.stoppedAt, stopReason: schema.enrollments.stopReason }).from(schema.enrollments).where(and(eq(schema.enrollments.workspaceId, workspaceId), eq(schema.enrollments.campaignId, campaignId))).limit(1);
    if (!enrollment) throw new Error(`Missing enrollment for campaign ${campaignId}`);
    return enrollment;
  }

  async function messageFor(enrollmentId: string) {
    const [message] = await db.select({ status: schema.messages.status, scheduledAt: schema.messages.scheduledAt, blockedReason: schema.messages.blockedReason }).from(schema.messages).where(and(eq(schema.messages.workspaceId, workspaceId), eq(schema.messages.enrollmentId, enrollmentId))).limit(1);
    if (!message) throw new Error(`Missing message for enrollment ${enrollmentId}`);
    return message;
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
    const mailboxEmail = `campaign-mailbox-${suffix}@example.com`;

    await db.insert(schema.authUsers).values({
      id: userId,
      name: "Campaign Test",
      email: `campaign-user-${suffix}@example.com`,
      emailVerified: true,
    });
    await db.insert(schema.users).values({
      id: userId,
      email: `campaign-user-${suffix}@example.com`,
      normalizedEmail: `campaign-user-${suffix}@example.com`,
      displayName: "Campaign Test",
    });
    await db.insert(schema.workspaces).values({
      id: workspaceId,
      name: `Campaign ${suffix}`,
      slug: `campaign-${suffix}`,
      createdByUserId: userId,
      postalAddress: "123 Main St\nAustin, TX 78701",
    });
    await db.insert(schema.memberships).values({ id: randomUUID(), workspaceId, userId, role: "owner", status: "active", joinedAt: new Date() });
    await db.insert(schema.emailAccounts).values({
      id: mailboxId,
      workspaceId,
      userId,
      provider: "gmail",
      composioConnectedAccountId: `campaign-${suffix}`,
      email: mailboxEmail,
      normalizedEmail: mailboxEmail,
      alias: `campaign-${suffix}`,
      status: "active",
    });
    await db.insert(schema.sequences).values({ id: sequenceId, workspaceId, name: "Shared lifecycle sequence", status: "active", createdByUserId: userId });
    await db.insert(schema.sequenceVersions).values({ id: versionId, workspaceId, sequenceId, version: 1, status: "active", snapshot: { description: "Shared lifecycle sequence" }, launchedAt: new Date(), createdByUserId: userId });
    await db.update(schema.sequences).set({ currentVersionId: versionId }).where(eq(schema.sequences.id, sequenceId));
    await db.insert(schema.sequenceSteps).values({ id: stepId, workspaceId, sequenceVersionId: versionId, stepOrder: 1, delayDays: 1, subject: "Hello {{firstName}}", bodyText: "Hello {{firstName}}" });
  });

  afterEach(async () => {
    if (workspaceId) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    if (userId) await db.delete(schema.users).where(eq(schema.users.id, userId));
    if (userId) await db.delete(schema.authUsers).where(eq(schema.authUsers.id, userId));
  });

  afterAll(async () => {
    await pool.end();
  });

  it.each([
    { status: "completed", reason: "sequence_completed" },
    { status: "bounced", reason: "hard_bounce" },
    { status: "replied", reason: "reply_detected" },
    { status: "unsubscribed", reason: "unsubscribe" },
    { status: "cancelled", reason: "provider_not_sent" },
  ] as const)("finishes when the final enrollment becomes $status", async ({ status, reason }) => {
    const campaignId = await createCampaign(`Finish ${status}`);
    const contactId = await createContact(`finish-${status}`);
    const enrollment = await enrollCampaign(campaignId, contactId);
    const now = new Date("2026-10-02T10:00:00.000Z");
    await db.transaction(async (tx) => {
      await tx.update(schema.enrollments).set({ status, stopReason: reason, stoppedAt: now, nextDueAt: null }).where(eq(schema.enrollments.id, enrollment.id));
      expect(await reconcileCampaignStatus(tx, { workspaceId, campaignId, now })).toMatchObject({ status: "completed", change: "finished", previousCompletedAt: null });
    });
    expect(await reconcileCampaignStatus(db, { workspaceId, campaignId, now })).toMatchObject({ change: null });
    const [campaign] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
    expect(campaign?.completedAt).toEqual(now);
    const notifications = await db.select().from(schema.notifications).where(and(eq(schema.notifications.workspaceId, workspaceId), eq(schema.notifications.type, "campaign_completed")));
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ title: `Campaign completed: Finish ${status}`, body: `Campaign ${campaignId} has finished all eligible enrollments.` });
    expect(await runOperation(operation("campaigns.get"), context(), { id: campaignId })).toMatchObject({ campaign: { status: "completed", displayStatus: "finished", statusReason: null, completedAt: now.toISOString() } });
  });

  it("finishes every campaign stopped by suppression even without pending messages", async () => {
    const contactId = await createContact("suppression-finishes");
    const campaignId = await createCampaign("Suppressed campaign");
    const enrollment = await enrollCampaign(campaignId, contactId);
    await db.delete(schema.messages).where(eq(schema.messages.enrollmentId, enrollment.id));
    const otherSequenceId = randomUUID();
    const otherVersionId = randomUUID();
    const otherCampaignId = randomUUID();
    await db.insert(schema.sequences).values({ id: otherSequenceId, workspaceId, name: "Other suppression sequence", status: "active" });
    await db.insert(schema.sequenceVersions).values({ id: otherVersionId, workspaceId, sequenceId: otherSequenceId, version: 1 });
    await db.insert(schema.campaigns).values({ id: otherCampaignId, workspaceId, sequenceId: otherSequenceId, emailAccountId: mailboxId, name: "Other suppressed campaign", status: "paused", launchedAt: new Date() });
    await db.insert(schema.enrollments).values({ id: randomUUID(), workspaceId, campaignId: otherCampaignId, sequenceId: otherSequenceId, sequenceVersionId: otherVersionId, contactId, emailAccountId: mailboxId, status: "paused" });
    await db.transaction((tx) => cascadeSuppression(tx, { workspaceId, contactId, reason: "manual_suppression" }));
    expect(await campaignStatus(campaignId)).toBe("completed");
    expect(await campaignStatus(otherCampaignId)).toBe("paused");
  });

  it.each(["draft", "archived"] as const)("keeps a %s campaign unchanged after a late reply", async (status) => {
    const campaignId = await createCampaign("Late reply", "active");
    const enrollment = await enrollCampaign(campaignId, await createContact("late-reply"));
    await db.update(schema.campaigns).set({ status }).where(eq(schema.campaigns.id, campaignId));
    await db.update(schema.enrollments).set({ status: "replied", stoppedAt: new Date() }).where(eq(schema.enrollments.id, enrollment.id));
    expect(await reconcileCampaignStatus(db, { workspaceId, campaignId })).toMatchObject({ status, change: null });
    expect(await campaignStatus(campaignId)).toBe(status);
    expect(await db.select().from(schema.notifications).where(and(eq(schema.notifications.workspaceId, workspaceId), eq(schema.notifications.type, "campaign_completed")))).toHaveLength(0);
  });

  it("never finishes an unlaunched active campaign", async () => {
    const campaignId = await createCampaign("Never launched");
    await db.update(schema.campaigns).set({ launchedAt: null }).where(eq(schema.campaigns.id, campaignId));
    expect(await reconcileCampaignStatus(db, { workspaceId, campaignId })).toMatchObject({ status: "active", change: null });
  });

  it("records every finish while retaining the previous finish timestamp for email throttling", async () => {
    const campaignId = await createCampaign("Repeated finish");
    const enrollment = await enrollCampaign(campaignId, await createContact("repeated-finish"));
    const firstFinish = new Date("2026-10-02T08:00:00.000Z");
    const secondFinish = new Date("2026-10-02T09:00:00.000Z");
    await db.update(schema.enrollments).set({ status: "completed" }).where(eq(schema.enrollments.id, enrollment.id));
    await reconcileCampaignStatus(db, { workspaceId, campaignId, now: firstFinish });
    await db.update(schema.enrollments).set({ status: "scheduled" }).where(eq(schema.enrollments.id, enrollment.id));
    await reconcileCampaignStatus(db, { workspaceId, campaignId, allowRestart: true });
    await db.update(schema.enrollments).set({ status: "completed" }).where(eq(schema.enrollments.id, enrollment.id));
    expect(await reconcileCampaignStatus(db, { workspaceId, campaignId, now: secondFinish })).toMatchObject({ change: "finished", previousCompletedAt: firstFinish });
    const notifications = await db.select().from(schema.notifications).where(and(eq(schema.notifications.workspaceId, workspaceId), eq(schema.notifications.type, "campaign_completed")));
    expect(notifications).toHaveLength(2);
  });

  it("keeps a paused campaign paused when its final lead replies until resumed", async () => {
    const campaignId = await createCampaign("Paused reply");
    const enrollment = await enrollCampaign(campaignId, await createContact("paused-reply"));
    await db.update(schema.campaigns).set({ status: "paused" }).where(eq(schema.campaigns.id, campaignId));
    await db.update(schema.enrollments).set({ status: "replied" }).where(eq(schema.enrollments.id, enrollment.id));
    expect(await reconcileCampaignStatus(db, { workspaceId, campaignId })).toMatchObject({ status: "paused", change: null });
    const listId = await createList("Paused final reply");
    await db.insert(schema.campaignContactLists).values({ workspaceId, campaignId, contactListId: listId });
    await expect(runOperation(operation("lists.addLeads"), context(), { id: listId, leadIds: [await createContact("paused-new-lead")] })).resolves.toMatchObject({ campaignUpdates: [{ enrolled: 0, blockedReason: "campaign_paused" }] });
    await reconcileCampaignStatuses({ pool });
    expect(await campaignStatus(campaignId)).toBe("paused");
    await expect(runOperation(operation("campaigns.resume"), context(), { id: campaignId })).resolves.toMatchObject({ campaign: { status: "completed", displayStatus: "finished" } });
  });

  it("converges to active when the last enrollment finishes concurrently with list additions", async () => {
    const listId = await createList("Concurrent finish audience");
    const firstContactId = await createContact("concurrent-first");
    await addToList(listId, firstContactId);
    const campaignId = await createCampaignWithLists("Concurrent finish", "draft", [listId]);
    await runOperation(operation("campaigns.launch"), context(), { id: campaignId });
    const newContactId = await createContact("concurrent-new");
    const finishClient = await pool.connect();
    const addClient = await pool.connect();
    try {
      await Promise.all([
        createDb(finishClient as unknown as Parameters<typeof createDb>[0]).transaction(async (tx) => {
          await tx.select({ id: schema.campaigns.id }).from(schema.campaigns).where(eq(schema.campaigns.id, campaignId)).for("update");
          await tx.update(schema.enrollments).set({ status: "completed", stoppedAt: new Date() }).where(and(eq(schema.enrollments.campaignId, campaignId), eq(schema.enrollments.contactId, firstContactId)));
          await tx.update(schema.contacts).set({ status: "active" }).where(eq(schema.contacts.id, firstContactId));
          await reconcileCampaignStatus(tx, { workspaceId, campaignId });
        }),
        runOperation(operation("lists.addLeads"), { ...context(), db: createDb(addClient as unknown as Parameters<typeof createDb>[0]) }, { id: listId, leadIds: [newContactId] }),
      ]);
    } finally {
      finishClient.release();
      addClient.release();
    }
    expect(await campaignStatus(campaignId)).toBe("active");
    const enrollments = await db.select().from(schema.enrollments).where(eq(schema.enrollments.campaignId, campaignId));
    expect(enrollments).toHaveLength(2);
    expect(enrollments.find((enrollment) => enrollment.contactId === firstContactId)?.status).toBe("completed");
    expect(enrollments.find((enrollment) => enrollment.contactId === newContactId)?.status).toBe("scheduled");
    const [beforeSweep] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
    await reconcileCampaignStatuses({ pool });
    expect((await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId)))[0]).toEqual(beforeSweep);
  });

  it("attaches direct enrollments to the sole non-archived campaign and honors its pause", async () => {
    const campaignId = await createCampaign("Direct finished campaign", "completed");
    await createCampaign("Archived sibling", "archived");
    await expect(runOperation(operation("sequences.enroll"), context(), { id: sequenceId, leadIds: [await createContact("direct-enrollment")], inboxId: mailboxId })).resolves.toMatchObject({ enrolled: 1, restarted: true });
    expect(await campaignStatus(campaignId)).toBe("active");
    expect(await enrolledContactIds(campaignId)).toHaveLength(1);
    await runOperation(operation("campaigns.pause"), context(), { id: campaignId });
    await expect(runOperation(operation("sequences.enroll"), context(), { id: sequenceId, leadIds: [await createContact("direct-paused")], inboxId: mailboxId })).rejects.toMatchObject({ message: "Resume the campaign before enrolling more leads." });
  });

  it.each([0, 2])("leaves direct enrollments campaign-less with %s candidate campaigns", async (campaignCount) => {
    for (let index = 0; index < campaignCount; index += 1) await createCampaign(`Ambiguous campaign ${index}`, "completed");
    const contactId = await createContact("campaign-less-enrollment");
    await expect(runOperation(operation("sequences.enroll"), context(), { id: sequenceId, leadIds: [contactId], inboxId: mailboxId })).resolves.toMatchObject({ enrolled: 1, restarted: false });
    const [enrollment] = await db.select().from(schema.enrollments).where(eq(schema.enrollments.contactId, contactId));
    expect(enrollment?.campaignId).toBeNull();
  });

  it("leaves direct enrollments campaign-less when the sole campaign is an unlaunched draft", async () => {
    const campaignId = await createCampaign("Unlaunched draft", "draft");
    const contactId = await createContact("draft-campaign-enrollment");
    await expect(runOperation(operation("sequences.enroll"), context(), { id: sequenceId, leadIds: [contactId], inboxId: mailboxId })).resolves.toMatchObject({ enrolled: 1, restarted: false });
    const [enrollment] = await db.select().from(schema.enrollments).where(eq(schema.enrollments.contactId, contactId));
    expect(enrollment?.campaignId).toBeNull();
    expect(await campaignStatus(campaignId)).toBe("draft");
  });

  it.each([{ withDraftCampaign: true }, { withDraftCampaign: false }])("reads a sequence-level run from its own enrollments, finished once every lead has ended (draft campaign: $withDraftCampaign)", async ({ withDraftCampaign }) => {
    const draftCampaignId = withDraftCampaign ? await createCampaign("Never launched", "draft") : null;
    const listedSequence = async () => (await runOperation(operation("sequences.list"), context(), {})).sequences.find((item: { id: string }) => item.id === sequenceId);
    // Nothing enrolled yet: the row keeps the status it always had.
    if (withDraftCampaign) expect((await listedSequence()).displayStatus).toBe("draft");
    expect((await listedSequence()).displayStatus).not.toBe("finished");

    const firstId = await createContact("sequence-run-first");
    const secondId = await createContact("sequence-run-second");
    await expect(runOperation(operation("sequences.enroll"), context(), { id: sequenceId, leadIds: [firstId, secondId], inboxId: mailboxId })).resolves.toMatchObject({ enrolled: 2 });
    const direct = await db.select({ campaignId: schema.enrollments.campaignId }).from(schema.enrollments).where(eq(schema.enrollments.sequenceId, sequenceId));
    expect(direct.map((row) => row.campaignId)).toEqual([null, null]);
    expect(["active", "needs_attention"]).toContain((await listedSequence()).displayStatus);

    await db.update(schema.enrollments).set({ status: "completed", stoppedAt: new Date("2026-10-04T09:00:00.000Z") }).where(and(eq(schema.enrollments.sequenceId, sequenceId), eq(schema.enrollments.contactId, firstId)));
    expect(["active", "needs_attention"]).toContain((await listedSequence()).displayStatus);
    await db.update(schema.enrollments).set({ status: "paused" }).where(and(eq(schema.enrollments.sequenceId, sequenceId), eq(schema.enrollments.contactId, secondId)));
    expect((await listedSequence()).displayStatus).not.toBe("finished");

    const lastStoppedAt = new Date("2026-10-05T09:00:00.000Z");
    await db.update(schema.enrollments).set({ status: "replied", stoppedAt: lastStoppedAt }).where(and(eq(schema.enrollments.sequenceId, sequenceId), eq(schema.enrollments.contactId, secondId)));
    expect(await listedSequence()).toMatchObject({ displayStatus: "finished", statusReason: null, completedAt: lastStoppedAt.toISOString(), status: "published" });
    if (draftCampaignId) expect(await campaignStatus(draftCampaignId)).toBe("draft");
  });

  it("keeps a paused sequence-level run reading as paused", async () => {
    await createCampaign("Never launched", "draft");
    await runOperation(operation("sequences.enroll"), context(), { id: sequenceId, leadIds: [await createContact("sequence-run-paused")], inboxId: mailboxId });
    await runOperation(operation("sequences.pause"), context(), { id: sequenceId });
    const listed = (await runOperation(operation("sequences.list"), context(), {})).sequences.find((item: { id: string }) => item.id === sequenceId);
    expect(listed).toMatchObject({ displayStatus: "paused", completedAt: null });
  });

  it("agrees between sequences.list and sequences.get on displayStatus/statusReason/completedAt (zero enrollments, in-progress, then finished)", async () => {
    const listedSequence = async () => (await runOperation(operation("sequences.list"), context(), {})).sequences.find((item: { id: string }) => item.id === sequenceId);
    const gotSequence = () => runOperation(operation("sequences.get"), context(), { id: sequenceId });
    const expectAgreement = async () => {
      const [listed, got] = await Promise.all([listedSequence(), gotSequence()]);
      const pick = (sequence: { displayStatus: unknown; statusReason: unknown; completedAt: unknown }) => ({ displayStatus: sequence.displayStatus, statusReason: sequence.statusReason, completedAt: sequence.completedAt });
      expect(pick(got)).toEqual(pick(listed));
      return listed as { displayStatus: string; statusReason: string | null; completedAt: string | null };
    };

    // (c) published, zero enrollments: never finished, and both operations agree.
    let listed = await expectAgreement();
    expect(listed.displayStatus).not.toBe("finished");

    // (b) published, one lead still in progress: still not finished.
    const firstId = await createContact("agreement-first");
    const secondId = await createContact("agreement-second");
    await expect(runOperation(operation("sequences.enroll"), context(), { id: sequenceId, leadIds: [firstId, secondId], inboxId: mailboxId })).resolves.toMatchObject({ enrolled: 2 });
    listed = await expectAgreement();
    expect(["active", "needs_attention"]).toContain(listed.displayStatus);
    expect(listed.completedAt).toBeNull();
    await db.update(schema.enrollments).set({ status: "completed", stoppedAt: new Date("2026-10-06T08:00:00.000Z") }).where(and(eq(schema.enrollments.sequenceId, sequenceId), eq(schema.enrollments.contactId, firstId)));
    listed = await expectAgreement();
    expect(listed.displayStatus).not.toBe("finished");

    // (a) every enrollment has ended: both report finished with the same completedAt.
    const lastStoppedAt = new Date("2026-10-06T09:00:00.000Z");
    await db.update(schema.enrollments).set({ status: "replied", stoppedAt: lastStoppedAt }).where(and(eq(schema.enrollments.sequenceId, sequenceId), eq(schema.enrollments.contactId, secondId)));
    listed = await expectAgreement();
    expect(listed).toMatchObject({ displayStatus: "finished", statusReason: null, completedAt: lastStoppedAt.toISOString() });
  });

  it("agrees between sequences.list and sequences.get for a paused sequence-level run", async () => {
    await runOperation(operation("sequences.enroll"), context(), { id: sequenceId, leadIds: [await createContact("agreement-paused")], inboxId: mailboxId });
    await runOperation(operation("sequences.pause"), context(), { id: sequenceId });
    const listed = (await runOperation(operation("sequences.list"), context(), {})).sequences.find((item: { id: string }) => item.id === sequenceId);
    const got = await runOperation(operation("sequences.get"), context(), { id: sequenceId });
    expect(got).toMatchObject({ displayStatus: listed.displayStatus, statusReason: listed.statusReason, completedAt: listed.completedAt });
    expect(listed).toMatchObject({ displayStatus: "paused", completedAt: null });
  });

  it("resumes a paused sequence on launch so its paused leads are restored alongside the new ones", async () => {
    const listId = await createList("Paused sequence relaunch");
    const firstId = await createContact("paused-sequence-first");
    await addToList(listId, firstId);
    const campaignId = await createCampaignWithLists("Paused sequence relaunch", "draft", [listId]);
    await runOperation(operation("campaigns.launch"), context(), { id: campaignId });
    await runOperation(operation("sequences.pause"), context(), { id: sequenceId });
    const secondId = await createContact("paused-sequence-second");
    await addToList(listId, secondId);

    await expect(runOperation(operation("campaigns.launch"), context(), { id: campaignId })).resolves.toMatchObject({ campaign: { status: "active" }, enrollment: { enrolled: 1, leadIds: [secondId] } });

    const rows = await db.select({ contactId: schema.enrollments.contactId, status: schema.enrollments.status, pausedAt: schema.enrollments.pausedAt }).from(schema.enrollments).where(eq(schema.enrollments.campaignId, campaignId));
    expect(new Set(rows.map((row) => `${row.contactId}:${row.status}`))).toEqual(new Set([`${firstId}:scheduled`, `${secondId}:scheduled`]));
    expect(rows.every((row) => row.pausedAt === null)).toBe(true);
    const [sequence] = await db.select({ status: schema.sequences.status }).from(schema.sequences).where(eq(schema.sequences.id, sequenceId));
    expect(sequence?.status).toBe("active");
  });

  it("archives a published sequence once nothing is scheduled or sending, and refuses while leads are in progress", async () => {
    const listId = await createList("Archive finished");
    const { campaignId } = await createFinishedCampaign("Archive finished campaign", [listId]);
    const busyCampaignId = await createCampaign("Archive busy sibling");
    await enrollCampaign(busyCampaignId, await createContact("archive-busy"));
    await expect(runOperation(operation("sequences.archive"), context(), { id: sequenceId })).rejects.toMatchObject({ message: "Pause this campaign before archiving it." });
    await db.update(schema.enrollments).set({ status: "completed", stoppedAt: new Date() }).where(eq(schema.enrollments.campaignId, busyCampaignId));

    await runOperation(operation("sequences.archive"), context(), { id: sequenceId });

    const [sequence] = await db.select({ status: schema.sequences.status }).from(schema.sequences).where(eq(schema.sequences.id, sequenceId));
    expect(sequence?.status).toBe("archived");
    expect(await campaignStatus(campaignId)).toBe("completed");
    await expect(runOperation(operation("lists.addLeads"), context(), { id: listId, leadIds: [await createContact("archived-new-lead")] })).resolves.toMatchObject({ added: 1, campaignUpdates: [{ campaignId, enrolled: 0, blockedReason: "sequence_inactive" }] });
  });

  it("resumes repeated-provider-failure pauses while preserving other system pauses", async () => {
    const campaignId = await createCampaign("Provider failure resume");
    const failed = await enrollCampaign(campaignId, await createContact("provider-paused"));
    const authContactId = await createContact("auth-paused");
    const unknownContactId = await createContact("unknown-paused");
    await runOperation(operation("sequences.enroll"), context(), { id: sequenceId, leadIds: [authContactId, unknownContactId], inboxId: mailboxId, campaignId });
    const pausedAt = new Date(Date.now() - 1000);
    await db.update(schema.sequences).set({ status: "paused", pausedAt }).where(eq(schema.sequences.id, sequenceId));
    await db.update(schema.enrollments).set({ status: "paused", statusBeforePause: "scheduled", pausedAt, stopReason: "repeated_provider_failure" }).where(eq(schema.enrollments.id, failed.id));
    await db.update(schema.enrollments).set({ status: "paused", statusBeforePause: "scheduled", pausedAt, stopReason: "mailbox_auth_expired" }).where(eq(schema.enrollments.contactId, authContactId));
    await db.update(schema.enrollments).set({ status: "paused", statusBeforePause: "scheduled", pausedAt, stopReason: "provider_result_unknown" }).where(eq(schema.enrollments.contactId, unknownContactId));
    await expect(runOperation(operation("campaigns.get"), context(), { id: campaignId })).resolves.toMatchObject({ campaign: { displayStatus: "needs_attention", statusReason: "sequence_paused" } });
    await runOperation(operation("sequences.resume"), context(), { id: sequenceId });
    const [resumed] = await db.select().from(schema.enrollments).where(eq(schema.enrollments.id, failed.id));
    expect(resumed).toMatchObject({ status: "scheduled", stopReason: null, pausedAt: null });
    const others = await db.select().from(schema.enrollments).where(inArray(schema.enrollments.contactId, [authContactId, unknownContactId]));
    expect(others.every((enrollment) => enrollment.status === "paused" && enrollment.stopReason !== null)).toBe(true);
  });

  it.each(["scheduled", "active", "paused"] as const)("restarts once when a %s enrollment appears, preserving the last finish", async (status) => {
    const campaignId = await createCampaign("Restart campaign");
    const enrollment = await enrollCampaign(campaignId, await createContact("restart-lead"));
    const completedAt = new Date("2026-10-01T09:00:00.000Z");
    await db.update(schema.campaigns).set({ status: "completed", completedAt }).where(eq(schema.campaigns.id, campaignId));
    await db.update(schema.enrollments).set({ status }).where(eq(schema.enrollments.id, enrollment.id));
    // Terminal events and the sweep never restart: leftover in-progress rows stay dormant.
    expect(await reconcileCampaignStatus(db, { workspaceId, campaignId })).toMatchObject({ status: "completed", change: null });
    await reconcileCampaignStatuses({ pool });
    expect(await campaignStatus(campaignId)).toBe("completed");
    const results = await Promise.all([
      reconcileCampaignStatus(db, { workspaceId, campaignId, allowRestart: true }),
      reconcileCampaignStatus(db, { workspaceId, campaignId, allowRestart: true }),
    ]);
    expect(results.filter((result) => result?.change === "restarted")).toHaveLength(1);
    const [campaign] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
    expect(campaign).toMatchObject({ status: "active", completedAt });
    const notifications = await db.select().from(schema.notifications).where(and(eq(schema.notifications.workspaceId, workspaceId), eq(schema.notifications.type, "campaign_restarted")));
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ title: "Campaign restarted: Restart campaign", body: "1 lead is in progress in this campaign." });
  });

  it("makes no change for a campaign owned by another workspace", async () => {
    const campaignId = await createCampaign("Tenant isolated");
    const otherWorkspaceId = randomUUID();
    await db.insert(schema.workspaces).values({ id: otherWorkspaceId, name: "Other workspace", slug: `other-${otherWorkspaceId}` });
    try {
      expect(await reconcileCampaignStatus(db, { workspaceId: otherWorkspaceId, campaignId })).toBeNull();
      expect(await campaignStatus(campaignId)).toBe("active");
      expect(await db.select().from(schema.notifications).where(eq(schema.notifications.workspaceId, otherWorkspaceId))).toHaveLength(0);
    } finally {
      await db.delete(schema.workspaces).where(eq(schema.workspaces.id, otherWorkspaceId));
    }
  });

  it("pauses one campaign without pausing another campaign on the same sequence", async () => {
    const firstCampaignId = await createCampaign("First campaign");
    const secondCampaignId = await createCampaign("Second campaign");
    await enrollCampaign(firstCampaignId, await createContact("first-pause"));
    await enrollCampaign(secondCampaignId, await createContact("second-pause"));

    await runOperation(operation("campaigns.pause"), context(), { id: firstCampaignId });

    expect(await campaignStatus(firstCampaignId)).toBe("paused");
    expect(await campaignStatus(secondCampaignId)).toBe("active");
    await expect(enrollmentFor(firstCampaignId)).resolves.toMatchObject({ status: "paused", statusBeforePause: "scheduled" });
    await expect(enrollmentFor(secondCampaignId)).resolves.toMatchObject({ status: "scheduled", statusBeforePause: null, pausedAt: null });
  });

  it("launch resumes only the paused campaign enrollments instead of stranding them", async () => {
    const firstCampaignId = await createCampaign("Launch paused campaign");
    const secondCampaignId = await createCampaign("Other paused campaign");
    const firstEnrollment = await enrollCampaign(firstCampaignId, await createContact("first-launch"));
    await enrollCampaign(secondCampaignId, await createContact("second-launch"));
    const firstMessageBefore = await messageFor(firstEnrollment.id);

    await runOperation(operation("campaigns.pause"), context(), { id: firstCampaignId });
    await runOperation(operation("campaigns.pause"), context(), { id: secondCampaignId });
    await db.update(schema.enrollments).set({ pausedAt: new Date(Date.now() - 60 * 60_000) }).where(eq(schema.enrollments.id, firstEnrollment.id));

    await runOperation(operation("campaigns.launch"), context(), { id: firstCampaignId });

    const firstEnrollmentAfter = await enrollmentFor(firstCampaignId);
    const secondEnrollmentAfter = await enrollmentFor(secondCampaignId);
    const firstMessageAfter = await messageFor(firstEnrollment.id);
    expect(await campaignStatus(firstCampaignId)).toBe("active");
    expect(await campaignStatus(secondCampaignId)).toBe("paused");
    expect(firstEnrollmentAfter).toMatchObject({ status: "scheduled", statusBeforePause: null, pausedAt: null });
    expect(secondEnrollmentAfter.status).toBe("paused");
    // A pause no longer pushes email later: the waiting first email keeps its time.
    expect(firstMessageAfter.scheduledAt.getTime()).toBe(firstMessageBefore.scheduledAt.getTime());
  });

  it("rejects edits to active and archived campaigns", async () => {
    const activeId = await createCampaign("Active immutable campaign", "active");
    const archivedId = await createCampaign("Archived immutable campaign", "archived");
    await expect(runOperation(operation("campaigns.update"), context(), { id: activeId, name: "Changed" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(runOperation(operation("campaigns.update"), context(), { id: archivedId, name: "Changed" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("creates campaigns with multiple lists while preserving legacy listId behavior", async () => {
    const firstListId = await createList("First audience");
    const secondListId = await createList("Second audience");

    const created = await runOperation(operation("campaigns.create"), context(), {
      name: "Multi-list campaign",
      sequenceId,
      listIds: [firstListId, secondListId, firstListId],
      inboxId: mailboxId,
    });

    expect(created.campaign).toMatchObject({ listIds: [firstListId, secondListId], listId: firstListId, contactListId: firstListId });
    await expect(db.select({ contactListId: schema.campaignContactLists.contactListId }).from(schema.campaignContactLists).where(eq(schema.campaignContactLists.campaignId, created.campaign.id))).resolves.toHaveLength(2);

    const legacy = await runOperation(operation("campaigns.create"), context(), {
      name: "Legacy campaign",
      sequenceId,
      listId: secondListId,
      inboxId: mailboxId,
    });
    expect(legacy.campaign).toMatchObject({ listIds: [secondListId], listId: secondListId, contactListId: secondListId });
    await expect(runOperation(operation("campaigns.create"), context(), {
      name: "Ambiguous campaign",
      sequenceId,
      listIds: [firstListId],
      listId: secondListId,
      inboxId: mailboxId,
    })).rejects.toMatchObject({ code: "BAD_INPUT" });
  });

  it("rejects a campaign list from another workspace", async () => {
    const foreignWorkspaceId = randomUUID();
    const foreignListId = randomUUID();
    await db.insert(schema.workspaces).values({ id: foreignWorkspaceId, name: "Foreign campaign workspace", slug: `foreign-campaign-${randomUUID().slice(0, 8)}`, createdByUserId: userId });
    await db.insert(schema.contactLists).values({ id: foreignListId, workspaceId: foreignWorkspaceId, name: "Foreign audience", createdByUserId: userId });
    try {
      await expect(runOperation(operation("campaigns.create"), context(), {
        name: "Cross-workspace audience",
        sequenceId,
        listIds: [foreignListId],
        inboxId: mailboxId,
      })).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally {
      await db.delete(schema.workspaces).where(eq(schema.workspaces.id, foreignWorkspaceId));
    }
  });

  it("atomically replaces a draft campaign list set", async () => {
    const firstListId = await createList("Replace first");
    const secondListId = await createList("Replace second");
    const thirdListId = await createList("Replace third");
    const created = await runOperation(operation("campaigns.create"), context(), { name: "Replace audience", sequenceId, listIds: [firstListId, secondListId], inboxId: mailboxId });

    const updated = await runOperation(operation("campaigns.update"), context(), { id: created.campaign.id, listIds: [secondListId, thirdListId] });

    expect(updated.campaign).toMatchObject({ listIds: [secondListId, thirdListId], listId: secondListId, contactListId: secondListId });
    const rows = await db.select({ contactListId: schema.campaignContactLists.contactListId }).from(schema.campaignContactLists).where(eq(schema.campaignContactLists.campaignId, created.campaign.id));
    expect(new Set(rows.map((row) => row.contactListId))).toEqual(new Set([secondListId, thirdListId]));
  });

  it("launches the distinct union of contacts across selected lists", async () => {
    const firstListId = await createList("Union first");
    const secondListId = await createList("Union second");
    const firstOnlyId = await createContact("union-first");
    const sharedId = await createContact("union-shared");
    const secondOnlyId = await createContact("union-second");
    await db.insert(schema.contactListMembers).values([
      { workspaceId, contactListId: firstListId, contactId: firstOnlyId },
      { workspaceId, contactListId: firstListId, contactId: sharedId },
      { workspaceId, contactListId: secondListId, contactId: sharedId },
      { workspaceId, contactListId: secondListId, contactId: secondOnlyId },
    ]);
    const created = await runOperation(operation("campaigns.create"), context(), { name: "Union audience", sequenceId, listIds: [firstListId, secondListId], inboxId: mailboxId });

    const launched = await runOperation(operation("campaigns.launch"), context(), { id: created.campaign.id });

    expect(launched.enrollment.enrolled).toBe(3);
    const enrollments = await db.select({ contactId: schema.enrollments.contactId }).from(schema.enrollments).where(eq(schema.enrollments.campaignId, created.campaign.id));
    expect(enrollments).toHaveLength(3);
    expect(new Set(enrollments.map((row) => row.contactId))).toEqual(new Set([firstOnlyId, sharedId, secondOnlyId]));
  });

  it("blocks deleting a campaign audience so launch cannot expand from a lost list to all ready leads", async () => {
    const selectedListId = await createList("Protected audience");
    const selectedLeadId = await createContact("selected-audience");
    const unrelatedLeadId = await createContact("outside-audience");
    await db.insert(schema.contactListMembers).values({ workspaceId, contactListId: selectedListId, contactId: selectedLeadId });
    const created = await runOperation(operation("campaigns.create"), context(), { name: "Protected audience campaign", sequenceId, listIds: [selectedListId], inboxId: mailboxId });

    await expect(runOperation(operation("lists.delete"), context(), { id: selectedListId })).rejects.toMatchObject({ code: "CONFLICT" });
    await runOperation(operation("campaigns.launch"), context(), { id: created.campaign.id });

    const enrollments = await db.select({ contactId: schema.enrollments.contactId }).from(schema.enrollments).where(eq(schema.enrollments.campaignId, created.campaign.id));
    expect(enrollments.map((row) => row.contactId)).toEqual([selectedLeadId]);
    expect(enrollments.some((row) => row.contactId === unrelatedLeadId)).toBe(false);
  });

  it("allows deleting a list after every campaign that used it is archived", async () => {
    const listId = await createList("Archived audience");
    const created = await runOperation(operation("campaigns.create"), context(), { name: "Archived audience campaign", sequenceId, listIds: [listId], inboxId: mailboxId });
    await runOperation(operation("campaigns.archive"), context(), { id: created.campaign.id });
    await expect(runOperation(operation("lists.delete"), context(), { id: listId })).resolves.toMatchObject({ deleted: 1 });
  });

  it.each(["draft", "active", "paused"] as const)("keeps the last list of a %s campaign and deletes nothing", async (status) => {
    const listId = await createList("Sole audience");
    const memberId = await createContact("sole-audience");
    await addToList(listId, memberId);
    const campaignId = await createCampaignWithLists(`Sole audience ${status}`, status, [listId]);

    await expect(runOperation(operation("lists.delete"), context(), { id: listId })).rejects.toMatchObject({
      code: "CONFLICT",
      message: `This list is the only audience for the ${status} campaign "Sole audience ${status}". Add another list to that campaign or archive it, then delete this list.`,
    });

    expect(await listExists(listId)).toBe(true);
    await expect(db.select({ contactId: schema.contactListMembers.contactId }).from(schema.contactListMembers).where(eq(schema.contactListMembers.contactListId, listId))).resolves.toEqual([{ contactId: memberId }]);
    const detail = await runOperation(operation("campaigns.get"), context(), { id: campaignId });
    expect(detail.campaign).toMatchObject({ listIds: [listId], listId, contactListId: listId });
  });

  it("deletes one of several campaign lists and the campaign keeps only the remaining list", async () => {
    const removedListId = await createList("Removed audience");
    const keptListId = await createList("Kept audience");
    const removedOnlyId = await createContact("removed-only");
    const keptId = await createContact("kept");
    await createContact("outside-both");
    await addToList(removedListId, removedOnlyId);
    await addToList(keptListId, keptId);
    const campaignId = await createCampaignWithLists("Two audience campaign", "draft", [removedListId, keptListId]);

    await expect(runOperation(operation("lists.delete"), context(), { id: removedListId })).resolves.toMatchObject({ deleted: 1 });

    expect(await listExists(removedListId)).toBe(false);
    const detail = await runOperation(operation("campaigns.get"), context(), { id: campaignId });
    expect(detail.campaign).toMatchObject({ listIds: [keptListId], listId: keptListId, contactListId: keptListId });
    await runOperation(operation("campaigns.launch"), context(), { id: campaignId });
    expect(await enrolledContactIds(campaignId)).toEqual([keptId]);
  });

  it("deletes the last list of a completed campaign, which then needs a list to relaunch", async () => {
    const listId = await createList("Finished audience");
    await addToList(listId, await createContact("finished-audience"));
    const readyLeadId = await createContact("ready-outside-finished");
    const campaignId = await createCampaignWithLists("Finished campaign", "completed", [listId]);

    await expect(runOperation(operation("lists.delete"), context(), { id: listId })).resolves.toMatchObject({ deleted: 1 });
    expect(await listExists(listId)).toBe(false);

    await expect(runOperation(operation("campaigns.launch"), context(), { id: campaignId })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Relaunching a finished campaign needs a contact list. Create a new campaign and choose its contact list.",
    });
    expect(await campaignStatus(campaignId)).toBe("completed");
    expect(await enrolledContactIds(campaignId)).toEqual([]);
    await expect(db.select({ status: schema.contacts.status }).from(schema.contacts).where(eq(schema.contacts.id, readyLeadId))).resolves.toEqual([{ status: "active" }]);
  });

  it("deletes the last list of a campaign whose sequence is archived, and that campaign stays unable to enroll", async () => {
    const listId = await createList("Archived sequence audience");
    await addToList(listId, await createContact("archived-sequence-audience"));
    await createContact("ready-outside-archived-sequence");
    const campaignId = await createCampaignWithLists("Archived sequence campaign", "draft", [listId]);
    await runOperation(operation("sequences.pause"), context(), { id: sequenceId });
    await runOperation(operation("sequences.archive"), context(), { id: sequenceId });
    expect(await campaignStatus(campaignId)).toBe("draft");

    await expect(runOperation(operation("lists.delete"), context(), { id: listId })).resolves.toMatchObject({ deleted: 1 });

    await expect(runOperation(operation("campaigns.launch"), context(), { id: campaignId })).rejects.toMatchObject({ code: "CONFLICT", message: "Archived sequences cannot be published." });
    await expect(runOperation(operation("sequences.enroll"), context(), { id: sequenceId, leadIds: [await createContact("direct-enroll")], inboxId: mailboxId, campaignId })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await enrolledContactIds(campaignId)).toEqual([]);

    const liveSequence = await runOperation(operation("sequences.create"), context(), { name: "Live sequence", steps: [{ delayDays: 0, subject: "Hello", body: "Hello" }] });
    await expect(runOperation(operation("campaigns.update"), context(), { id: campaignId, sequenceId: liveSequence.sequence.id })).rejects.toMatchObject({ code: "CONFLICT" });
    const [unmoved] = await db.select({ sequenceId: schema.campaigns.sequenceId }).from(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
    expect(unmoved?.sequenceId).toBe(sequenceId);
    const keptListId = await createList("Chosen audience");
    await expect(runOperation(operation("campaigns.update"), context(), { id: campaignId, sequenceId: liveSequence.sequence.id, listIds: [keptListId] })).resolves.toMatchObject({ campaign: { sequenceId: liveSequence.sequence.id, listIds: [keptListId] } });
  });

  it("relaunching a completed campaign reactivates it and enrolls only new contacts from its list", async () => {
    const listId = await createList("Relaunch audience");
    const firstId = await createContact("relaunch-first");
    await addToList(listId, firstId);
    const campaignId = await createCampaignWithLists("Relaunch campaign", "draft", [listId]);
    await expect(runOperation(operation("campaigns.launch"), context(), { id: campaignId })).resolves.toMatchObject({ campaign: { status: "active" }, enrollment: { enrolled: 1 } });
    // The worker marks a campaign completed when its last enrollment finishes.
    await db.update(schema.enrollments).set({ status: "completed", stoppedAt: new Date() }).where(eq(schema.enrollments.campaignId, campaignId));
    const completedAt = new Date("2026-10-01T09:00:00.000Z");
    await db.update(schema.campaigns).set({ status: "completed", completedAt }).where(eq(schema.campaigns.id, campaignId));
    const secondId = await createContact("relaunch-second");
    await addToList(listId, secondId);
    const outsideId = await createContact("relaunch-outside");

    const relaunched = await runOperation(operation("campaigns.launch"), context(), { id: campaignId });

    expect(relaunched).toMatchObject({ campaign: { id: campaignId, status: "active", listIds: [listId] }, enrollment: { enrolled: 1, leadIds: [secondId] } });
    expect(await campaignStatus(campaignId)).toBe("active");
    const rows = await db.select({ contactId: schema.enrollments.contactId, status: schema.enrollments.status }).from(schema.enrollments).where(eq(schema.enrollments.campaignId, campaignId));
    expect(new Set(rows.map((row) => `${row.contactId}:${row.status}`))).toEqual(new Set([`${firstId}:completed`, `${secondId}:scheduled`]));
    expect(rows.some((row) => row.contactId === outsideId)).toBe(false);
    expect(relaunched.campaign.completedAt).toBe(completedAt.toISOString());
    const notifications = await db.select().from(schema.notifications).where(and(eq(schema.notifications.workspaceId, workspaceId), eq(schema.notifications.type, "campaign_restarted")));
    expect(notifications).toHaveLength(1);
  });

  it("previews the distinct eligible audience with the same suppression and enrollment rules", async () => {
    const firstListId = await createList("Preview first");
    const secondListId = await createList("Preview second");
    const eligibleId = await createContact("preview-eligible");
    const suppressedId = await createContact("preview-suppressed");
    const enrolledId = await createContact("preview-enrolled");
    const repliedId = await createContact("preview-replied");
    await db.update(schema.contacts).set({ email: "suppressed@example.com", normalizedEmail: "suppressed@example.com" }).where(eq(schema.contacts.id, suppressedId));
    await db.insert(schema.suppressions).values({ id: randomUUID(), workspaceId, email: "suppressed@example.com", normalizedEmail: "suppressed@example.com", emailHash: randomUUID(), reason: "unsubscribed", source: "test" });
    await db.update(schema.contacts).set({ status: "replied" }).where(eq(schema.contacts.id, repliedId));
    await db.insert(schema.contactListMembers).values([
      { workspaceId, contactListId: firstListId, contactId: eligibleId },
      { workspaceId, contactListId: firstListId, contactId: enrolledId },
      { workspaceId, contactListId: firstListId, contactId: suppressedId },
      { workspaceId, contactListId: secondListId, contactId: eligibleId },
      { workspaceId, contactListId: secondListId, contactId: repliedId },
    ]);
    await enrollCampaign(await createCampaign("Preview existing enrollment"), enrolledId);

    await expect(runOperation(operation("campaigns.audiencePreview"), context(), { sequenceId, listIds: [firstListId, secondListId] })).resolves.toMatchObject({
      eligible: 1,
      total: 4,
      skipped: { suppressed: 1, already_enrolled: 1, replied: 1, bounced: 0, unsubscribed: 0 },
    });
  });

  it("keeps a zero-enrollment draft editable and launches the same campaign after leads become eligible", async () => {
    const campaignId = await createCampaign("Retryable zero-enrollment campaign", "draft");

    const firstLaunch = await runOperation(operation("campaigns.launch"), context(), { id: campaignId });
    expect(firstLaunch).toMatchObject({ campaign: { id: campaignId, status: "draft", launchedAt: null }, enrollment: { enrolled: 0 } });
    expect(await campaignStatus(campaignId)).toBe("draft");

    const contactId = await createContact("retryable-launch");
    const update = await runOperation(operation("campaigns.update"), context(), { id: campaignId, name: "Updated retryable campaign", sequenceId, inboxId: mailboxId, listId: null });
    expect(update).toMatchObject({ campaign: { id: campaignId, name: "Updated retryable campaign", contactListId: null, emailAccountId: mailboxId } });

    const retry = await runOperation(operation("campaigns.launch"), context(), { id: campaignId });
    expect(retry).toMatchObject({ campaign: { id: campaignId, status: "active" }, enrollment: { enrolled: 1 } });
    expect(await campaignStatus(campaignId)).toBe("active");
    await expect(enrollmentFor(campaignId)).resolves.toMatchObject({ status: "scheduled" });
    expect(contactId).toBeTruthy();
  });

  it("blocks launch until the workspace owner verifies their email", async () => {
    const campaignId = await createCampaign("Verification gate", "draft");
    await createContact("verification-gate");
    await db.update(schema.authUsers).set({ emailVerified: false }).where(eq(schema.authUsers.id, userId));

    await expect(runOperation(operation("campaigns.launch"), context(), { id: campaignId })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Verify your email address before sending. Check your inbox for the verification link.",
      details: { code: "email_unverified" },
    });

    await db.update(schema.authUsers).set({ emailVerified: true }).where(eq(schema.authUsers.id, userId));
    await expect(runOperation(operation("campaigns.launch"), context(), { id: campaignId })).resolves.toMatchObject({
      campaign: { id: campaignId, status: "active" },
    });
  });

  it("archives one campaign without archiving the shared sequence or sibling campaign", async () => {
    const archivedCampaignId = await createCampaign("Archive campaign");
    const siblingCampaignId = await createCampaign("Sibling campaign");
    const archivedEnrollment = await enrollCampaign(archivedCampaignId, await createContact("archive"));
    const siblingEnrollment = await enrollCampaign(siblingCampaignId, await createContact("sibling"));

    await runOperation(operation("campaigns.archive"), context(), { id: archivedCampaignId });

    const [sequence] = await db.select({ status: schema.sequences.status }).from(schema.sequences).where(eq(schema.sequences.id, sequenceId)).limit(1);
    expect(sequence?.status).toBe("active");
    expect(await campaignStatus(archivedCampaignId)).toBe("archived");
    expect(await campaignStatus(siblingCampaignId)).toBe("active");
    await expect(enrollmentFor(archivedCampaignId)).resolves.toMatchObject({ status: "cancelled", stopReason: "campaign_archived" });
    await expect(messageFor(archivedEnrollment.id)).resolves.toMatchObject({ status: "cancelled", blockedReason: "campaign_archived" });
    await expect(enrollmentFor(siblingCampaignId)).resolves.toMatchObject({ status: "scheduled", stoppedAt: null, stopReason: null });
    await expect(messageFor(siblingEnrollment.id)).resolves.toMatchObject({ status: "scheduled", blockedReason: null });
    await expect(runOperation(operation("campaigns.launch"), context(), { id: archivedCampaignId })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(runOperation(operation("campaigns.pause"), context(), { id: archivedCampaignId })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it.each(["draft", "completed"] as const)("does not overwrite an archive that completes after enrollment but before launch activation of a %s campaign", async (status) => {
    const listId = await createList("Launch archive interleaving");
    const contactId = await createContact("launch-archive-interleaving");
    await addToList(listId, contactId);
    const campaignId = await createCampaignWithLists("Launch archive interleaving", status, [listId]);
    const customOperations = createSendingAnalyticsOperations(async (name, opContext, input) => {
      const target = operation(name);
      const result = await runOperation(target, opContext, input);
      if (name === "sequences.enroll") await runOperation(operation("campaigns.archive"), context(), { id: campaignId });
      return result;
    }, OpError, async () => {}, async () => {});
    const launchOperation = customOperations.find((item) => item.name === "campaigns.launch");
    if (!launchOperation) throw new Error("Missing campaigns.launch operation");

    await runOperation(launchOperation, context(), { id: campaignId });

    expect(await campaignStatus(campaignId)).toBe("archived");
    const rows = await db.select({ status: schema.enrollments.status, contactId: schema.enrollments.contactId }).from(schema.enrollments).where(eq(schema.enrollments.campaignId, campaignId));
    expect(rows).toEqual([{ status: "cancelled", contactId }]);
  });

  it("serializes a concurrent launch and archive without leaving live enrollments", async () => {
    const campaignId = await createCampaign("Concurrent lifecycle campaign", "draft");
    const contactId = await createContact("concurrent-lifecycle");

    const results = await Promise.allSettled([
      runOperation(operation("campaigns.launch"), context(), { id: campaignId }),
      runOperation(operation("campaigns.archive"), context(), { id: campaignId }),
    ]);

    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    expect(await campaignStatus(campaignId)).toBe("archived");
    const rows = await db.select({ status: schema.enrollments.status, contactId: schema.enrollments.contactId }).from(schema.enrollments).where(eq(schema.enrollments.campaignId, campaignId));
    expect(rows.every((row) => row.status === "cancelled")).toBe(true);
    expect(rows.every((row) => row.contactId === contactId)).toBe(true);
  });

  it("auto-restarts a finished campaign once across successive new list-member batches", async () => {
    const listId = await createList("Automatic restart audience");
    const { campaignId, contactId: finishedId } = await createFinishedCampaign("Automatic restart campaign", [listId]);
    const firstId = await createContact("automatic-restart-first");
    const secondId = await createContact("automatic-restart-second");

    await expect(runOperation(operation("lists.addLeads"), context(), { id: listId, leadIds: [firstId] })).resolves.toMatchObject({
      added: 1,
      campaignUpdates: [{ campaignId, enrolled: 1, restarted: true, blockedReason: null }],
    });
    expect(await campaignStatus(campaignId)).toBe("active");
    expect(await restartNotifications()).toHaveLength(1);
    await expect(runOperation(operation("lists.addLeads"), context(), { id: listId, leadIds: [secondId] })).resolves.toMatchObject({
      added: 1,
      campaignUpdates: [{ campaignId, enrolled: 1, restarted: false, blockedReason: null }],
    });

    expect(await restartNotifications()).toHaveLength(1);
    expect(new Set(await enrolledContactIds(campaignId))).toEqual(new Set([finishedId, firstId, secondId]));
    await expectNewLeadsReady(campaignId, 0);
  });

  it("auto-enrolls a new member into an active campaign without reporting a restart", async () => {
    const listId = await createList("Active automatic audience");
    const firstId = await createContact("active-automatic-first");
    await addToList(listId, firstId);
    const campaignId = await createCampaignWithLists("Active automatic campaign", "draft", [listId]);
    await runOperation(operation("campaigns.launch"), context(), { id: campaignId });
    const newId = await createContact("active-automatic-new");

    await expect(runOperation(operation("lists.addLeads"), context(), { id: listId, leadIds: [newId] })).resolves.toMatchObject({
      added: 1,
      campaignUpdates: [{ campaignId, enrolled: 1, restarted: false, blockedReason: null }],
    });

    expect(await campaignStatus(campaignId)).toBe("active");
    expect(new Set(await enrolledContactIds(campaignId))).toEqual(new Set([firstId, newId]));
    expect(await restartNotifications()).toHaveLength(0);
    await expectNewLeadsReady(campaignId, 0);
  });

  it("leaves a newly added lead waiting while paused and enrolls it on launch", async () => {
    const listId = await createList("Paused automatic audience");
    const firstId = await createContact("paused-automatic-first");
    await addToList(listId, firstId);
    const campaignId = await createCampaignWithLists("Paused automatic campaign", "draft", [listId]);
    await runOperation(operation("campaigns.launch"), context(), { id: campaignId });
    await runOperation(operation("campaigns.pause"), context(), { id: campaignId });
    const waitingId = await createContact("paused-automatic-waiting");

    await expect(runOperation(operation("lists.addLeads"), context(), { id: listId, leadIds: [waitingId] })).resolves.toMatchObject({
      added: 1,
      campaignUpdates: [{ campaignId, enrolled: 0, restarted: false, blockedReason: "campaign_paused" }],
    });
    expect(await campaignStatus(campaignId)).toBe("paused");
    expect(await enrolledContactIds(campaignId)).toEqual([firstId]);
    await expectNewLeadsReady(campaignId, 1);

    await expect(runOperation(operation("campaigns.launch"), context(), { id: campaignId })).resolves.toMatchObject({
      campaign: { status: "active" },
      enrollment: { enrolled: 1, leadIds: [waitingId] },
    });
    expect(new Set(await enrolledContactIds(campaignId))).toEqual(new Set([firstId, waitingId]));
    expect(await restartNotifications()).toHaveLength(0);
    await expectNewLeadsReady(campaignId, 0);
  });

  it.each(["draft", "archived"] as const)("omits a %s campaign from automatic list enrollment and reports no waiting leads", async (status) => {
    const listId = await createList("Ignored automatic audience");
    const campaignId = await createCampaignWithLists("Ignored automatic campaign", "draft", [listId]);
    if (status === "archived") await runOperation(operation("campaigns.archive"), context(), { id: campaignId });
    const contactId = await createContact("ignored-automatic-lead");

    await expect(runOperation(operation("lists.addLeads"), context(), { id: listId, leadIds: [contactId] })).resolves.toMatchObject({ added: 1, campaignUpdates: [] });

    expect(await campaignStatus(campaignId)).toBe(status);
    expect(await enrolledContactIds(campaignId)).toHaveLength(0);
    expect(await restartNotifications()).toHaveLength(0);
    await expectNewLeadsReady(campaignId, 0);
  });

  it.each(["active", "completed"] as const)("omits an unlinked %s campaign from automatic enrollment and reports no waiting leads", async (status) => {
    const campaignId = await createCampaign("Zero-list automatic campaign", "draft");
    await createContact("zero-list-automatic-seed");
    await runOperation(operation("campaigns.launch"), context(), { id: campaignId });
    if (status === "completed") await finishCampaign(campaignId);
    const enrolledBefore = await enrolledContactIds(campaignId);
    const listId = await createList("Unlinked automatic audience");
    const contactId = await createContact("unlinked-automatic-lead");

    await expect(runOperation(operation("lists.addLeads"), context(), { id: listId, leadIds: [contactId] })).resolves.toMatchObject({ added: 1, campaignUpdates: [] });

    expect(await campaignStatus(campaignId)).toBe(status);
    expect(await enrolledContactIds(campaignId)).toEqual(enrolledBefore);
    expect(await restartNotifications()).toHaveLength(0);
    await expectNewLeadsReady(campaignId, 0);
  });

  it.each(["suppressed", "bounced", "replied", "unsubscribed"] as const)("keeps a campaign finished when its new member is %s", async (status) => {
    const listId = await createList("Ineligible automatic audience");
    const { campaignId, contactId: finishedId } = await createFinishedCampaign("Ineligible automatic campaign", [listId]);
    const contactId = await createContact("ineligible-automatic-lead");
    await db.update(schema.contacts).set({ status }).where(eq(schema.contacts.id, contactId));

    await expect(runOperation(operation("lists.addLeads"), context(), { id: listId, leadIds: [contactId] })).resolves.toMatchObject({
      added: 1,
      campaignUpdates: [{ campaignId, enrolled: 0, restarted: false, blockedReason: null }],
    });

    expect(await campaignStatus(campaignId)).toBe("completed");
    expect(await enrolledContactIds(campaignId)).toEqual([finishedId]);
    expect(await restartNotifications()).toHaveLength(0);
    await expectNewLeadsReady(campaignId, 0);
  });

  it("honors an email suppression even when the newly added contact is active", async () => {
    const listId = await createList("Suppression automatic audience");
    const { campaignId, contactId: finishedId } = await createFinishedCampaign("Suppression automatic campaign", [listId]);
    const contactId = await createContact("suppressed-email-automatic");
    const [contact] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId));
    if (!contact) throw new Error("Missing suppression test contact.");
    await db.insert(schema.suppressions).values({ id: randomUUID(), workspaceId, email: contact.email, normalizedEmail: contact.normalizedEmail, emailHash: randomUUID(), reason: "manual", source: "test" });

    await expect(runOperation(operation("lists.addLeads"), context(), { id: listId, leadIds: [contactId] })).resolves.toMatchObject({
      added: 1,
      campaignUpdates: [{ campaignId, enrolled: 0, restarted: false, blockedReason: null }],
    });

    expect(await campaignStatus(campaignId)).toBe("completed");
    expect(await enrolledContactIds(campaignId)).toEqual([finishedId]);
    expect(await restartNotifications()).toHaveLength(0);
    await expectNewLeadsReady(campaignId, 0);
  });

  it("does not enroll an existing membership when it is re-added", async () => {
    const listId = await createList("Repeated automatic membership");
    const { campaignId } = await createFinishedCampaign("Repeated automatic campaign", [listId]);
    const waitingId = await createContact("existing-unenrolled-member");
    await addToList(listId, waitingId);
    const enrolledBefore = await enrolledContactIds(campaignId);
    await expectNewLeadsReady(campaignId, 1);

    await expect(runOperation(operation("lists.addLeads"), context(), { id: listId, leadIds: [waitingId, waitingId] })).resolves.toMatchObject({ added: 0 });

    expect(await campaignStatus(campaignId)).toBe("completed");
    expect(await enrolledContactIds(campaignId)).toEqual(enrolledBefore);
    expect(await restartNotifications()).toHaveLength(0);
    await expectNewLeadsReady(campaignId, 1);
  });

  it("auto-enrolls only the new member without sweeping older unenrolled list members", async () => {
    const listId = await createList("Only inserted automatic members");
    const { campaignId, contactId: finishedId } = await createFinishedCampaign("Only inserted automatic campaign", [listId]);
    const oldId = await createContact("older-unenrolled-list-member");
    await addToList(listId, oldId);
    const newId = await createContact("newly-inserted-list-member");

    await expect(runOperation(operation("lists.addLeads"), context(), { id: listId, leadIds: [oldId, newId] })).resolves.toMatchObject({
      added: 1,
      campaignUpdates: [{ campaignId, enrolled: 1, restarted: true, blockedReason: null }],
    });

    expect(new Set(await enrolledContactIds(campaignId))).toEqual(new Set([finishedId, newId]));
    await expectNewLeadsReady(campaignId, 1);
  });

  it("does not re-enroll a finished list A lead when it joins list B of the same campaign", async () => {
    const firstListId = await createList("Finished list A");
    const secondListId = await createList("Finished list B");
    const { campaignId, contactId } = await createFinishedCampaign("Cross-list duplicate campaign", [firstListId, secondListId]);

    await expect(runOperation(operation("lists.addLeads"), context(), { id: secondListId, leadIds: [contactId] })).resolves.toMatchObject({
      added: 1,
      campaignUpdates: [{ campaignId, enrolled: 0, restarted: false, blockedReason: null }],
    });

    expect(await campaignStatus(campaignId)).toBe("completed");
    expect(await enrolledContactIds(campaignId)).toEqual([contactId]);
    expect(await restartNotifications()).toHaveLength(0);
    await expectNewLeadsReady(campaignId, 0);
  });

  it("relaunches a finished campaign on a new sequence version without re-enrolling past leads", async () => {
    const listId = await createList("Edited finished audience");
    const { campaignId, contactId } = await createFinishedCampaign("Edited finished campaign", [listId]);
    const nextVersionId = randomUUID();
    await db.insert(schema.sequenceVersions).values({ id: nextVersionId, workspaceId, sequenceId, version: 2, status: "active", snapshot: { description: "Edited finished sequence" }, launchedAt: new Date(), createdByUserId: userId });
    await db.insert(schema.sequenceSteps).values({ id: randomUUID(), workspaceId, sequenceVersionId: nextVersionId, stepOrder: 1, delayDays: 1, subject: "Edited hello", bodyText: "Edited hello" });
    await db.update(schema.sequences).set({ currentVersionId: nextVersionId }).where(eq(schema.sequences.id, sequenceId));
    await expectNewLeadsReady(campaignId, 0);

    await expect(runOperation(operation("campaigns.launch"), context(), { id: campaignId })).resolves.toMatchObject({
      campaign: { status: "completed" },
      enrollment: { enrolled: 0, skipped: { already_enrolled: 1 } },
    });

    expect(await campaignStatus(campaignId)).toBe("completed");
    expect(await enrolledContactIds(campaignId)).toEqual([contactId]);
    const versions = await db.select({ sequenceVersionId: schema.enrollments.sequenceVersionId }).from(schema.enrollments).where(eq(schema.enrollments.campaignId, campaignId));
    expect(versions).toEqual([{ sequenceVersionId: versionId }]);
    expect(await restartNotifications()).toHaveLength(0);
    await expectNewLeadsReady(campaignId, 0);
  });

  it("excludes legacy campaign-less enrollments across versions from relaunch, auto-enroll and newLeadsReady", async () => {
    const firstListId = await createList("Legacy v1 audience");
    const secondListId = await createList("Legacy v2 audience");
    const contactId = await createContact("legacy-v1-lead");
    await addToList(firstListId, contactId);
    await runOperation(operation("sequences.enroll"), context(), { id: sequenceId, leadIds: [contactId], inboxId: mailboxId });
    await db.update(schema.enrollments).set({ status: "completed", stoppedAt: new Date() }).where(eq(schema.enrollments.contactId, contactId));
    await db.update(schema.contacts).set({ status: "active" }).where(eq(schema.contacts.id, contactId));
    const nextVersionId = randomUUID();
    await db.insert(schema.sequenceVersions).values({ id: nextVersionId, workspaceId, sequenceId, version: 2, status: "active", snapshot: { lastSuccessfulTestSendAt: new Date().toISOString() } });
    await db.insert(schema.sequenceSteps).values({ id: randomUUID(), workspaceId, sequenceVersionId: nextVersionId, stepOrder: 1, delayDays: 0, subject: "V2 subject", bodyText: "V2 body" });
    await db.update(schema.sequences).set({ currentVersionId: nextVersionId }).where(eq(schema.sequences.id, sequenceId));
    const campaignId = await createCampaignWithLists("Legacy relaunch campaign", "completed", [firstListId, secondListId]);
    await expectNewLeadsReady(campaignId, 0);
    await expect(runOperation(operation("campaigns.launch"), context(), { id: campaignId })).resolves.toMatchObject({ campaign: { status: "completed" }, enrollment: { enrolled: 0, skipped: { already_enrolled: 1 } } });
    await expect(runOperation(operation("lists.addLeads"), context(), { id: secondListId, leadIds: [contactId] })).resolves.toMatchObject({ added: 1, campaignUpdates: [{ campaignId, enrolled: 0, restarted: false, blockedReason: null }] });
    await expectNewLeadsReady(campaignId, 0);
    const enrollments = await db.select().from(schema.enrollments).where(eq(schema.enrollments.contactId, contactId));
    expect(enrollments).toHaveLength(1);
    expect(enrollments[0]).toMatchObject({ sequenceVersionId: versionId, campaignId: null, status: "completed" });
    expect(await campaignStatus(campaignId)).toBe("completed");
  });

  it("preserves finished campaign dedup at the legacy Free cap and adds an over-cap lead without sending", async () => {
    // The contact cap belongs to a hosted workspace still inside its legacy Free window.
    await db.update(schema.workspaces).set({ legacyFreeUntil: new Date(Date.now() + 20 * 86_400_000) }).where(eq(schema.workspaces.id, workspaceId));
    const legacyFree = (): OperationContext => ({ ...context(), env: { ...context().env, edition: "cloud" } });
    const firstListId = await createList("Free plan completed audience");
    const secondListId = await createList("Free plan duplicate audience");
    const contactIds = Array.from({ length: 100 }, () => randomUUID());
    // Fill the rest of the free plan's contact cap with leads enrolled elsewhere.
    const priorIds = Array.from({ length: FREE_PLAN_CONTACT_LIMIT - contactIds.length }, () => randomUUID());
    await db.insert(schema.contacts).values(priorIds.map((contactId) => ({ id: contactId, workspaceId, email: `free-cap-prior-${contactId}@example.com`, normalizedEmail: `free-cap-prior-${contactId}@example.com`, status: "active" as const })));
    await db.insert(schema.enrollments).values(priorIds.map((contactId) => ({ id: randomUUID(), workspaceId, contactId, sequenceId, sequenceVersionId: versionId, emailAccountId: mailboxId, status: "completed" as const })));
    await db.insert(schema.contacts).values(contactIds.map((contactId) => ({ id: contactId, workspaceId, email: `free-cap-${contactId}@example.com`, normalizedEmail: `free-cap-${contactId}@example.com`, status: "active" as const })));
    await db.insert(schema.contactListMembers).values(contactIds.map((contactId) => ({ workspaceId, contactListId: firstListId, contactId })));
    const campaignId = await createCampaignWithLists("Free plan completed campaign", "draft", [firstListId, secondListId]);
    await expect(runOperation(operation("campaigns.launch"), legacyFree(), { id: campaignId })).resolves.toMatchObject({ enrollment: { enrolled: 100 } });
    await finishCampaign(campaignId);
    const completed = await db.select({ status: schema.enrollments.status }).from(schema.enrollments).where(eq(schema.enrollments.campaignId, campaignId));
    expect(completed).toHaveLength(100);
    expect(completed.every((enrollment) => enrollment.status === "completed")).toBe(true);
    await expect(db.select().from(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, workspaceId))).resolves.toHaveLength(0);

    await expect(runOperation(operation("lists.addLeads"), legacyFree(), { id: secondListId, leadIds: [contactIds[0]] })).resolves.toMatchObject({
      added: 1,
      campaignUpdates: [{ campaignId, enrolled: 0, restarted: false, blockedReason: null }],
    });
    const overCapId = await createContact("free-cap-new-contact");
    await expect(runOperation(operation("lists.addLeads"), legacyFree(), { id: firstListId, leadIds: [overCapId] })).resolves.toMatchObject({
      added: 1,
      campaignUpdates: [{ campaignId, enrolled: 0, restarted: false, blockedReason: "plan_limit" }],
    });

    expect(await campaignStatus(campaignId)).toBe("completed");
    expect(new Set(await enrolledContactIds(campaignId))).toEqual(new Set(contactIds));
    await expect(db.select().from(schema.contactListMembers).where(and(eq(schema.contactListMembers.contactListId, firstListId), eq(schema.contactListMembers.contactId, overCapId)))).resolves.toHaveLength(1);
    expect(await restartNotifications()).toHaveLength(0);
    await expectNewLeadsReady(campaignId, 1);
  });

  it.each(["member", "unverified_owner"] as const)("lets a %s add a list member while automatic enrollment reports not_manager", async (actor) => {
    const listId = await createList("Unauthorized automatic audience");
    const { campaignId, contactId: finishedId } = await createFinishedCampaign("Unauthorized automatic campaign", [listId]);
    const addContext = context();
    let memberId: string | undefined;
    if (actor === "member") {
      memberId = randomUUID();
      const email = `automatic-member-${memberId}@example.com`;
      await db.insert(schema.users).values({ id: memberId, email, normalizedEmail: email, displayName: "Automatic enrollment member" });
      await db.insert(schema.memberships).values({ id: randomUUID(), workspaceId, userId: memberId, role: "member", status: "active", joinedAt: new Date() });
      addContext.userId = memberId;
    } else {
      await db.update(schema.authUsers).set({ emailVerified: false }).where(eq(schema.authUsers.id, userId));
    }
    try {
      const waitingId = await createContact("unauthorized-automatic-waiting");

      await expect(runOperation(operation("lists.addLeads"), addContext, { id: listId, leadIds: [waitingId] })).resolves.toMatchObject({
        added: 1,
        campaignUpdates: [{ campaignId, enrolled: 0, restarted: false, blockedReason: "not_manager" }],
      });

      expect(await campaignStatus(campaignId)).toBe("completed");
      expect(await enrolledContactIds(campaignId)).toEqual([finishedId]);
      await expect(db.select().from(schema.contactListMembers).where(and(eq(schema.contactListMembers.contactListId, listId), eq(schema.contactListMembers.contactId, waitingId)))).resolves.toHaveLength(1);
      expect(await restartNotifications()).toHaveLength(0);
      await expectNewLeadsReady(campaignId, 1);
    } finally {
      if (memberId) await db.delete(schema.users).where(eq(schema.users.id, memberId));
    }
  });

  it("gives the first-launched campaign the new lead when two campaigns share a sequence and list", async () => {
    const listId = await createList("Shared automatic audience");
    const firstId = await createContact("first-launched-campaign-seed");
    await addToList(listId, firstId);
    const firstCampaignId = await createCampaignWithLists("First-launched automatic campaign", "draft", [listId]);
    await expect(runOperation(operation("campaigns.launch"), context(), { id: firstCampaignId })).resolves.toMatchObject({ enrollment: { enrolled: 1 } });
    const secondId = await createContact("second-launched-campaign-seed");
    await addToList(listId, secondId);
    const secondCampaignId = await createCampaignWithLists("Second-launched automatic campaign", "draft", [listId]);
    await expect(runOperation(operation("campaigns.launch"), context(), { id: secondCampaignId })).resolves.toMatchObject({ enrollment: { enrolled: 1 } });
    await db.update(schema.campaigns).set({ launchedAt: new Date("2026-10-01T08:00:00.000Z") }).where(eq(schema.campaigns.id, firstCampaignId));
    await db.update(schema.campaigns).set({ launchedAt: new Date("2026-10-01T09:00:00.000Z") }).where(eq(schema.campaigns.id, secondCampaignId));
    const contactId = await createContact("shared-automatic-new-lead");

    await expect(runOperation(operation("lists.addLeads"), context(), { id: listId, leadIds: [contactId] })).resolves.toMatchObject({
      added: 1,
      campaignUpdates: [
        { campaignId: firstCampaignId, enrolled: 1, restarted: false, blockedReason: null },
        { campaignId: secondCampaignId, enrolled: 0, restarted: false, blockedReason: null },
      ],
    });

    expect(new Set(await enrolledContactIds(firstCampaignId))).toEqual(new Set([firstId, contactId]));
    expect(await enrolledContactIds(secondCampaignId)).toEqual([secondId]);
    expect(await restartNotifications()).toHaveLength(0);
  });

  it("does nothing when the automatic helper receives another tenant's list", async () => {
    const listId = await createList("Tenant-isolated automatic audience");
    const { campaignId, contactId: finishedId } = await createFinishedCampaign("Tenant-isolated automatic campaign", [listId]);
    const contactId = await createContact("tenant-isolated-waiting");
    await addToList(listId, contactId);

    await expect(enrollNewListLeads({ ...context(), workspaceId: randomUUID() }, { listId, leadIds: [contactId] })).resolves.toEqual({ campaignUpdates: [] });

    expect(await campaignStatus(campaignId)).toBe("completed");
    expect(await enrolledContactIds(campaignId)).toEqual([finishedId]);
    expect(await restartNotifications()).toHaveLength(0);
    await expectNewLeadsReady(campaignId, 1);
  });

  it("returns campaignUpdates from a named-list import and enrolls only inserted memberships", async () => {
    const listId = await createList("Named import automatic audience");
    const { campaignId, contactId: finishedId } = await createFinishedCampaign("Named import automatic campaign", [listId]);
    const oldId = await createContact("import-old-list-member");
    await addToList(listId, oldId);
    const existingId = await createContact("import-existing-new-member");
    const [list] = await db.select().from(schema.contactLists).where(eq(schema.contactLists.id, listId));
    const contacts = await db.select({ email: schema.contacts.email }).from(schema.contacts).where(inArray(schema.contacts.id, [oldId, existingId]));
    if (!list) throw new Error("Missing named import test list.");
    const newEmail = `import-new-${randomUUID()}@example.com`;
    const input = { listName: list.name, leads: [...contacts.map((contact) => ({ email: contact.email })), { email: newEmail }] };

    const imported = await runOperation(operation("leads.import"), context(), input);
    expect(imported).toMatchObject({
      imported: 1,
      updated: 2,
      listId,
      campaignUpdates: [{ campaignId, enrolled: 2, restarted: true, blockedReason: null }],
    });
    const [created] = await db.select({ id: schema.contacts.id }).from(schema.contacts).where(and(eq(schema.contacts.workspaceId, workspaceId), eq(schema.contacts.normalizedEmail, newEmail)));
    if (!created) throw new Error("Missing imported test contact.");
    expect(new Set(await enrolledContactIds(campaignId))).toEqual(new Set([finishedId, existingId, created.id]));
    await expectNewLeadsReady(campaignId, 1);

    await expect(runOperation(operation("leads.import"), context(), input)).resolves.toMatchObject({
      imported: 0,
      updated: 3,
      listId,
      campaignUpdates: [{ campaignId, enrolled: 0, restarted: false, blockedReason: null }],
    });
    expect(new Set(await enrolledContactIds(campaignId))).toEqual(new Set([finishedId, existingId, created.id]));
    expect(await restartNotifications()).toHaveLength(1);
    await expectNewLeadsReady(campaignId, 1);
  });

  it.each(["no_sender", "sequence_inactive", "sending_disabled"] as const)("keeps newly added leads in the list when automatic enrollment reports %s", async (blockedReason) => {
    const listId = await createList("Blocked automatic audience");
    const { campaignId, contactId: finishedId } = await createFinishedCampaign("Blocked automatic campaign", [listId]);
    if (blockedReason === "no_sender") {
      await db.update(schema.emailAccounts).set({ status: "disconnected" }).where(eq(schema.emailAccounts.id, mailboxId));
    } else if (blockedReason === "sequence_inactive") {
      await runOperation(operation("sequences.pause"), context(), { id: sequenceId });
    } else {
      await db.update(schema.workspaces).set({ killSwitchEnabled: true }).where(eq(schema.workspaces.id, workspaceId));
    }
    const waitingId = await createContact("blocked-automatic-waiting");

    await expect(runOperation(operation("lists.addLeads"), context(), { id: listId, leadIds: [waitingId] })).resolves.toMatchObject({
      added: 1,
      campaignUpdates: [{ campaignId, enrolled: 0, restarted: false, blockedReason }],
    });

    expect(await campaignStatus(campaignId)).toBe("completed");
    expect(await enrolledContactIds(campaignId)).toEqual([finishedId]);
    await expect(db.select().from(schema.contactListMembers).where(and(eq(schema.contactListMembers.contactListId, listId), eq(schema.contactListMembers.contactId, waitingId)))).resolves.toHaveLength(1);
    expect(await restartNotifications()).toHaveLength(0);
    await expectNewLeadsReady(campaignId, 1);
  });

  it("keeps headline analytics across all sequence versions", async () => {
    const campaignId = await createCampaign("Versioned analytics campaign");
    await enrollCampaign(campaignId, await createContact("version-one-analytics"));

    const nextVersionId = randomUUID();
    const nextStepId = randomUUID();
    await db.insert(schema.sequenceVersions).values({ id: nextVersionId, workspaceId, sequenceId, version: 2, status: "active", snapshot: { description: "Updated sequence" }, launchedAt: new Date(), createdByUserId: userId });
    await db.insert(schema.sequenceSteps).values({ id: nextStepId, workspaceId, sequenceVersionId: nextVersionId, stepOrder: 1, delayDays: 1, subject: "Updated hello {{firstName}}", bodyText: "Updated hello {{firstName}}" });
    await db.update(schema.sequences).set({ currentVersionId: nextVersionId, updatedAt: new Date() }).where(eq(schema.sequences.id, sequenceId));

    const analytics = await runOperation(operation("sequences.analytics"), context(), { id: sequenceId });
    const listed = await runOperation(operation("sequences.list"), context(), {});
    const campaigns = await runOperation(operation("campaigns.list"), context(), {});
    const listedCampaign = campaigns.campaigns.find((item: { id: string }) => item.id === campaignId);
    const campaignDetail = await runOperation(operation("campaigns.get"), context(), { id: campaignId });

    expect(listed.sequences).toEqual(expect.arrayContaining([expect.objectContaining({ id: sequenceId, enrolledCount: 1 })]));
    expect(listedCampaign).toMatchObject({ enrolled: campaignDetail.totals.enrolled, sent: campaignDetail.totals.sent, replied: campaignDetail.totals.replied, opened: campaignDetail.totals.opened, replyRate: campaignDetail.totals.replyRate, openRate: campaignDetail.totals.openRate });
    expect(analytics).toMatchObject({
      sequenceId,
      currentVersion: 2,
      selectedVersion: 2,
      totals: { scheduled: 1 },
      enrollmentStatus: { scheduled: 1 },
      steps: [expect.objectContaining({ stepId: nextStepId, version: 2, scheduled: 0 })],
    });
  });
});
