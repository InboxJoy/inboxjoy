import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { and, asc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { operationByName, runOperation, type OperationContext } from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;

function operation(name: string) {
  const found = operationByName.get(name);
  if (!found) throw new Error(`Missing operation ${name}`);
  return found;
}

const TWO_STEPS = [{ delayDays: 0, subject: "One", body: "Hi {{firstName}}" }, { delayDays: 2, subject: "Two", body: "{{icebreaker}}" }];

describe.skipIf(!databaseUrl)("lead variables recovery: send history across versions and direct enrollments", () => {
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

  async function createSequence(label: string, steps = TWO_STEPS) {
    const result = await runOperation(operation("sequences.create"), context(), { name: label, steps });
    return result.sequence.id as string;
  }

  async function createContact(label: string, customFields: Record<string, unknown> = {}) {
    const id = randomUUID();
    const email = `rec-${label}-${randomUUID().slice(0, 8)}@example.com`;
    await db.insert(schema.contacts).values({ id, workspaceId, email, normalizedEmail: email, firstName: label, status: "active", customFields });
    return { id, email };
  }

  async function createListWith(contactIds: string[]) {
    const listId = randomUUID();
    await db.insert(schema.contactLists).values({ id: listId, workspaceId, name: `list ${listId.slice(0, 8)}`, createdByUserId: userId });
    await db.insert(schema.contactListMembers).values(contactIds.map((contactId) => ({ workspaceId, contactListId: listId, contactId })));
    return listId;
  }

  function setVariables(sequenceId: string, contactId: string, variables: Record<string, string | null>) {
    return runOperation(operation("campaigns.setLeadVariables"), context(), { sequenceId, leads: [{ contactId, variables }] });
  }

  const enrollmentsFor = (sequenceId: string) => db.select().from(schema.enrollments).where(eq(schema.enrollments.sequenceId, sequenceId));
  const messagesFor = async (sequenceId: string) => {
    const rows = await db.select({ message: schema.messages, stepOrder: schema.sequenceSteps.stepOrder, versionId: schema.sequenceSteps.sequenceVersionId }).from(schema.messages)
      .innerJoin(schema.enrollments, eq(schema.messages.enrollmentId, schema.enrollments.id))
      .innerJoin(schema.sequenceSteps, eq(schema.messages.sequenceStepId, schema.sequenceSteps.id))
      .where(eq(schema.enrollments.sequenceId, sequenceId)).orderBy(asc(schema.messages.createdAt));
    return rows.map((row) => ({ ...row.message, stepOrder: row.stepOrder, versionId: row.versionId }));
  };
  const stagedFor = (sequenceId: string) => db.select().from(schema.stagedEnrollments).where(eq(schema.stagedEnrollments.sequenceId, sequenceId));
  const bodyOf = (message: { metadata: unknown }) => (message.metadata as { bodyText: string }).bodyText;

  // Step one of the lead's only enrollment was accepted by the provider.
  async function acceptStepOne(sequenceId: string) {
    const [enrollment] = await enrollmentsFor(sequenceId);
    const [first] = await messagesFor(sequenceId);
    expect(first?.stepOrder).toBe(1);
    await db.update(schema.messages).set({ status: "accepted", acceptedAt: new Date() }).where(eq(schema.messages.id, first!.id));
    return { enrollment: enrollment!, first: first! };
  }

  // The worker's bookkeeping found step two could not render (value cleared) and stopped the
  // enrollment without writing a message.
  async function workerStopsForMissingValue(enrollmentId: string) {
    await db.update(schema.enrollments).set({ status: "cancelled", nextDueAt: null, stoppedAt: new Date(), stopReason: "missing_variables" }).where(eq(schema.enrollments.id, enrollmentId));
    await db.update(schema.contacts).set({ status: "active" }).where(eq(schema.contacts.workspaceId, workspaceId));
  }

  // Same writes as PATCH /v1/sequences/:id on an active sequence with nothing in progress.
  async function publishNewVersion(sequenceId: string) {
    const versionId = randomUUID();
    await db.insert(schema.sequenceVersions).values({ id: versionId, workspaceId, sequenceId, version: 2, status: "active", launchedAt: new Date() });
    await db.insert(schema.sequenceSteps).values(TWO_STEPS.map((step, index) => ({ id: randomUUID(), workspaceId, sequenceVersionId: versionId, stepOrder: index + 1, delayDays: step.delayDays, subject: `${step.subject} v2`, bodyText: step.body })));
    await db.update(schema.sequences).set({ currentVersionId: versionId }).where(eq(schema.sequences.id, sequenceId));
    return versionId;
  }

  function expectResumedAtStepTwo(messages: Awaited<ReturnType<typeof messagesFor>>, enrollment: { id: string; sequenceVersionId: string }, line: string) {
    // Step one went out exactly once, on any version.
    expect(messages.filter((message) => message.stepOrder === 1)).toHaveLength(1);
    const scheduled = messages.filter((message) => message.status === "scheduled");
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({ enrollmentId: enrollment.id, stepOrder: 2, versionId: enrollment.sequenceVersionId, idempotencyKey: `${enrollment.id}:2` });
    expect(bodyOf(scheduled[0]!)).toContain(line);
  }

  beforeEach(async () => {
    const own = await createWorkspace("lvrec");
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

  async function launchedListLead(label: string, steps = TWO_STEPS) {
    const sequenceId = await createSequence(label, steps);
    const lead = await createContact(label);
    await setVariables(sequenceId, lead.id, { icebreaker: "Old line" });
    const listId = await createListWith([lead.id]);
    const campaign = await runOperation(operation("campaigns.create"), context(), { name: `campaign ${label}`, sequenceId, listIds: [listId], inboxId: mailboxId });
    const campaignId = campaign.campaign.id as string;
    await runOperation(operation("campaigns.launch"), context(), { id: campaignId });
    return { sequenceId, lead, campaignId };
  }

  describe("a cleared value, then a sequence edit, then the value restored", () => {
    it("resumes the queued follow-up on the pinned version without resending step one", async () => {
      const { sequenceId, lead } = await launchedListLead("queued-edit");
      const { enrollment, first } = await acceptStepOne(sequenceId);
      const [stepTwo] = await db.select().from(schema.sequenceSteps).where(and(eq(schema.sequenceSteps.sequenceVersionId, enrollment.sequenceVersionId), eq(schema.sequenceSteps.stepOrder, 2)));
      const dueAt = new Date(Date.now() + 2 * 86_400_000);
      await db.insert(schema.messages).values({ id: randomUUID(), workspaceId, enrollmentId: enrollment.id, sequenceStepId: stepTwo!.id, emailAccountId: mailboxId, contactId: lead.id, status: "scheduled", idempotencyKey: `${enrollment.id}:2`, scheduledAt: dueAt, recipientEmail: lead.email, normalizedRecipientEmail: lead.email, subject: "Two", bodyHash: "x", metadata: { bodyText: "Old line", sequenceStepOrder: 2, unsubscribeUrl: (first.metadata as { unsubscribeUrl: string }).unsubscribeUrl } });
      await db.update(schema.enrollments).set({ status: "active", nextStepOrder: 2, nextDueAt: dueAt }).where(eq(schema.enrollments.id, enrollment.id));

      await setVariables(sequenceId, lead.id, { icebreaker: null });
      expect((await enrollmentsFor(sequenceId))[0]).toMatchObject({ status: "cancelled", stopReason: "missing_variables" });
      await publishNewVersion(sequenceId);

      const restored = await setVariables(sequenceId, lead.id, { icebreaker: "New line" });
      expect(restored).toMatchObject({ enrolled: 1, stillMissing: [] });
      const enrollments = await enrollmentsFor(sequenceId);
      expect(enrollments).toHaveLength(1);
      expect(enrollments[0]).toMatchObject({ id: enrollment.id, sequenceVersionId: enrollment.sequenceVersionId, status: "active", nextStepOrder: 2, stopReason: null, emailAccountId: mailboxId });
      const messages = await messagesFor(sequenceId);
      expectResumedAtStepTwo(messages, enrollment, "New line");
      expect(messages.find((message) => message.status === "scheduled")!.scheduledAt.getTime()).toBe(dueAt.getTime());
      expect(await stagedFor(sequenceId)).toHaveLength(0);
    });

    it("resumes a list lead the worker stopped on the pinned version without resending step one", async () => {
      const { sequenceId, lead } = await launchedListLead("worker-edit");
      const { enrollment } = await acceptStepOne(sequenceId);
      await workerStopsForMissingValue(enrollment.id);
      await publishNewVersion(sequenceId);

      const restored = await setVariables(sequenceId, lead.id, { icebreaker: "New line" });
      expect(restored).toMatchObject({ enrolled: 1, stillMissing: [] });
      const enrollments = await enrollmentsFor(sequenceId);
      expect(enrollments).toHaveLength(1);
      expect(enrollments[0]).toMatchObject({ id: enrollment.id, sequenceVersionId: enrollment.sequenceVersionId, status: "active", nextStepOrder: 2, stopReason: null });
      expectResumedAtStepTwo(await messagesFor(sequenceId), enrollment, "New line");
    });

    it("moves a lead that received nothing to the new version", async () => {
      const { sequenceId, lead } = await launchedListLead("unsent-edit", [{ delayDays: 0, subject: "One", body: "{{icebreaker}}" }, TWO_STEPS[1]!]);
      const [enrollment] = await enrollmentsFor(sequenceId);
      await setVariables(sequenceId, lead.id, { icebreaker: null });
      expect((await enrollmentsFor(sequenceId))[0]).toMatchObject({ status: "cancelled", stopReason: "missing_variables" });
      const newVersionId = await publishNewVersion(sequenceId);

      const restored = await setVariables(sequenceId, lead.id, { icebreaker: "New line" });
      expect(restored).toMatchObject({ enrolled: 1 });
      const enrollments = await enrollmentsFor(sequenceId);
      expect(enrollments).toHaveLength(1);
      expect(enrollments[0]).toMatchObject({ id: enrollment!.id, sequenceVersionId: newVersionId, status: "scheduled", nextStepOrder: 1 });
      const scheduled = (await messagesFor(sequenceId)).filter((message) => message.status === "scheduled");
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0]).toMatchObject({ stepOrder: 1, versionId: newVersionId, subject: "One v2", idempotencyKey: `${enrollment!.id}:1` });
    });
  });

  describe("directly enrolled leads", () => {
    async function directLead(label: string, customFields: Record<string, unknown> = {}) {
      const sequenceId = await createSequence(label);
      const lead = await createContact(label, customFields);
      if (!Object.keys(customFields).length) await setVariables(sequenceId, lead.id, { icebreaker: "Old line" });
      await runOperation(operation("sequences.publish"), context(), { id: sequenceId });
      const enrolled = await runOperation(operation("sequences.enroll"), context(), { id: sequenceId, leadIds: [lead.id] });
      expect(enrolled.enrolled).toBe(1);
      return { sequenceId, lead };
    }

    it("resume their follow-up once a campaign value is restored", async () => {
      const { sequenceId, lead } = await directLead("direct-campaign-value");
      const { enrollment } = await acceptStepOne(sequenceId);
      await workerStopsForMissingValue(enrollment.id);
      await setVariables(sequenceId, lead.id, { icebreaker: null });

      const restored = await setVariables(sequenceId, lead.id, { icebreaker: "Back again" });
      expect(restored).toMatchObject({ enrolled: 1, stillMissing: [] });
      expect((await enrollmentsFor(sequenceId))[0]).toMatchObject({ id: enrollment.id, status: "active", nextStepOrder: 2, stopReason: null });
      expectResumedAtStepTwo(await messagesFor(sequenceId), enrollment, "Back again");
      expect(await stagedFor(sequenceId)).toHaveLength(0);
    });

    it("resume their follow-up once a lead custom field is restored", async () => {
      const { sequenceId, lead } = await directLead("direct-field", { icebreaker: "Field line" });
      const { enrollment } = await acceptStepOne(sequenceId);
      await runOperation(operation("leads.import"), context(), { leads: [{ email: lead.email, customFields: { icebreaker: null } }] });
      await workerStopsForMissingValue(enrollment.id);

      const back = await runOperation(operation("leads.import"), context(), { leads: [{ email: lead.email, customFields: { icebreaker: "Fresh field line" } }] });
      expect(back).toMatchObject({ customFieldsRefresh: { enrolledWaiting: 1 } });
      expect((await enrollmentsFor(sequenceId))[0]).toMatchObject({ id: enrollment.id, status: "active", nextStepOrder: 2, stopReason: null });
      expectResumedAtStepTwo(await messagesFor(sequenceId), enrollment, "Fresh field line");
    });
  });
});
