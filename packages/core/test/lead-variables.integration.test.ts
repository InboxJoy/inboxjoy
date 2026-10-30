import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { appendUnsubscribeFooter } from "@inboxjoy/email";
import { and, eq } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { findEligibleEnrollmentAudience } from "../src/enrollment-eligibility.js";
import { operationByName, runOperation, type OperationContext } from "../src/index.js";
import {
  findLeadsMissingVariables,
  loadLeadVariables,
  rerenderQueuedMessages,
  sequenceRequiredVariables,
  upsertLeadVariables,
} from "../src/lead-variables.js";

const databaseUrl = process.env.DATABASE_URL;

function operation(name: string) {
  const found = operationByName.get(name);
  if (!found) throw new Error(`Missing operation ${name}`);
  return found;
}

describe.skipIf(!databaseUrl)("per-lead campaign variables", () => {
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);
  const authSecret = "lead-variables-test-auth-secret-at-least-32-chars";
  let userId = "";
  let workspaceId = "";
  let mailboxId = "";
  let foreignUserId = "";
  let foreignWorkspaceId = "";
  const cleanupWorkspaces: string[] = [];

  function context(): OperationContext {
    return { db, workspaceId, userId, env: { edition: "selfhost", authSecret, apiBaseUrl: "https://api.example.test" } };
  }

  async function createWorkspace(label: string) {
    const newUserId = randomUUID();
    const newWorkspaceId = randomUUID();
    const newMailboxId = randomUUID();
    const suffix = randomUUID().slice(0, 8);
    await db.insert(schema.authUsers).values({ id: newUserId, name: label, email: `${label}-user-${suffix}@example.com`, emailVerified: true });
    await db.insert(schema.users).values({ id: newUserId, email: `${label}-user-${suffix}@example.com`, normalizedEmail: `${label}-user-${suffix}@example.com`, displayName: label });
    await db.insert(schema.workspaces).values({ id: newWorkspaceId, name: `${label} ${suffix}`, slug: `${label}-${suffix}`, createdByUserId: newUserId, postalAddress: "1 Test Way\nAustin, TX 78701" });
    await db.insert(schema.memberships).values({ id: randomUUID(), workspaceId: newWorkspaceId, userId: newUserId, role: "owner", status: "active", joinedAt: new Date() });
    await db.insert(schema.emailAccounts).values({ id: newMailboxId, workspaceId: newWorkspaceId, userId: newUserId, provider: "gmail", composioConnectedAccountId: `${label}-${suffix}`, email: `${label}-mailbox-${suffix}@example.com`, normalizedEmail: `${label}-mailbox-${suffix}@example.com`, alias: `${label}-${suffix}`, status: "active" });
    return { userId: newUserId, workspaceId: newWorkspaceId, mailboxId: newMailboxId };
  }

  async function createContact(label: string, options: { ws?: string; status?: string; customFields?: Record<string, unknown>; firstName?: string } = {}) {
    const contactId = randomUUID();
    const email = `${label}-${randomUUID().slice(0, 8)}@example.com`;
    await db.insert(schema.contacts).values({ id: contactId, workspaceId: options.ws ?? workspaceId, email, normalizedEmail: email, firstName: options.firstName ?? "Ada", status: options.status ?? "active", customFields: options.customFields ?? {} });
    return { id: contactId, email };
  }

  async function createSequence(subject: string, bodyText: string, options: { ws?: string; status?: "active" | "draft" } = {}) {
    const ws = options.ws ?? workspaceId;
    const owner = ws === workspaceId ? userId : foreignUserId;
    const sequenceId = randomUUID();
    const versionId = randomUUID();
    const stepId = randomUUID();
    await db.insert(schema.sequences).values({ id: sequenceId, workspaceId: ws, name: `Seq ${sequenceId.slice(0, 6)}`, status: options.status ?? "active", createdByUserId: owner });
    await db.insert(schema.sequenceVersions).values({ id: versionId, workspaceId: ws, sequenceId, version: 1, status: "active", snapshot: {}, launchedAt: new Date(), createdByUserId: owner });
    await db.update(schema.sequences).set({ currentVersionId: versionId }).where(eq(schema.sequences.id, sequenceId));
    await db.insert(schema.sequenceSteps).values({ id: stepId, workspaceId: ws, sequenceVersionId: versionId, stepOrder: 1, delayDays: 1, subject, bodyText });
    return { sequenceId, versionId, stepId };
  }

  async function createList(label = "Audience") {
    const listId = randomUUID();
    await db.insert(schema.contactLists).values({ id: listId, workspaceId, name: `${label} ${listId.slice(0, 8)}`, createdByUserId: userId });
    return listId;
  }

  async function addToList(listId: string, contactId: string) {
    await db.insert(schema.contactListMembers).values({ workspaceId, contactListId: listId, contactId });
  }

  async function createCampaign(sequenceId: string, listId: string | null, status: "draft" | "active" | "paused" | "completed" = "active") {
    const campaignId = randomUUID();
    await db.insert(schema.campaigns).values({ id: campaignId, workspaceId, sequenceId, emailAccountId: mailboxId, name: `Campaign ${campaignId.slice(0, 6)}`, status, contactListId: listId, launchedAt: status === "draft" ? null : new Date(), createdByUserId: userId });
    if (listId) await db.insert(schema.campaignContactLists).values({ campaignId, contactListId: listId, workspaceId });
    return campaignId;
  }

  async function variablesRow(sequenceId: string, contactId: string) {
    const [row] = await db.select().from(schema.campaignLeadVariables).where(and(eq(schema.campaignLeadVariables.sequenceId, sequenceId), eq(schema.campaignLeadVariables.contactId, contactId)));
    return row?.values;
  }

  async function enrollmentsFor(sequenceId: string, contactId?: string) {
    return db.select().from(schema.enrollments).where(contactId ? and(eq(schema.enrollments.sequenceId, sequenceId), eq(schema.enrollments.contactId, contactId)) : eq(schema.enrollments.sequenceId, sequenceId));
  }

  async function queuedMessage(sequenceId: string, contactId: string, stepId: string, versionId: string, campaignId: string | null, body: string, subject: string, status: "scheduled" | "retryable" | "claimed" = "scheduled") {
    const enrollmentId = randomUUID();
    const [contact] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId));
    await db.insert(schema.enrollments).values({ id: enrollmentId, workspaceId, contactId, sequenceId, sequenceVersionId: versionId, campaignId, emailAccountId: mailboxId, status: "scheduled", nextStepOrder: 1, nextDueAt: new Date(Date.now() + 86_400_000) });
    const unsubscribeUrl = `https://api.example.test/v1/unsubscribe?token=${randomUUID()}`;
    const bodyText = appendUnsubscribeFooter(body, unsubscribeUrl, "1 Test Way\nAustin, TX 78701");
    const messageId = randomUUID();
    await db.insert(schema.messages).values({ id: messageId, workspaceId, enrollmentId, sequenceStepId: stepId, emailAccountId: mailboxId, contactId, status, idempotencyKey: `${enrollmentId}:1`, scheduledAt: new Date(Date.now() + 86_400_000), recipientEmail: contact!.email, normalizedRecipientEmail: contact!.normalizedEmail, subject, bodyHash: createHash("sha256").update(bodyText).digest("hex"), metadata: { bodyText, sequenceStepOrder: 1, unsubscribeUrl } });
    return { messageId, unsubscribeUrl };
  }

  async function messageRow(messageId: string) {
    const [row] = await db.select().from(schema.messages).where(eq(schema.messages.id, messageId));
    return row!;
  }

  beforeAll(async () => {
    await pool.query("select 1");
  });

  beforeEach(async () => {
    const own = await createWorkspace("lv");
    userId = own.userId;
    workspaceId = own.workspaceId;
    mailboxId = own.mailboxId;
    const foreign = await createWorkspace("lvforeign");
    foreignUserId = foreign.userId;
    foreignWorkspaceId = foreign.workspaceId;
    cleanupWorkspaces.push(workspaceId, foreignWorkspaceId);
  });

  afterEach(async () => {
    for (const id of cleanupWorkspaces.splice(0)) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, id));
    for (const id of [userId, foreignUserId]) {
      await db.delete(schema.users).where(eq(schema.users.id, id));
      await db.delete(schema.authUsers).where(eq(schema.authUsers.id, id));
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  describe("storage helpers", () => {
    it("merges values, deletes keys with null, and validates names", async () => {
      const { sequenceId } = await createSequence("Hi {{firstName}}", "{{icebreaker}} {{hook}}");
      const contact = await createContact("merge");
      await db.transaction((tx) => upsertLeadVariables(tx, workspaceId, sequenceId, [{ contactId: contact.id, variables: { icebreaker: "  Loved your talk\n", hook: "A" } }]));
      expect(await variablesRow(sequenceId, contact.id)).toEqual({ icebreaker: "Loved your talk", hook: "A" });

      const merged = await db.transaction((tx) => upsertLeadVariables(tx, workspaceId, sequenceId, [{ contactId: contact.id, variables: { hook: "B", other: "C" } }]));
      expect(merged).toMatchObject({ updated: 1, contactIds: [contact.id] });
      expect(await variablesRow(sequenceId, contact.id)).toEqual({ icebreaker: "Loved your talk", hook: "B", other: "C" });

      await db.transaction((tx) => upsertLeadVariables(tx, workspaceId, sequenceId, [{ contactId: contact.id, variables: { other: null, hook: "   " } }]));
      expect(await variablesRow(sequenceId, contact.id)).toEqual({ icebreaker: "Loved your talk" });
      const loaded = await loadLeadVariables(db, workspaceId, sequenceId, [contact.id]);
      expect(loaded.get(contact.id)).toEqual({ icebreaker: "Loved your talk" });

      await expect(db.transaction((tx) => upsertLeadVariables(tx, workspaceId, sequenceId, [{ contactId: contact.id, variables: { firstName: "x" } }]))).rejects.toThrow(/built-in/);
      await expect(db.transaction((tx) => upsertLeadVariables(tx, workspaceId, sequenceId, [{ contactId: contact.id, variables: { "bad name": "x" } }]))).rejects.toThrow(/invalid/);
      await expect(db.transaction((tx) => upsertLeadVariables(tx, workspaceId, sequenceId, [{ contactId: contact.id, variables: { "1abc": "x" } }]))).rejects.toThrow(/invalid/);
      expect(await variablesRow(sequenceId, contact.id)).toEqual({ icebreaker: "Loved your talk" });
    });

    it("computes required variables and per-lead gaps with campaign values before lead custom fields", async () => {
      const { sequenceId } = await createSequence("About {{company}} {{topic}}", "Hi {{firstName}} {{icebreaker}}");
      expect(await sequenceRequiredVariables(db, workspaceId, sequenceId)).toEqual(["icebreaker", "topic"]);
      const noFields = await createContact("gap-none");
      const fieldOnly = await createContact("gap-field", { customFields: { topic: "pricing", icebreaker: "from field" } });
      const complete = await createContact("gap-complete", { customFields: { topic: "pricing" } });
      await db.transaction((tx) => upsertLeadVariables(tx, workspaceId, sequenceId, [
        { contactId: noFields.id, variables: { topic: "x" } },
        { contactId: complete.id, variables: { icebreaker: "campaign line" } },
      ]));
      const missing = await findLeadsMissingVariables(db, workspaceId, sequenceId, [noFields.id, fieldOnly.id, complete.id]);
      expect([...missing.entries()]).toEqual([[noFields.id, ["icebreaker"]]]);
      expect(await findLeadsMissingVariables(db, foreignWorkspaceId, sequenceId, [noFields.id])).toEqual(new Map());
    });
  });

  describe("campaigns.setLeadVariables", () => {
    it("accepts exactly one of campaignId or sequenceId and resolves campaigns to their sequence", async () => {
      const op = operation("campaigns.setLeadVariables");
      expect(op.access).toBe("write");
      const lead = { email: "x@example.com", variables: { a: "b" } };
      expect(op.inputSchema.safeParse({ leads: [lead] }).success).toBe(false);
      expect(op.inputSchema.safeParse({ campaignId: randomUUID(), sequenceId: randomUUID(), leads: [lead] }).success).toBe(false);
      expect(op.inputSchema.safeParse({ sequenceId: randomUUID(), leads: [{ variables: {} }] }).success).toBe(false);
      expect(op.inputSchema.safeParse({ sequenceId: randomUUID(), leads: Array.from({ length: 1001 }, () => lead) }).success).toBe(false);

      const { sequenceId } = await createSequence("Hi", "{{icebreaker}}");
      const campaignId = await createCampaign(sequenceId, null, "draft");
      const contact = await createContact("resolve");
      const viaCampaign = await runOperation(op, context(), { campaignId, leads: [{ email: contact.email.toUpperCase(), variables: { icebreaker: "One" } }, { email: "nobody@example.com", variables: { icebreaker: "x" } }] });
      expect(viaCampaign).toMatchObject({ sequenceId, updated: 1, notFound: ["nobody@example.com"], enrolled: 0, rerendered: 0, stillMissing: [] });
      const viaSequence = await runOperation(op, context(), { sequenceId, leads: [{ contactId: contact.id, variables: { extra: "Two" } }] });
      expect(viaSequence).toMatchObject({ sequenceId, updated: 1, notFound: [] });
      expect(await variablesRow(sequenceId, contact.id)).toEqual({ icebreaker: "One", extra: "Two" });
    });

    it("reports leads that still miss variables", async () => {
      const { sequenceId } = await createSequence("{{hook}}", "{{icebreaker}}");
      const contact = await createContact("still-missing");
      const result = await runOperation(operation("campaigns.setLeadVariables"), context(), { sequenceId, leads: [{ contactId: contact.id, variables: { hook: "H" } }] });
      expect(result.stillMissing).toEqual([{ email: contact.email, missing: ["icebreaker"] }]);
    });

    it("rejects invalid or built-in variable names before writing anything", async () => {
      const { sequenceId } = await createSequence("Hi", "{{icebreaker}}");
      const contact = await createContact("bad-names");
      await expect(runOperation(operation("campaigns.setLeadVariables"), context(), { sequenceId, leads: [{ contactId: contact.id, variables: { icebreaker: "ok", company: "Nope" } }] })).rejects.toMatchObject({ code: "BAD_INPUT" });
      expect(await variablesRow(sequenceId, contact.id)).toBeUndefined();
    });

    it("never reads or writes another workspace's sequence, campaign or contacts", async () => {
      const foreignSequence = await createSequence("Hi", "{{icebreaker}}", { ws: foreignWorkspaceId });
      const foreignContact = await createContact("foreign-lead", { ws: foreignWorkspaceId });
      const own = await createSequence("Hi", "{{icebreaker}}");
      const ownContact = await createContact("own-lead");
      const op = operation("campaigns.setLeadVariables");

      await expect(runOperation(op, context(), { sequenceId: foreignSequence.sequenceId, leads: [{ contactId: ownContact.id, variables: { icebreaker: "x" } }] })).rejects.toMatchObject({ code: "NOT_FOUND" });
      const foreignCampaignId = randomUUID();
      await db.insert(schema.campaigns).values({ id: foreignCampaignId, workspaceId: foreignWorkspaceId, sequenceId: foreignSequence.sequenceId, emailAccountId: (await db.select({ id: schema.emailAccounts.id }).from(schema.emailAccounts).where(eq(schema.emailAccounts.workspaceId, foreignWorkspaceId)))[0]!.id, name: "Foreign", status: "draft" });
      await expect(runOperation(op, context(), { campaignId: foreignCampaignId, leads: [{ contactId: ownContact.id, variables: { icebreaker: "x" } }] })).rejects.toMatchObject({ code: "NOT_FOUND" });

      const result = await runOperation(op, context(), { sequenceId: own.sequenceId, leads: [{ contactId: foreignContact.id, variables: { icebreaker: "leak" } }, { email: foreignContact.email, variables: { icebreaker: "leak" } }] });
      expect(result).toMatchObject({ updated: 0, notFound: [foreignContact.id, foreignContact.email] });
      expect(await variablesRow(own.sequenceId, foreignContact.id)).toBeUndefined();
      expect(await variablesRow(foreignSequence.sequenceId, ownContact.id)).toBeUndefined();
      expect(await variablesRow(foreignSequence.sequenceId, foreignContact.id)).toBeUndefined();

      // The storage helper ignores contacts outside the workspace as well.
      await db.transaction((tx) => upsertLeadVariables(tx, workspaceId, own.sequenceId, [{ contactId: foreignContact.id, variables: { icebreaker: "leak" } }]));
      expect(await variablesRow(own.sequenceId, foreignContact.id)).toBeUndefined();
      await expect(db.transaction((tx) => upsertLeadVariables(tx, workspaceId, foreignSequence.sequenceId, [{ contactId: ownContact.id, variables: { icebreaker: "x" } }]))).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("enrolls waiting audience leads in a live campaign as soon as their values are written", async () => {
      const { sequenceId } = await createSequence("Hi {{firstName}}", "{{icebreaker}}");
      const listId = await createList();
      const campaignId = await createCampaign(sequenceId, listId, "active");
      const waiting = await createContact("waiting");
      const outsider = await createContact("outsider");
      await addToList(listId, waiting.id);

      // Auto-enrollment skips the lead while its line is missing.
      const attempt = await runOperation(operation("sequences.enroll"), context(), { id: sequenceId, leadIds: [waiting.id], campaignId });
      expect(attempt).toMatchObject({ enrolled: 0, skipped: { missing_variables: 1 } });
      expect(attempt.skippedLeadIds.missing_variables).toEqual([waiting.id]);
      expect(await enrollmentsFor(sequenceId)).toHaveLength(0);

      const result = await runOperation(operation("campaigns.setLeadVariables"), context(), { campaignId, leads: [
        { contactId: waiting.id, variables: { icebreaker: "Congrats on the launch" } },
        { contactId: outsider.id, variables: { icebreaker: "Not in the list" } },
      ] });
      expect(result).toMatchObject({ sequenceId, updated: 2, enrolled: 1, stillMissing: [] });
      const enrolled = await enrollmentsFor(sequenceId);
      expect(enrolled.map((row) => row.contactId)).toEqual([waiting.id]);
      expect(enrolled[0]).toMatchObject({ campaignId });

      const [message] = await db.select().from(schema.messages).where(eq(schema.messages.enrollmentId, enrolled[0]!.id));
      expect(message).toBeDefined();

      const again = await runOperation(operation("campaigns.setLeadVariables"), context(), { campaignId, leads: [{ contactId: waiting.id, variables: { icebreaker: "Updated" } }] });
      expect(again).toMatchObject({ enrolled: 0 });
      expect(await enrollmentsFor(sequenceId)).toHaveLength(1);
    });

    it("leaves leads waiting when the campaign is a draft", async () => {
      const { sequenceId } = await createSequence("Hi", "{{icebreaker}}");
      const listId = await createList();
      await createCampaign(sequenceId, listId, "draft");
      const contact = await createContact("draft-waiting");
      await addToList(listId, contact.id);
      const result = await runOperation(operation("campaigns.setLeadVariables"), context(), { sequenceId, leads: [{ contactId: contact.id, variables: { icebreaker: "x" } }] });
      expect(result).toMatchObject({ enrolled: 0, updated: 1 });
      expect(await enrollmentsFor(sequenceId)).toHaveLength(0);
    });

    it("re-renders queued, never-attempted messages and keeps the unsubscribe footer", async () => {
      const { sequenceId, versionId, stepId } = await createSequence("Hi {{firstName}} {{hook}}", "{{icebreaker}} -- bye {{firstName}}");
      const contact = await createContact("rerender");
      const { messageId, unsubscribeUrl } = await queuedMessage(sequenceId, contact.id, stepId, versionId, null, "OLD LINE -- bye Ada", "Hi Ada OLD");
      const result = await runOperation(operation("campaigns.setLeadVariables"), context(), { sequenceId, leads: [{ contactId: contact.id, variables: { icebreaker: "Loved the keynote", hook: "NEW" } }] });
      expect(result).toMatchObject({ rerendered: 1, stillMissing: [] });
      const row = await messageRow(messageId);
      const expectedBody = appendUnsubscribeFooter("Loved the keynote -- bye Ada", unsubscribeUrl, "1 Test Way\nAustin, TX 78701");
      expect(row.subject).toBe("Hi Ada NEW");
      expect((row.metadata as { bodyText: string; unsubscribeUrl: string }).bodyText).toBe(expectedBody);
      expect((row.metadata as { unsubscribeUrl: string }).unsubscribeUrl).toBe(unsubscribeUrl);
      expect(row.bodyHash).toBe(createHash("sha256").update(expectedBody).digest("hex"));
      expect(expectedBody).toContain(`Unsubscribe: ${unsubscribeUrl}`);
    });

    it("leaves attempted, claimed and still-incomplete messages untouched", async () => {
      const { sequenceId, versionId, stepId } = await createSequence("Hi", "{{icebreaker}} {{hook}}");
      const attempted = await createContact("attempted");
      const claimed = await createContact("claimed");
      const incomplete = await createContact("incomplete");
      const a = await queuedMessage(sequenceId, attempted.id, stepId, versionId, null, "old", "Hi", "retryable");
      const c = await queuedMessage(sequenceId, claimed.id, stepId, versionId, null, "old", "Hi", "claimed");
      const i = await queuedMessage(sequenceId, incomplete.id, stepId, versionId, null, "old", "Hi");
      await db.insert(schema.sendAttempts).values({ id: randomUUID(), workspaceId, messageId: a.messageId, attemptNumber: 1, status: "retryable", startedAt: new Date() });
      const before = await Promise.all([a, c, i].map((item) => messageRow(item.messageId)));
      const result = await runOperation(operation("campaigns.setLeadVariables"), context(), { sequenceId, leads: [
        { contactId: attempted.id, variables: { icebreaker: "x", hook: "y" } },
        { contactId: claimed.id, variables: { icebreaker: "x", hook: "y" } },
        { contactId: incomplete.id, variables: { icebreaker: "x" } },
      ] });
      expect(result.rerendered).toBe(0);
      expect(result.stillMissing).toEqual([{ email: incomplete.email, missing: ["hook"] }]);
      const after = await Promise.all([a, c, i].map((item) => messageRow(item.messageId)));
      expect(after.map((row) => row.bodyHash)).toEqual(before.map((row) => row.bodyHash));
      expect(after.map((row) => row.subject)).toEqual(before.map((row) => row.subject));
    });

    it("skips rows locked by another transaction", async () => {
      const { sequenceId, versionId, stepId } = await createSequence("Hi", "{{icebreaker}}");
      const contact = await createContact("locked");
      const { messageId } = await queuedMessage(sequenceId, contact.id, stepId, versionId, null, "old", "Hi");
      await db.insert(schema.campaignLeadVariables).values({ sequenceId, contactId: contact.id, workspaceId, values: { icebreaker: "fresh" } });
      const blocker = await pool.connect();
      try {
        await blocker.query("begin");
        await blocker.query("select id from messages where id = $1 for update", [messageId]);
        const count = await db.transaction((tx) => rerenderQueuedMessages(tx, workspaceId, sequenceId, [contact.id]));
        expect(count).toBe(0);
      } finally {
        await blocker.query("rollback");
        blocker.release();
      }
      expect(await db.transaction((tx) => rerenderQueuedMessages(tx, workspaceId, sequenceId, [contact.id]))).toBe(1);
    });
  });

  describe("multi-campaign eligibility", () => {
    it("lets a lead active in one sequence join another, and skips only same-sequence duplicates", async () => {
      const first = await createSequence("Hi {{firstName}}", "A");
      const second = await createSequence("Hi {{firstName}}", "B");
      const contact = await createContact("multi", { status: "enrolled" });
      await db.insert(schema.enrollments).values({ id: randomUUID(), workspaceId, contactId: contact.id, sequenceId: first.sequenceId, sequenceVersionId: first.versionId, emailAccountId: mailboxId, status: "active", nextStepOrder: 1 });

      const other = await findEligibleEnrollmentAudience({ db, workspaceId, sequenceId: second.sequenceId, sequenceVersionId: second.versionId, leadIds: [contact.id] });
      expect(other.eligible.map((lead) => lead.id)).toEqual([contact.id]);
      expect(other.skipped).toEqual({ suppressed: 0, already_enrolled: 0, replied: 0, bounced: 0, unsubscribed: 0, missing_variables: 0 });

      const same = await findEligibleEnrollmentAudience({ db, workspaceId, sequenceId: first.sequenceId, sequenceVersionId: first.versionId, leadIds: [contact.id] });
      expect(same.eligible).toEqual([]);
      expect(same.skipped.already_enrolled).toBe(1);
      expect(same.skippedLeadIds.already_enrolled).toEqual([contact.id]);

      const real = await runOperation(operation("sequences.enroll"), context(), { id: second.sequenceId, leadIds: [contact.id], inboxId: mailboxId });
      expect(real).toMatchObject({ enrolled: 1 });
      expect(await enrollmentsFor(first.sequenceId, contact.id)).toHaveLength(1);
      expect(await enrollmentsFor(second.sequenceId, contact.id)).toHaveLength(1);
    });

    it("still skips suppressed, replied, bounced and unsubscribed leads", async () => {
      const seq = await createSequence("Hi", "A");
      const leads = await Promise.all(["suppressed", "replied", "bounced", "unsubscribed"].map((status) => createContact(`status-${status}`, { status })));
      const result = await findEligibleEnrollmentAudience({ db, workspaceId, sequenceId: seq.sequenceId, sequenceVersionId: seq.versionId, leadIds: leads.map((lead) => lead.id) });
      expect(result.eligible).toEqual([]);
      expect(result.skipped).toMatchObject({ suppressed: 1, replied: 1, bounced: 1, unsubscribed: 1, already_enrolled: 0, missing_variables: 0 });
    });

    it("skips leads missing custom variables with the missing_variables reason", async () => {
      const seq = await createSequence("Hi {{firstName}}", "{{icebreaker}}");
      const complete = await createContact("elig-complete", { customFields: { icebreaker: "from lead field" } });
      const viaCampaign = await createContact("elig-campaign");
      const missing = await createContact("elig-missing");
      await db.transaction((tx) => upsertLeadVariables(tx, workspaceId, seq.sequenceId, [{ contactId: viaCampaign.id, variables: { icebreaker: "campaign line" } }]));
      const result = await findEligibleEnrollmentAudience({ db, workspaceId, sequenceId: seq.sequenceId, sequenceVersionId: seq.versionId, leadIds: [complete.id, viaCampaign.id, missing.id] });
      expect(new Set(result.eligible.map((lead) => lead.id))).toEqual(new Set([complete.id, viaCampaign.id]));
      expect(result.skipped.missing_variables).toBe(1);
      expect(result.skippedLeadIds.missing_variables).toEqual([missing.id]);
    });
  });

  describe("leads.import", () => {
    it("merges customFields into new and existing leads and keeps internal keys", async () => {
      const existing = await createContact("import-existing", { customFields: { internalFlag: "keep", stale: "old", topic: "before" } });
      const newEmail = `import-new-${randomUUID().slice(0, 8)}@example.com`;
      const result = await runOperation(operation("leads.import"), context(), { leads: [
        { email: existing.email, customFields: { topic: "after", stale: null } },
        { email: newEmail, firstName: "Grace", customFields: { topic: "fresh", blank: "  " } },
      ] });
      expect(result).toMatchObject({ imported: 1, updated: 1 });
      const [updated] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, existing.id));
      expect(updated!.customFields).toEqual({ internalFlag: "keep", topic: "after" });
      const [created] = await db.select().from(schema.contacts).where(and(eq(schema.contacts.workspaceId, workspaceId), eq(schema.contacts.normalizedEmail, newEmail)));
      expect(created!.customFields).toEqual({ topic: "fresh" });
    });

    it("rejects built-in and malformed custom field or variable names", async () => {
      const op = operation("leads.import");
      const { sequenceId } = await createSequence("Hi", "{{x}}");
      await expect(runOperation(op, context(), { leads: [{ email: "a@example.com", customFields: { firstName: "x" } }] })).rejects.toMatchObject({ code: "BAD_INPUT" });
      await expect(runOperation(op, context(), { leads: [{ email: "a@example.com", customFields: { "bad key": "x" } }] })).rejects.toMatchObject({ code: "BAD_INPUT" });
      await expect(runOperation(op, context(), { sequenceId, leads: [{ email: "a@example.com", variables: { email: "x" } }] })).rejects.toMatchObject({ code: "BAD_INPUT" });
      await expect(runOperation(op, context(), { leads: [{ email: "a@example.com", variables: { x: "1" } }] })).rejects.toMatchObject({ code: "BAD_INPUT" });
      await expect(runOperation(op, context(), { leads: [{ email: "a@example.com", variables: { x: "1" } }], sequenceId, campaignId: randomUUID() })).rejects.toThrow();
      await expect(runOperation(op, context(), { sequenceId: randomUUID(), leads: [{ email: "a@example.com", variables: { x: "1" } }] })).rejects.toMatchObject({ code: "NOT_FOUND" });
      const rows = await db.select().from(schema.contacts).where(and(eq(schema.contacts.workspaceId, workspaceId), eq(schema.contacts.normalizedEmail, "a@example.com")));
      expect(rows).toHaveLength(0);
    });

    it("imports, stores per-campaign lines and enrolls complete leads in a single call", async () => {
      const { sequenceId } = await createSequence("Hi {{firstName}}", "{{icebreaker}} {{topic}}");
      const listId = await createList("Import audience");
      const [list] = await db.select().from(schema.contactLists).where(eq(schema.contactLists.id, listId));
      const campaignId = await createCampaign(sequenceId, listId, "active");
      const completeEmail = `import-complete-${randomUUID().slice(0, 8)}@example.com`;
      const partialEmail = `import-partial-${randomUUID().slice(0, 8)}@example.com`;
      const result = await runOperation(operation("leads.import"), context(), {
        listName: list!.name,
        campaignId,
        leads: [
          { email: completeEmail, customFields: { topic: "pricing" }, variables: { icebreaker: "Loved your post" } },
          { email: partialEmail, variables: { icebreaker: "No topic" } },
        ],
      });
      expect(result).toMatchObject({ imported: 2, listId, variables: { sequenceId, updated: 2 } });
      expect(result.campaignUpdates).toMatchObject([{ campaignId, enrolled: 1 }]);
      const contacts = await db.select().from(schema.contacts).where(eq(schema.contacts.workspaceId, workspaceId));
      const complete = contacts.find((contact) => contact.normalizedEmail === completeEmail)!;
      const partial = contacts.find((contact) => contact.normalizedEmail === partialEmail)!;
      expect(await variablesRow(sequenceId, complete.id)).toEqual({ icebreaker: "Loved your post" });
      expect((await enrollmentsFor(sequenceId)).map((row) => row.contactId)).toEqual([complete.id]);

      // The partial lead is enrolled automatically once its missing value arrives.
      const fill = await runOperation(operation("campaigns.setLeadVariables"), context(), { campaignId, leads: [{ contactId: partial.id, variables: { topic: "hiring" } }] });
      expect(fill).toMatchObject({ enrolled: 1, stillMissing: [] });
      expect(new Set((await enrollmentsFor(sequenceId)).map((row) => row.contactId))).toEqual(new Set([complete.id, partial.id]));
    });

    it("enrolls an existing list member whose line arrives through a later import", async () => {
      const { sequenceId } = await createSequence("Hi", "{{icebreaker}}");
      const listId = await createList("Existing member");
      await createCampaign(sequenceId, listId, "active");
      const member = await createContact("existing-member");
      await addToList(listId, member.id);
      const result = await runOperation(operation("leads.import"), context(), { sequenceId, leads: [{ email: member.email, variables: { icebreaker: "Hello there" } }] });
      expect(result).toMatchObject({ updated: 1, variables: { sequenceId, updated: 1, enrolledWaiting: 1 } });
      expect((await enrollmentsFor(sequenceId)).map((row) => row.contactId)).toEqual([member.id]);
    });
  });

  describe("leads.get", () => {
    it("returns customFields and per-campaign variables", async () => {
      const { sequenceId } = await createSequence("Hi", "{{icebreaker}}");
      const contact = await createContact("get", { customFields: { topic: "pricing" } });
      await runOperation(operation("campaigns.setLeadVariables"), context(), { sequenceId, leads: [{ contactId: contact.id, variables: { icebreaker: "Hello" } }] });
      const lead = await runOperation(operation("leads.get"), context(), { id: contact.id });
      expect(lead.customFields).toEqual({ topic: "pricing" });
      expect(lead.campaignVariables).toEqual([{ sequenceId, sequenceName: expect.any(String), values: { icebreaker: "Hello" } }]);
    });
  });
});
