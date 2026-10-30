import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { and, asc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { findEligibleEnrollmentAudience } from "../src/enrollment-eligibility.js";
import { operationByName, runOperation, type OperationContext } from "../src/index.js";
import { findLeadsMissingVariables, sequenceRequiredVariables } from "../src/lead-variables.js";
import { listLeadVariableNames, readLeadVariables } from "../src/lead-variables-view.js";

const databaseUrl = process.env.DATABASE_URL;

function operation(name: string) {
  const found = operationByName.get(name);
  if (!found) throw new Error(`Missing operation ${name}`);
  return found;
}

describe.skipIf(!databaseUrl)("lead variables round 3: grandfathering, cleared values, parked leads", () => {
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);
  const created: { users: string[]; workspaces: string[] } = { users: [], workspaces: [] };
  let userId = "";
  let workspaceId = "";
  let mailboxId = "";

  function context(): OperationContext {
    return { db, workspaceId, userId, env: { edition: "selfhost", authSecret: "lead-variables-test-auth-secret-at-least-32-chars", apiBaseUrl: "https://api.example.test" } };
  }

  async function createWorkspace(label: string) {
    const suffix = randomUUID().slice(0, 8);
    const newUserId = randomUUID();
    const newWorkspaceId = randomUUID();
    const newMailboxId = randomUUID();
    const email = `${label}-user-${suffix}@example.com`;
    await db.insert(schema.authUsers).values({ id: newUserId, name: label, email, emailVerified: true });
    await db.insert(schema.users).values({ id: newUserId, email, normalizedEmail: email, displayName: label });
    await db.insert(schema.workspaces).values({ id: newWorkspaceId, name: `${label} ${suffix}`, slug: `${label}-${suffix}`, createdByUserId: newUserId });
    await db.insert(schema.memberships).values({ id: randomUUID(), workspaceId: newWorkspaceId, userId: newUserId, role: "owner", status: "active", joinedAt: new Date() });
    const mailboxEmail = `${label}-mailbox-${suffix}@example.com`;
    await db.insert(schema.emailAccounts).values({ id: newMailboxId, workspaceId: newWorkspaceId, userId: newUserId, provider: "gmail", composioConnectedAccountId: `${label}-${suffix}`, email: mailboxEmail, normalizedEmail: mailboxEmail, alias: `${label}-${suffix}`, status: "active" });
    created.users.push(newUserId);
    created.workspaces.push(newWorkspaceId);
    return { userId: newUserId, workspaceId: newWorkspaceId, mailboxId: newMailboxId };
  }

  async function createSequence(label: string, steps: Array<{ delayDays: number; subject: string; body: string }> = [{ delayDays: 0, subject: "Quick note", body: "Hi {{firstName}},\n\n{{icebreaker}}\n\nWorth a chat?" }]) {
    const result = await runOperation(operation("sequences.create"), context(), { name: label, steps });
    return result.sequence.id as string;
  }

  async function grandfather(sequenceId: string) {
    await db.update(schema.sequenceVersions).set({ customVariablesEnforced: false }).where(eq(schema.sequenceVersions.sequenceId, sequenceId));
  }

  async function createContact(label: string, options: { customFields?: Record<string, unknown>; firstName?: string; updatedAt?: Date } = {}) {
    const id = randomUUID();
    const email = `r3-${label}-${randomUUID().slice(0, 8)}@example.com`;
    await db.insert(schema.contacts).values({ id, workspaceId, email, normalizedEmail: email, firstName: options.firstName ?? label, status: "active", customFields: options.customFields ?? {}, ...(options.updatedAt ? { updatedAt: options.updatedAt } : {}) });
    return { id, email };
  }

  async function createListWith(contactIds: string[]) {
    const listId = randomUUID();
    await db.insert(schema.contactLists).values({ id: listId, workspaceId, name: `list ${listId.slice(0, 8)}`, createdByUserId: userId });
    if (contactIds.length) await db.insert(schema.contactListMembers).values(contactIds.map((contactId) => ({ workspaceId, contactListId: listId, contactId })));
    return listId;
  }

  async function createCampaign(sequenceId: string, listId: string) {
    const result = await runOperation(operation("campaigns.create"), context(), { name: `campaign ${randomUUID().slice(0, 6)}`, sequenceId, listIds: [listId], inboxId: mailboxId });
    return result.campaign.id as string;
  }

  function setVariables(sequenceId: string, contactId: string, variables: Record<string, string | null>) {
    return runOperation(operation("campaigns.setLeadVariables"), context(), { sequenceId, leads: [{ contactId, variables }] });
  }

  // One lead with a value, in a launched campaign: returns everything the cleared-value tests need.
  async function launchedLead(label: string, steps?: Array<{ delayDays: number; subject: string; body: string }>, line = "Old line") {
    const sequenceId = await createSequence(label, steps);
    const lead = await createContact(label);
    await setVariables(sequenceId, lead.id, { icebreaker: line });
    const listId = await createListWith([lead.id]);
    const campaignId = await createCampaign(sequenceId, listId);
    await runOperation(operation("campaigns.launch"), context(), { id: campaignId });
    return { sequenceId, lead, listId, campaignId };
  }

  const enrollmentsFor = (sequenceId: string) => db.select().from(schema.enrollments).where(eq(schema.enrollments.sequenceId, sequenceId));
  const messagesFor = async (sequenceId: string) => {
    const rows = await db.select({ message: schema.messages, stepOrder: schema.sequenceSteps.stepOrder }).from(schema.messages)
      .innerJoin(schema.enrollments, eq(schema.messages.enrollmentId, schema.enrollments.id))
      .innerJoin(schema.sequenceSteps, eq(schema.messages.sequenceStepId, schema.sequenceSteps.id))
      .where(eq(schema.enrollments.sequenceId, sequenceId)).orderBy(asc(schema.messages.createdAt));
    return rows.map((row) => ({ ...row.message, stepOrder: row.stepOrder }));
  };
  const stagedFor = (sequenceId: string) => db.select().from(schema.stagedEnrollments).where(eq(schema.stagedEnrollments.sequenceId, sequenceId));
  const bodyOf = (message: { metadata: unknown }) => (message.metadata as { bodyText: string }).bodyText;
  async function campaignStatus(campaignId: string) {
    const [row] = await db.select({ status: schema.campaigns.status }).from(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
    return row?.status;
  }
  async function contactStatus(contactId: string) {
    const [row] = await db.select({ status: schema.contacts.status }).from(schema.contacts).where(eq(schema.contacts.id, contactId));
    return row?.status;
  }

  beforeEach(async () => {
    const own = await createWorkspace("lv3");
    userId = own.userId;
    workspaceId = own.workspaceId;
    mailboxId = own.mailboxId;
  });

  afterEach(async () => {
    for (const id of created.workspaces.splice(0)) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, id));
    for (const id of created.users.splice(0)) {
      await db.delete(schema.users).where(eq(schema.users.id, id));
      await db.delete(schema.authUsers).where(eq(schema.authUsers.id, id));
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  describe("grandfathered sequences", () => {
    it("default new versions to enforced while the column default is true for every later insert", async () => {
      const sequenceId = await createSequence("default-flag");
      const [version] = await db.select().from(schema.sequenceVersions).where(eq(schema.sequenceVersions.sequenceId, sequenceId));
      expect(version?.customVariablesEnforced).toBe(true);
      const raw = await pool.query("select column_default, is_nullable from information_schema.columns where table_name = 'sequence_versions' and column_name = 'custom_variables_enforced'");
      expect(raw.rows[0]).toMatchObject({ column_default: "true", is_nullable: "NO" });
      // A version row written by older code paths (no explicit value) enforces too.
      const rawVersionId = randomUUID();
      await db.insert(schema.sequenceVersions).values({ id: rawVersionId, workspaceId, sequenceId, version: 2, status: "draft" });
      const [inserted] = await db.select().from(schema.sequenceVersions).where(eq(schema.sequenceVersions.id, rawVersionId));
      expect(inserted?.customVariablesEnforced).toBe(true);
    });

    it("requires nothing, gates nothing and renders custom tokens literally for a non-enforced version", async () => {
      const sequenceId = await createSequence("grandfathered");
      await grandfather(sequenceId);
      const lead = await createContact("grandfathered");
      expect(await sequenceRequiredVariables(db, workspaceId, sequenceId)).toEqual([]);
      expect((await findLeadsMissingVariables(db, workspaceId, sequenceId, [lead.id])).size).toBe(0);
      const [sequence] = await db.select({ currentVersionId: schema.sequences.currentVersionId }).from(schema.sequences).where(eq(schema.sequences.id, sequenceId));
      const listId = await createListWith([lead.id]);
      const audience = await findEligibleEnrollmentAudience({ db, workspaceId, sequenceId, sequenceVersionId: sequence!.currentVersionId, listIds: [listId] });
      expect(audience.eligible.map((item) => item.id)).toEqual([lead.id]);
      expect(audience.skipped.missing_variables).toBe(0);

      const view = await readLeadVariables(db, workspaceId, { sequenceId });
      expect(view.variables).toEqual([]);

      const preview = await runOperation(operation("sequences.preview"), context(), { id: sequenceId, contactId: lead.id });
      expect(preview.steps[0]).toMatchObject({ missingVariables: [] });
      expect(preview.steps[0].body).toContain("{{icebreaker}}");

      // Launch is not blocked, and the first message keeps the literal token (exactly like before).
      const campaignId = await createCampaign(sequenceId, listId);
      const launched = await runOperation(operation("campaigns.launch"), context(), { id: campaignId });
      expect(launched.enrollment.enrolled).toBe(1);
      const [message] = await messagesFor(sequenceId);
      expect(bodyOf(message!)).toContain("{{icebreaker}}");
      expect(message?.subject).toBe("Quick note");
    });

    it("keeps resolving built-ins, aliases and {{name}} on a non-enforced version", async () => {
      const sequenceId = await createSequence("grandfathered-builtins", [{ delayDays: 0, subject: "Hi {{name}}", body: "{{first_name}} / {{company_name}} / {{unknown}}" }]);
      await grandfather(sequenceId);
      const lead = await createContact("Ada");
      await db.update(schema.contacts).set({ company: "Engine Co" }).where(eq(schema.contacts.id, lead.id));
      const campaignId = await createCampaign(sequenceId, await createListWith([lead.id]));
      await runOperation(operation("campaigns.launch"), context(), { id: campaignId });
      const [message] = await messagesFor(sequenceId);
      expect(message?.subject).toBe("Hi Ada");
      expect(bodyOf(message!)).toContain("Ada / Engine Co / {{unknown}}");
    });

    it("never cancels queued mail when a value is cleared on a non-enforced version", async () => {
      const sequenceId = await createSequence("grandfathered-clear");
      await grandfather(sequenceId);
      const lead = await createContact("grandfathered-clear");
      const campaignId = await createCampaign(sequenceId, await createListWith([lead.id]));
      await runOperation(operation("campaigns.launch"), context(), { id: campaignId });
      const [before] = await messagesFor(sequenceId);
      const result = await setVariables(sequenceId, lead.id, { icebreaker: "Added later" });
      expect(result).toMatchObject({ rerendered: 0, stillMissing: [] });
      await setVariables(sequenceId, lead.id, { icebreaker: null });
      const [after] = await messagesFor(sequenceId);
      expect(after).toMatchObject({ id: before!.id, status: "scheduled", subject: before!.subject });
      expect(bodyOf(after!)).toBe(bodyOf(before!));
      expect((await enrollmentsFor(sequenceId))[0]).toMatchObject({ status: "scheduled", stopReason: null });
      expect(await stagedFor(sequenceId)).toHaveLength(0);
    });

    it("enforces a version created after the grandfathered one", async () => {
      const sequenceId = await createSequence("republished");
      await grandfather(sequenceId);
      // Editing a live sequence writes a new version row without an explicit flag.
      const versionId = randomUUID();
      await db.insert(schema.sequenceVersions).values({ id: versionId, workspaceId, sequenceId, version: 2, status: "active" });
      await db.insert(schema.sequenceSteps).values({ id: randomUUID(), workspaceId, sequenceVersionId: versionId, stepOrder: 1, delayDays: 0, subject: "S", bodyText: "{{icebreaker}}" });
      await db.update(schema.sequences).set({ currentVersionId: versionId }).where(eq(schema.sequences.id, sequenceId));
      expect(await sequenceRequiredVariables(db, workspaceId, sequenceId)).toEqual(["icebreaker"]);
    });
  });

  describe("cleared values never send the old text", () => {
    it("cancels the queued message and enrollment, stages the lead, and re-enrolls it when the value returns", async () => {
      const { sequenceId, lead, campaignId } = await launchedLead("clear-first");
      const [enrollment] = await enrollmentsFor(sequenceId);
      const [queued] = await messagesFor(sequenceId);
      expect(bodyOf(queued!)).toContain("Old line");
      expect(await campaignStatus(campaignId)).toBe("active");
      expect(await contactStatus(lead.id)).toBe("enrolled");

      const cleared = await setVariables(sequenceId, lead.id, { icebreaker: null });
      expect(cleared.stillMissing).toEqual([{ email: lead.email, missing: ["icebreaker"] }]);
      const [cancelled] = await messagesFor(sequenceId);
      expect(cancelled).toMatchObject({ id: queued!.id, status: "cancelled", blockedReason: "missing_variables" });
      expect(cancelled?.idempotencyKey).not.toBe(queued!.idempotencyKey);
      expect((await enrollmentsFor(sequenceId))[0]).toMatchObject({ id: enrollment!.id, status: "cancelled", stopReason: "missing_variables", nextDueAt: null });
      expect(await contactStatus(lead.id)).toBe("active");
      expect(await campaignStatus(campaignId)).toBe("completed");
      expect(await stagedFor(sequenceId)).toMatchObject([{ leadId: lead.id, campaignId, inboxIds: [mailboxId] }]);

      // The value returns: the same enrollment is revived with a fresh message carrying the new text.
      const restored = await setVariables(sequenceId, lead.id, { icebreaker: "New line" });
      expect(restored).toMatchObject({ enrolled: 1, stillMissing: [] });
      const enrollments = await enrollmentsFor(sequenceId);
      expect(enrollments).toHaveLength(1);
      expect(enrollments[0]).toMatchObject({ id: enrollment!.id, status: "scheduled", stopReason: null, stoppedAt: null });
      const messages = await messagesFor(sequenceId);
      expect(messages).toHaveLength(2);
      const fresh = messages.find((message) => message.status === "scheduled")!;
      expect(fresh.idempotencyKey).toBe(`${enrollment!.id}:1`);
      expect(bodyOf(fresh)).toContain("New line");
      expect(bodyOf(fresh)).not.toContain("Old line");
      expect(await stagedFor(sequenceId)).toHaveLength(0);
      expect(await campaignStatus(campaignId)).toBe("active");
      expect(await contactStatus(lead.id)).toBe("enrolled");
    });

    it("applies to lead-level custom fields cleared through leads.import", async () => {
      const sequenceId = await createSequence("clear-field");
      const lead = await createContact("clear-field", { customFields: { icebreaker: "Field line" } });
      const campaignId = await createCampaign(sequenceId, await createListWith([lead.id]));
      await runOperation(operation("campaigns.launch"), context(), { id: campaignId });
      await runOperation(operation("leads.import"), context(), { leads: [{ email: lead.email, customFields: { icebreaker: null } }] });
      expect((await messagesFor(sequenceId))[0]).toMatchObject({ status: "cancelled", blockedReason: "missing_variables" });
      expect((await enrollmentsFor(sequenceId))[0]).toMatchObject({ status: "cancelled", stopReason: "missing_variables" });
      expect(await stagedFor(sequenceId)).toHaveLength(1);

      const back = await runOperation(operation("leads.import"), context(), { leads: [{ email: lead.email, customFields: { icebreaker: "Fresh field line" } }] });
      expect(back).toMatchObject({ customFieldsRefresh: { enrolledWaiting: 1 } });
      expect((await enrollmentsFor(sequenceId))[0]).toMatchObject({ status: "scheduled", stopReason: null });
      expect((await messagesFor(sequenceId)).filter((message) => message.status === "scheduled").map(bodyOf).join()).toContain("Fresh field line");
    });

    it("resumes a follow-up at the step the lead has not received, on the same mailbox, without resending step one", async () => {
      const steps = [{ delayDays: 0, subject: "One", body: "Hi {{firstName}}" }, { delayDays: 2, subject: "Two", body: "{{icebreaker}}" }];
      const { sequenceId, lead } = await launchedLead("clear-followup", steps);
      const [enrollment] = await enrollmentsFor(sequenceId);
      const [first] = await messagesFor(sequenceId);
      const [stepTwo] = await db.select().from(schema.sequenceSteps).where(and(eq(schema.sequenceSteps.sequenceVersionId, enrollment!.sequenceVersionId), eq(schema.sequenceSteps.stepOrder, 2)));
      // The worker's state after step one was accepted and step two was queued.
      await db.update(schema.messages).set({ status: "accepted", acceptedAt: new Date() }).where(eq(schema.messages.id, first!.id));
      const dueAt = new Date(Date.now() + 2 * 86_400_000);
      const followUpId = randomUUID();
      await db.insert(schema.messages).values({ id: followUpId, workspaceId, enrollmentId: enrollment!.id, sequenceStepId: stepTwo!.id, emailAccountId: mailboxId, contactId: lead.id, status: "scheduled", idempotencyKey: `${enrollment!.id}:2`, scheduledAt: dueAt, recipientEmail: lead.email, normalizedRecipientEmail: lead.email, subject: "Two", bodyHash: "x", metadata: { bodyText: "Old line", sequenceStepOrder: 2, unsubscribeUrl: (first!.metadata as { unsubscribeUrl: string }).unsubscribeUrl } });
      await db.update(schema.enrollments).set({ status: "active", nextStepOrder: 2, nextDueAt: dueAt }).where(eq(schema.enrollments.id, enrollment!.id));

      await setVariables(sequenceId, lead.id, { icebreaker: null });
      const afterClear = await messagesFor(sequenceId);
      expect(afterClear.find((message) => message.id === first!.id)).toMatchObject({ status: "accepted" });
      expect(afterClear.find((message) => message.id === followUpId)).toMatchObject({ status: "cancelled", blockedReason: "missing_variables" });
      expect((await enrollmentsFor(sequenceId))[0]).toMatchObject({ status: "cancelled", stopReason: "missing_variables" });

      await setVariables(sequenceId, lead.id, { icebreaker: "Second line" });
      const [revived] = await enrollmentsFor(sequenceId);
      expect(revived).toMatchObject({ id: enrollment!.id, status: "active", nextStepOrder: 2, stopReason: null, emailAccountId: mailboxId });
      const messages = await messagesFor(sequenceId);
      expect(messages.filter((message) => message.stepOrder === 1)).toHaveLength(1);
      const stepTwoMessages = messages.filter((message) => message.stepOrder === 2);
      expect(stepTwoMessages).toHaveLength(2);
      const fresh = stepTwoMessages.find((message) => message.status === "scheduled")!;
      expect(bodyOf(fresh)).toContain("Second line");
      // The follow-up keeps its original due time.
      expect(fresh.scheduledAt.getTime()).toBe(dueAt.getTime());
    });

    it("never touches claimed or already-attempted messages", async () => {
      const claimed = await launchedLead("clear-claimed");
      await db.update(schema.messages).set({ status: "claimed", claimExpiresAt: new Date(Date.now() + 60_000) }).where(eq(schema.messages.contactId, claimed.lead.id));
      await setVariables(claimed.sequenceId, claimed.lead.id, { icebreaker: null });
      expect((await messagesFor(claimed.sequenceId))[0]).toMatchObject({ status: "claimed" });
      expect((await enrollmentsFor(claimed.sequenceId))[0]).toMatchObject({ status: "scheduled", stopReason: null });
      expect(await stagedFor(claimed.sequenceId)).toHaveLength(0);

      const attempted = await launchedLead("clear-attempted");
      const [message] = await messagesFor(attempted.sequenceId);
      await db.update(schema.messages).set({ status: "retryable" }).where(eq(schema.messages.id, message!.id));
      await db.insert(schema.sendAttempts).values({ id: randomUUID(), workspaceId, messageId: message!.id, attemptNumber: 1, status: "failed" });
      await setVariables(attempted.sequenceId, attempted.lead.id, { icebreaker: null });
      expect((await messagesFor(attempted.sequenceId))[0]).toMatchObject({ status: "retryable", idempotencyKey: message!.idempotencyKey });
      expect((await enrollmentsFor(attempted.sequenceId))[0]).toMatchObject({ status: "scheduled" });
    });

    it("keeps the lead enrolled while another sequence still has it live", async () => {
      const { sequenceId, lead } = await launchedLead("clear-multi");
      const otherSequenceId = await createSequence("clear-multi-other", [{ delayDays: 0, subject: "Other", body: "Hello {{firstName}}" }]);
      const otherCampaignId = await createCampaign(otherSequenceId, await createListWith([lead.id]));
      await runOperation(operation("campaigns.launch"), context(), { id: otherCampaignId });
      await setVariables(sequenceId, lead.id, { icebreaker: null });
      expect((await enrollmentsFor(sequenceId))[0]).toMatchObject({ status: "cancelled" });
      expect(await contactStatus(lead.id)).toBe("enrolled");
    });

    it("does not count a missing_variables cancellation as an existing enrollment", async () => {
      const { sequenceId, lead, campaignId, listId } = await launchedLead("clear-eligibility");
      await setVariables(sequenceId, lead.id, { icebreaker: null });
      await setVariables(sequenceId, lead.id, { icebreaker: "Back" });
      // Revived, so a normal duplicate again.
      const [sequence] = await db.select({ currentVersionId: schema.sequences.currentVersionId }).from(schema.sequences).where(eq(schema.sequences.id, sequenceId));
      const audience = await findEligibleEnrollmentAudience({ db, workspaceId, sequenceId, campaignId, sequenceVersionId: sequence!.currentVersionId, listIds: [listId] });
      expect(audience.skipped.already_enrolled).toBe(1);
      // A cancelled-for-missing_variables row is not a duplicate; any other cancellation still is.
      await db.update(schema.enrollments).set({ status: "cancelled", stopReason: "missing_variables" }).where(eq(schema.enrollments.sequenceId, sequenceId));
      expect((await findEligibleEnrollmentAudience({ db, workspaceId, sequenceId, campaignId, sequenceVersionId: sequence!.currentVersionId, listIds: [listId] })).eligible).toHaveLength(1);
      await db.update(schema.enrollments).set({ stopReason: "manual" }).where(eq(schema.enrollments.sequenceId, sequenceId));
      expect((await findEligibleEnrollmentAudience({ db, workspaceId, sequenceId, campaignId, sequenceVersionId: sequence!.currentVersionId, listIds: [listId] })).skipped.already_enrolled).toBe(1);
    });
  });

  describe("values written while a campaign is paused", () => {
    it("are kept in the queue and enroll when the campaign resumes", async () => {
      const { sequenceId, lead, listId, campaignId } = await launchedLead("paused");
      const waiting = await createContact("paused-waiting");
      await db.insert(schema.contactListMembers).values({ workspaceId, contactListId: listId, contactId: waiting.id });
      await runOperation(operation("campaigns.pause"), context(), { id: campaignId });

      const written = await setVariables(sequenceId, waiting.id, { icebreaker: "Written while paused" });
      expect(written.enrolled).toBe(0);
      expect((await enrollmentsFor(sequenceId)).map((row) => row.contactId)).toEqual([lead.id]);
      expect(await stagedFor(sequenceId)).toMatchObject([{ leadId: waiting.id, campaignId }]);

      // A still-incomplete lead stays queued too, and resuming leaves it parked.
      const incomplete = await createContact("paused-incomplete");
      await db.insert(schema.contactListMembers).values({ workspaceId, contactListId: listId, contactId: incomplete.id });
      await setVariables(sequenceId, incomplete.id, { other: "unrelated" });
      expect((await stagedFor(sequenceId)).map((row) => row.leadId).sort()).toEqual([incomplete.id, waiting.id].sort());

      await runOperation(operation("campaigns.resume"), context(), { id: campaignId });
      expect((await enrollmentsFor(sequenceId)).map((row) => row.contactId).sort()).toEqual([lead.id, waiting.id].sort());
      expect(await stagedFor(sequenceId)).toMatchObject([{ leadId: incomplete.id }]);
      const resumedMessage = (await messagesFor(sequenceId)).find((message) => message.contactId === waiting.id);
      expect(bodyOf(resumedMessage!)).toContain("Written while paused");
    });
  });

  describe("explicit lead enrolls that skip for missing variables", () => {
    it("wait in the queue and enroll once their values arrive", async () => {
      const sequenceId = await createSequence("explicit");
      const ready = await createContact("explicit-ready");
      await setVariables(sequenceId, ready.id, { icebreaker: "Ready line" });
      await runOperation(operation("sequences.publish"), context(), { id: sequenceId });
      const lead = await createContact("explicit-waiting");

      const result = await runOperation(operation("sequences.enroll"), context(), { id: sequenceId, leadIds: [lead.id, ready.id] });
      expect(result).toMatchObject({ enrolled: 1, skipped: { missing_variables: 1 } });
      expect(await stagedFor(sequenceId)).toMatchObject([{ leadId: lead.id }]);

      const written = await setVariables(sequenceId, lead.id, { icebreaker: "Waited line" });
      expect(written).toMatchObject({ enrolled: 1, stillMissing: [] });
      expect((await enrollmentsFor(sequenceId)).map((row) => row.contactId).sort()).toEqual([lead.id, ready.id].sort());
      expect(await stagedFor(sequenceId)).toHaveLength(0);
    });
  });

  describe("listLeadVariableNames", () => {
    it("scans only the most recently updated contacts", async () => {
      await createContact("old-a", { customFields: { old_only: "x" }, updatedAt: new Date("2020-01-01T00:00:00Z") });
      await createContact("old-b", { customFields: { old_only: "x" }, updatedAt: new Date("2020-01-02T00:00:00Z") });
      await createContact("new-a", { customFields: { recent_one: "x" }, updatedAt: new Date("2026-01-01T00:00:00Z") });
      await createContact("new-b", { customFields: { recent_two: "x" }, updatedAt: new Date("2026-01-02T00:00:00Z") });
      expect(await listLeadVariableNames(db, workspaceId, 2)).toEqual(["recent_one", "recent_two"]);
      expect(await listLeadVariableNames(db, workspaceId)).toEqual(["old_only", "recent_one", "recent_two"]);
    });
  });
});
