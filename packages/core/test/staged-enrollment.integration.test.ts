import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { operationByName, runOperation, type OperationContext } from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;

function operation(name: string) {
  const found = operationByName.get(name);
  if (!found) throw new Error(`Missing operation ${name}`);
  return found;
}

describe.skipIf(!databaseUrl)("staged enrollment on draft sequences", () => {
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);

  let userId = "";
  let workspaceId = "";
  let mailboxId = "";

  function context(): OperationContext {
    return {
      db,
      workspaceId,
      userId,
      env: {
        edition: "selfhost",
        authSecret: "staged-enrollment-test-auth-secret-at-least-32-chars",
        apiBaseUrl: "https://api.example.test",
      },
    };
  }

  function contextFor(ws: { workspaceId: string; userId: string }): OperationContext {
    return {
      db,
      workspaceId: ws.workspaceId,
      userId: ws.userId,
      env: {
        edition: "selfhost",
        authSecret: "staged-enrollment-test-auth-secret-at-least-32-chars",
        apiBaseUrl: "https://api.example.test",
      },
    };
  }

  async function setupWorkspace(label: string) {
    const suffix = randomUUID().slice(0, 8);
    const newUserId = randomUUID();
    const newWorkspaceId = randomUUID();
    const newMailboxId = randomUUID();
    const mailboxEmail = `${label}-mailbox-${suffix}@example.com`;
    await db.insert(schema.authUsers).values({ id: newUserId, name: `${label} test`, email: `${label}-user-${suffix}@example.com`, emailVerified: true });
    await db.insert(schema.users).values({ id: newUserId, email: `${label}-user-${suffix}@example.com`, normalizedEmail: `${label}-user-${suffix}@example.com`, displayName: `${label} test` });
    await db.insert(schema.workspaces).values({ id: newWorkspaceId, name: `${label} ${suffix}`, slug: `${label}-${suffix}`, createdByUserId: newUserId });
    await db.insert(schema.memberships).values({ id: randomUUID(), workspaceId: newWorkspaceId, userId: newUserId, role: "owner", status: "active", joinedAt: new Date() });
    await db.insert(schema.emailAccounts).values({
      id: newMailboxId,
      workspaceId: newWorkspaceId,
      userId: newUserId,
      provider: "gmail",
      composioConnectedAccountId: `${label}-${suffix}`,
      email: mailboxEmail,
      normalizedEmail: mailboxEmail,
      alias: `${label}-${suffix}`,
      status: "active",
    });
    return { userId: newUserId, workspaceId: newWorkspaceId, mailboxId: newMailboxId };
  }

  async function createMailbox(label: string) {
    const id = randomUUID();
    const suffix = randomUUID().slice(0, 8);
    const email = `${label}-${suffix}@example.com`;
    await db.insert(schema.emailAccounts).values({
      id,
      workspaceId,
      userId,
      provider: "gmail",
      composioConnectedAccountId: `${label}-${suffix}`,
      email,
      normalizedEmail: email,
      alias: `${label}-${suffix}`,
      status: "active",
    });
    return id;
  }

  async function createDraftSequence(label: string) {
    const created = await runOperation(operation("sequences.create"), context(), {
      name: label,
      steps: [{ delayDays: 0, subject: "Hi {{firstName}}", body: "Hello {{firstName}}" }],
    });
    return created.sequence.id as string;
  }

  async function createDraftCampaign(sequenceId: string, label: string, emailAccountId = mailboxId) {
    const campaignId = randomUUID();
    await db.insert(schema.campaigns).values({ id: campaignId, workspaceId, sequenceId, emailAccountId, name: label, status: "draft" });
    return campaignId;
  }

  async function createContact(label: string, status: "active" | "suppressed" | "enrolled" | "replied" = "active") {
    const contactId = randomUUID();
    const email = `${label}-${randomUUID()}@example.com`;
    await db.insert(schema.contacts).values({ id: contactId, workspaceId, email, normalizedEmail: email, status });
    return contactId;
  }

  async function stagedRows(sequenceId: string) {
    return db.select().from(schema.stagedEnrollments).where(eq(schema.stagedEnrollments.sequenceId, sequenceId));
  }

  async function enrollmentsFor(sequenceId: string) {
    return db.select().from(schema.enrollments).where(eq(schema.enrollments.sequenceId, sequenceId));
  }

  async function messagesFor(workspaceIdValue: string) {
    return db.select().from(schema.messages).where(eq(schema.messages.workspaceId, workspaceIdValue));
  }

  async function campaignRow(campaignId: string) {
    const [row] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
    return row;
  }

  beforeAll(async () => {
    await pool.query("select 1");
  });

  beforeEach(async () => {
    const setup = await setupWorkspace("staged");
    userId = setup.userId;
    workspaceId = setup.workspaceId;
    mailboxId = setup.mailboxId;
  });

  afterEach(async () => {
    if (workspaceId) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    if (userId) {
      await db.delete(schema.users).where(eq(schema.users.id, userId));
      await db.delete(schema.authUsers).where(eq(schema.authUsers.id, userId));
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  it("queues contacts on a draft sequence without scheduling anything", async () => {
    const sequenceId = await createDraftSequence("Draft queue");
    const contactId = await createContact("queued");
    const result = await runOperation(operation("sequences.enroll"), context(), { id: sequenceId, leadIds: [contactId] });
    expect(result).toMatchObject({ enrolled: 0, queued: 1, sequence: { queuedCount: 1 } });
    expect(await enrollmentsFor(sequenceId)).toHaveLength(0);
    expect(await messagesFor(workspaceId)).toHaveLength(0);
    const staged = await stagedRows(sequenceId);
    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatchObject({ workspaceId, sequenceId, leadId: contactId, campaignId: null, inboxIds: null });
  });

  it("ignores duplicate enroll calls for the same lead", async () => {
    const sequenceId = await createDraftSequence("Draft duplicates");
    const contactId = await createContact("dup");
    await runOperation(operation("sequences.enroll"), context(), { id: sequenceId, leadIds: [contactId] });
    const second = await runOperation(operation("sequences.enroll"), context(), { id: sequenceId, leadIds: [contactId] });
    expect(second).toMatchObject({ queued: 1 });
    expect(await stagedRows(sequenceId)).toHaveLength(1);
  });

  it("converts the queue to real, suppression-respecting enrollments on publish", async () => {
    const sequenceId = await createDraftSequence("Draft publish");
    const eligibleContactId = await createContact("eligible");
    const suppressedContactId = await createContact("suppressed", "suppressed");
    await runOperation(operation("sequences.enroll"), context(), { id: sequenceId, leadIds: [eligibleContactId, suppressedContactId], inboxId: mailboxId });
    expect(await stagedRows(sequenceId)).toHaveLength(2);

    const published = await runOperation(operation("sequences.publish"), context(), { id: sequenceId });
    expect(published.queuedEnrollment).toMatchObject({ enrolled: 1, skipped: { suppressed: 1 } });

    const enrollments = await enrollmentsFor(sequenceId);
    expect(enrollments).toHaveLength(1);
    expect(enrollments[0]?.contactId).toBe(eligibleContactId);
    const messages = await messagesFor(workspaceId);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.status).toBe("scheduled");

    // The queue is cleared for both the enrolled and the permanently-skipped lead.
    expect(await stagedRows(sequenceId)).toHaveLength(0);
  });

  it("does not double-enroll on a repeated publish call", async () => {
    const sequenceId = await createDraftSequence("Draft retry");
    const contactId = await createContact("retry");
    await runOperation(operation("sequences.enroll"), context(), { id: sequenceId, leadIds: [contactId], inboxId: mailboxId });
    await runOperation(operation("sequences.publish"), context(), { id: sequenceId });
    expect(await enrollmentsFor(sequenceId)).toHaveLength(1);

    // A second publish (e.g. campaigns.launch re-publishing on every launch) must be a no-op.
    const secondPublish = await runOperation(operation("sequences.publish"), context(), { id: sequenceId });
    expect(secondPublish.queuedEnrollment).toBeUndefined();
    expect(await enrollmentsFor(sequenceId)).toHaveLength(1);
  });

  it("discards the queue when the draft is archived", async () => {
    const sequenceId = await createDraftSequence("Draft archive");
    const contactId = await createContact("archive-me");
    await runOperation(operation("sequences.enroll"), context(), { id: sequenceId, leadIds: [contactId] });
    expect(await stagedRows(sequenceId)).toHaveLength(1);
    await runOperation(operation("sequences.archive"), context(), { id: sequenceId });
    expect(await stagedRows(sequenceId)).toHaveLength(0);
  });

  it("discards the queue when the draft is deleted", async () => {
    const sequenceId = await createDraftSequence("Draft delete");
    const contactId = await createContact("delete-me");
    await runOperation(operation("sequences.enroll"), context(), { id: sequenceId, leadIds: [contactId] });
    expect(await stagedRows(sequenceId)).toHaveLength(1);
    await runOperation(operation("sequences.delete"), context(), { id: sequenceId });
    expect(await stagedRows(sequenceId)).toHaveLength(0);
  });

  it("keeps staged queues tenant-isolated", async () => {
    const other = await setupWorkspace("other-tenant");
    try {
      const sequenceId = await createDraftSequence("Tenant draft");
      const contactId = await createContact("tenant-owned");

      // Workspace B's own owner cannot stage leads on workspace A's draft: sequence
      // lookup itself is scoped to the caller's own workspace.
      await expect(runOperation(operation("sequences.enroll"), contextFor(other), { id: sequenceId, leadIds: [contactId] })).rejects.toMatchObject({ code: "NOT_FOUND" });

      await runOperation(operation("sequences.enroll"), context(), { id: sequenceId, leadIds: [contactId] });
      expect(await stagedRows(sequenceId)).toHaveLength(1);

      // Workspace B cannot read workspace A's queue either.
      await expect(runOperation(operation("sequences.queued"), contextFor(other), { id: sequenceId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally {
      await db.delete(schema.workspaces).where(eq(schema.workspaces.id, other.workspaceId));
      await db.delete(schema.users).where(eq(schema.users.id, other.userId));
      await db.delete(schema.authUsers).where(eq(schema.authUsers.id, other.userId));
    }
  });

  it("lists and removes queued contacts without publishing", async () => {
    const sequenceId = await createDraftSequence("Draft manage queue");
    const keepId = await createContact("keep");
    const removeId = await createContact("remove");
    await runOperation(operation("sequences.enroll"), context(), { id: sequenceId, leadIds: [keepId, removeId] });

    const queued = await runOperation(operation("sequences.queued"), context(), { id: sequenceId });
    expect(queued.queued).toHaveLength(2);

    const dequeued = await runOperation(operation("sequences.dequeue"), context(), { id: sequenceId, leadIds: [removeId] });
    expect(dequeued).toMatchObject({ removed: 1, sequence: { queuedCount: 1 } });
    expect(await stagedRows(sequenceId)).toHaveLength(1);

    await runOperation(operation("sequences.dequeue"), context(), { id: sequenceId });
    expect(await stagedRows(sequenceId)).toHaveLength(0);
  });

  it("does not interact with a published sequence's normal enroll path", async () => {
    const sequenceId = await createDraftSequence("Already published");
    const contactId = await createContact("direct");
    await runOperation(operation("sequences.publish"), context(), { id: sequenceId });
    const result = await runOperation(operation("sequences.enroll"), context(), { id: sequenceId, leadIds: [contactId], inboxId: mailboxId });
    expect(result).toMatchObject({ enrolled: 1 });
    expect(result.queued).toBeUndefined();
    expect(await stagedRows(sequenceId)).toHaveLength(0);
  });

  // --- Campaign attribution (the adversarial-review blocker) -----------------

  it("attributes a queued contact to the sequence's single draft campaign, sends from its mailbox, and activates it through campaigns.launch", async () => {
    const sequenceId = await createDraftSequence("Launch attribution");
    const campaignId = await createDraftCampaign(sequenceId, "Launch attribution campaign");
    const contactId = await createContact("launch-attrib");

    const staged = await runOperation(operation("sequences.enroll"), context(), { id: sequenceId, leadIds: [contactId] });
    // Auto-detected: this draft sequence has exactly one (necessarily draft) campaign.
    expect(staged.sequence.queuedCount).toBe(1);
    const stagedRow = (await stagedRows(sequenceId))[0];
    expect(stagedRow).toMatchObject({ campaignId });

    const launch = await runOperation(operation("campaigns.launch"), context(), { id: campaignId });
    expect(launch.campaign.status).toBe("active");

    const enrollments = await enrollmentsFor(sequenceId);
    expect(enrollments).toHaveLength(1);
    expect(enrollments[0]).toMatchObject({ campaignId, emailAccountId: mailboxId, contactId });
    expect(await stagedRows(sequenceId)).toHaveLength(0);

    // Visible to campaign reads/metrics, and pausable like any other launched campaign.
    const details = await runOperation(operation("campaigns.get"), context(), { id: campaignId });
    expect(details.campaign.enrolledCount ?? details.totals?.enrolled).toBeTruthy();
    expect(await runOperation(operation("campaigns.pause"), context(), { id: campaignId })).toMatchObject({ campaign: { status: "paused" } });
    expect((await campaignRow(campaignId))?.status).toBe("paused");
  });

  it("attributes and activates a draft campaign through a direct sequences.publish call (the web campaigns list Publish action)", async () => {
    const sequenceId = await createDraftSequence("Direct publish attribution");
    const campaignId = await createDraftCampaign(sequenceId, "Direct publish campaign");
    const contactId = await createContact("direct-publish-attrib");
    await runOperation(operation("sequences.enroll"), context(), { id: sequenceId, leadIds: [contactId] });

    expect((await campaignRow(campaignId))?.status).toBe("draft");
    const published = await runOperation(operation("sequences.publish"), context(), { id: sequenceId });
    expect(published.queuedEnrollment).toMatchObject({ enrolled: 1 });

    const campaignAfter = await campaignRow(campaignId);
    expect(campaignAfter?.status).toBe("active");
    expect(campaignAfter?.launchedAt).toBeTruthy();

    const enrollments = await enrollmentsFor(sequenceId);
    expect(enrollments).toHaveLength(1);
    expect(enrollments[0]).toMatchObject({ campaignId, emailAccountId: mailboxId });

    expect(await runOperation(operation("campaigns.pause"), context(), { id: campaignId })).toMatchObject({ campaign: { status: "paused" } });
  });

  it("activates a draft campaign through campaigns.launch when it already has attributed enrollments but no new ones this call", async () => {
    const sequenceId = await createDraftSequence("Launch catches up");
    const campaignId = await createDraftCampaign(sequenceId, "Launch catches up campaign");
    // Simulate a campaign that already has a real, attributed enrollment but
    // was never flipped out of "draft" - e.g. a crash between an earlier
    // enroll commit and the activation step, or a direct sequences.enroll
    // call with an explicit campaignId on an already-published sequence.
    await runOperation(operation("sequences.publish"), context(), { id: sequenceId });
    const contactId = await createContact("catch-up");
    await runOperation(operation("sequences.enroll"), context(), { id: sequenceId, leadIds: [contactId], inboxId: mailboxId, campaignId });
    expect((await campaignRow(campaignId))?.status).toBe("draft");
    expect(await enrollmentsFor(sequenceId)).toHaveLength(1);

    // campaigns.launch's own enroll call finds zero *new* ready leads (the
    // only contact is already enrolled), so activation must come from
    // noticing the campaign already has enrollments, not from this call's count.
    const launch = await runOperation(operation("campaigns.launch"), context(), { id: campaignId });
    expect(launch.enrollment.enrolled).toBe(0);
    expect(launch.campaign.status).toBe("active");
    expect((await campaignRow(campaignId))?.status).toBe("active");
    expect(await enrollmentsFor(sequenceId)).toHaveLength(1);
  });

  it("does not double-enroll when campaigns.launch also matches the converted lead through the campaign's own list", async () => {
    const sequenceId = await createDraftSequence("Launch list overlap");
    const campaignId = await createDraftCampaign(sequenceId, "Launch list overlap campaign");
    const listId = randomUUID();
    await db.insert(schema.contactLists).values({ id: listId, workspaceId, name: `Overlap list ${randomUUID().slice(0, 8)}` });
    await db.insert(schema.campaignContactLists).values({ campaignId, contactListId: listId, workspaceId });
    await db.update(schema.campaigns).set({ contactListId: listId }).where(eq(schema.campaigns.id, campaignId));
    const contactId = await createContact("overlap");
    await db.insert(schema.contactListMembers).values({ workspaceId, contactListId: listId, contactId });

    // Staged directly on the sequence (auto-attributed to this campaign, the
    // sequence's only one), and the same lead is also a member of the list
    // campaigns.launch will separately try to enroll from.
    await runOperation(operation("sequences.enroll"), context(), { id: sequenceId, leadIds: [contactId] });

    const launch = await runOperation(operation("campaigns.launch"), context(), { id: campaignId });
    expect(launch.campaign.status).toBe("active");
    const enrollments = await enrollmentsFor(sequenceId);
    expect(enrollments).toHaveLength(1);
    expect(enrollments[0]).toMatchObject({ campaignId, contactId });
  });

  it("rejects staging against a campaign that belongs to a different sequence", async () => {
    const sequenceId = await createDraftSequence("Wrong campaign sequence");
    const otherSequenceId = await createDraftSequence("Other sequence");
    const otherCampaignId = await createDraftCampaign(otherSequenceId, "Other sequence campaign");
    const contactId = await createContact("wrong-campaign");
    await expect(runOperation(operation("sequences.enroll"), context(), { id: sequenceId, leadIds: [contactId], campaignId: otherCampaignId })).rejects.toMatchObject({ code: "BAD_INPUT" });
  });

  // --- Transient vs. permanent skip handling during conversion ----------------

  it("restores a transiently-skipped lead to the queue but drops a permanently-skipped one", async () => {
    const sequenceId = await createDraftSequence("Transient vs permanent");
    // A reply can clear later, so it stays queued; a contact merely "enrolled" elsewhere no longer
    // blocks (leads can be active in several campaigns) and is covered by the multi-campaign test.
    const alreadyEnrolledId = await createContact("replied-lead", "replied");
    const suppressedId = await createContact("permanently-suppressed", "suppressed");
    await runOperation(operation("sequences.enroll"), context(), { id: sequenceId, leadIds: [alreadyEnrolledId, suppressedId], inboxId: mailboxId });
    expect(await stagedRows(sequenceId)).toHaveLength(2);

    const published = await runOperation(operation("sequences.publish"), context(), { id: sequenceId });
    expect(published.queuedEnrollment).toMatchObject({ enrolled: 0, skipped: { replied: 1, suppressed: 1 } });

    const remaining = await stagedRows(sequenceId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ leadId: alreadyEnrolledId });

    // Once the contact is free again, a later publish picks it back up.
    await db.update(schema.contacts).set({ status: "active" }).where(eq(schema.contacts.id, alreadyEnrolledId));
    const secondPublish = await runOperation(operation("sequences.publish"), context(), { id: sequenceId });
    expect(secondPublish.queuedEnrollment).toMatchObject({ enrolled: 1 });
    expect(await stagedRows(sequenceId)).toHaveLength(0);
  });

  // --- Blocked conversion is retry-safe ---------------------------------------

  it("restores the whole queue when conversion is blocked and converts once the blocker is resolved", async () => {
    const sequenceId = await createDraftSequence("Blocked conversion");
    const contactId = await createContact("blocked");
    await runOperation(operation("sequences.enroll"), context(), { id: sequenceId, leadIds: [contactId] });

    // No sendable mailbox in the workspace.
    await db.update(schema.emailAccounts).set({ status: "disconnected" }).where(eq(schema.emailAccounts.id, mailboxId));
    const blockedPublish = await runOperation(operation("sequences.publish"), context(), { id: sequenceId });
    expect(blockedPublish.queuedEnrollment).toMatchObject({ blocked: true });
    expect(await enrollmentsFor(sequenceId)).toHaveLength(0);
    expect(await stagedRows(sequenceId)).toHaveLength(1);

    // Publishing again before the blocker is fixed is still a safe no-op retry.
    const stillBlocked = await runOperation(operation("sequences.publish"), context(), { id: sequenceId });
    expect(stillBlocked.queuedEnrollment).toMatchObject({ blocked: true });
    expect(await stagedRows(sequenceId)).toHaveLength(1);

    await db.update(schema.emailAccounts).set({ status: "active" }).where(eq(schema.emailAccounts.id, mailboxId));
    const resolved = await runOperation(operation("sequences.publish"), context(), { id: sequenceId });
    expect(resolved.queuedEnrollment).toMatchObject({ enrolled: 1 });
    expect(await enrollmentsFor(sequenceId)).toHaveLength(1);
    expect(await stagedRows(sequenceId)).toHaveLength(0);
  });

  // --- Explicit sender selection persisted at staging time --------------------

  it("honors an explicit inbox requested at staging time instead of falling back to rotation", async () => {
    const sequenceId = await createDraftSequence("Explicit inbox");
    const secondMailboxId = await createMailbox("second");
    const contactId = await createContact("explicit-inbox");
    await runOperation(operation("sequences.enroll"), context(), { id: sequenceId, leadIds: [contactId], inboxId: secondMailboxId });
    const staged = (await stagedRows(sequenceId))[0];
    expect(staged?.inboxIds).toEqual([secondMailboxId]);

    await runOperation(operation("sequences.publish"), context(), { id: sequenceId });
    const enrollments = await enrollmentsFor(sequenceId);
    expect(enrollments).toHaveLength(1);
    expect(enrollments[0]?.emailAccountId).toBe(secondMailboxId);
  });

  // --- Dequeue vs. publish race -------------------------------------------------

  it("never enrolls a lead that sequences.dequeue removed, however the race between dequeue and publish lands", async () => {
    const sequenceId = await createDraftSequence("Dequeue race");
    const contactA = await createContact("race-a");
    const contactB = await createContact("race-b");
    await runOperation(operation("sequences.enroll"), context(), { id: sequenceId, leadIds: [contactA, contactB], inboxId: mailboxId });

    const [dequeueResult, publishResult] = await Promise.all([
      runOperation(operation("sequences.dequeue"), context(), { id: sequenceId, leadIds: [contactA] }),
      runOperation(operation("sequences.publish"), context(), { id: sequenceId }),
    ]);

    const enrolledContactIds = (await enrollmentsFor(sequenceId)).map((row) => row.contactId);
    // Whichever side won the race, contactA is never both removed and enrolled.
    if (dequeueResult.removed > 0) {
      expect(enrolledContactIds).not.toContain(contactA);
    } else {
      expect(enrolledContactIds).toContain(contactA);
    }
    // contactB was never raced over and always converts normally.
    expect(enrolledContactIds).toContain(contactB);
    expect(publishResult.queuedEnrollment).toBeTruthy();
  });
});
