import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { operationByName, runOperation, type OperationContext } from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;

function operation(name: string) {
  const found = operationByName.get(name);
  if (!found) throw new Error(`Missing operation ${name}`);
  return found;
}

describe.skipIf(!databaseUrl)("lead variables: review fixes and read operations", () => {
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);
  const created: { users: string[]; workspaces: string[] } = { users: [], workspaces: [] };
  let userId = "";
  let workspaceId = "";
  let mailboxId = "";
  let foreignUserId = "";
  let foreignWorkspaceId = "";
  let foreignMailboxId = "";

  function context(overrides: Partial<OperationContext> = {}): OperationContext {
    return { db, workspaceId, userId, env: { edition: "selfhost", authSecret: "lead-variables-test-auth-secret-at-least-32-chars", apiBaseUrl: "https://api.example.test" }, ...overrides };
  }

  async function createWorkspace(label: string, role: "owner" | "member" = "owner") {
    const suffix = randomUUID().slice(0, 8);
    const newUserId = randomUUID();
    const newWorkspaceId = randomUUID();
    const newMailboxId = randomUUID();
    const email = `${label}-user-${suffix}@example.com`;
    await db.insert(schema.authUsers).values({ id: newUserId, name: label, email, emailVerified: true });
    await db.insert(schema.users).values({ id: newUserId, email, normalizedEmail: email, displayName: label });
    await db.insert(schema.workspaces).values({ id: newWorkspaceId, name: `${label} ${suffix}`, slug: `${label}-${suffix}`, createdByUserId: newUserId });
    await db.insert(schema.memberships).values({ id: randomUUID(), workspaceId: newWorkspaceId, userId: newUserId, role, status: "active", joinedAt: new Date() });
    const mailboxEmail = `${label}-mailbox-${suffix}@example.com`;
    await db.insert(schema.emailAccounts).values({ id: newMailboxId, workspaceId: newWorkspaceId, userId: newUserId, provider: "gmail", composioConnectedAccountId: `${label}-${suffix}`, email: mailboxEmail, normalizedEmail: mailboxEmail, alias: `${label}-${suffix}`, status: "active" });
    created.users.push(newUserId);
    created.workspaces.push(newWorkspaceId);
    return { userId: newUserId, workspaceId: newWorkspaceId, mailboxId: newMailboxId };
  }

  async function createSequence(label: string, body = "Hi {{firstName}},\n\n{{icebreaker}}\n\nWorth a chat?", ctx: OperationContext = context()) {
    const result = await runOperation(operation("sequences.create"), ctx, { name: label, steps: [{ delayDays: 0, subject: "Quick note", body }] });
    return result.sequence.id as string;
  }

  async function createContact(label: string, options: { ws?: string; status?: string; customFields?: Record<string, unknown>; firstName?: string } = {}) {
    const id = randomUUID();
    const email = `lv-${label}-${randomUUID().slice(0, 8)}@example.com`;
    await db.insert(schema.contacts).values({ id, workspaceId: options.ws ?? workspaceId, email, normalizedEmail: email, firstName: options.firstName ?? label, status: options.status ?? "active", customFields: options.customFields ?? {} });
    return { id, email };
  }

  async function createListWith(contactIds: string[]) {
    const listId = randomUUID();
    await db.insert(schema.contactLists).values({ id: listId, workspaceId, name: `list ${listId.slice(0, 8)}`, createdByUserId: userId });
    if (contactIds.length) await db.insert(schema.contactListMembers).values(contactIds.map((contactId) => ({ workspaceId, contactListId: listId, contactId })));
    return listId;
  }

  async function createCampaign(sequenceId: string, listIds: string[]) {
    const result = await runOperation(operation("campaigns.create"), context(), { name: `campaign ${randomUUID().slice(0, 6)}`, sequenceId, listIds, inboxId: mailboxId });
    return result.campaign.id as string;
  }

  async function enrollmentsFor(sequenceId: string) {
    return db.select().from(schema.enrollments).where(eq(schema.enrollments.sequenceId, sequenceId));
  }

  beforeEach(async () => {
    const own = await createWorkspace("lv2");
    userId = own.userId;
    workspaceId = own.workspaceId;
    mailboxId = own.mailboxId;
    const foreign = await createWorkspace("lv2foreign");
    foreignUserId = foreign.userId;
    foreignWorkspaceId = foreign.workspaceId;
    foreignMailboxId = foreign.mailboxId;
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

  describe("leads queued on a live sequence", () => {
    it("do not block later publishes and enroll when their values arrive", async () => {
      const sequenceId = await createSequence("requeued");
      const lead = await createContact("requeued");
      await runOperation(operation("sequences.publish"), context(), { id: sequenceId });
      // The shape conversion leaves behind when a lead is missing a variable on a live sequence.
      await db.insert(schema.stagedEnrollments).values({ id: randomUUID(), workspaceId, sequenceId, leadId: lead.id, campaignId: null });
      await runOperation(operation("sequences.pause"), context(), { id: sequenceId });
      await expect(runOperation(operation("sequences.publish"), context(), { id: sequenceId })).resolves.toMatchObject({ sequence: { id: sequenceId } });
      expect(await db.select().from(schema.stagedEnrollments).where(eq(schema.stagedEnrollments.sequenceId, sequenceId))).toHaveLength(1);
      expect(await enrollmentsFor(sequenceId)).toHaveLength(0);

      const result = await runOperation(operation("campaigns.setLeadVariables"), context(), { sequenceId, leads: [{ contactId: lead.id, variables: { icebreaker: "Loved the keynote" } }] });
      expect(result).toMatchObject({ updated: 1, enrolled: 1, stillMissing: [] });
      expect(await enrollmentsFor(sequenceId)).toHaveLength(1);
      expect(await db.select().from(schema.stagedEnrollments).where(eq(schema.stagedEnrollments.sequenceId, sequenceId))).toHaveLength(0);
    });

    it("keep waiting while a value is still missing", async () => {
      const sequenceId = await createSequence("stillwaiting", "{{icebreaker}} {{hook}}");
      const lead = await createContact("stillwaiting");
      await runOperation(operation("sequences.publish"), context(), { id: sequenceId });
      await db.insert(schema.stagedEnrollments).values({ id: randomUUID(), workspaceId, sequenceId, leadId: lead.id, campaignId: null });
      const result = await runOperation(operation("campaigns.setLeadVariables"), context(), { sequenceId, leads: [{ contactId: lead.id, variables: { icebreaker: "only one" } }] });
      expect(result).toMatchObject({ enrolled: 0, stillMissing: [{ email: lead.email, missing: ["hook"] }] });
      expect(await db.select().from(schema.stagedEnrollments).where(eq(schema.stagedEnrollments.sequenceId, sequenceId))).toHaveLength(1);
    });

    it("still block publishing a draft whose queued leads are missing values", async () => {
      const sequenceId = await createSequence("draftqueue");
      const lead = await createContact("draftqueue");
      await runOperation(operation("sequences.enroll"), context(), { id: sequenceId, leadIds: [lead.id] });
      await expect(runOperation(operation("sequences.publish"), context(), { id: sequenceId })).rejects.toMatchObject({ code: "CONFLICT", details: { code: "missing_variables" } });
    });
  });

  describe("leads.import lead-level custom fields", () => {
    it("wake waiting leads and refresh queued mail in every sequence they are part of", async () => {
      const sequenceId = await createSequence("wake");
      const ready = await createContact("ready", { customFields: { icebreaker: "Old line" } });
      const campaignId = await createCampaign(sequenceId, [await createListWith([ready.id])]);
      await runOperation(operation("campaigns.launch"), context(), { id: campaignId });
      const waiting = await createContact("waiting");
      const [{ contactListId }] = await db.select({ contactListId: schema.campaignContactLists.contactListId }).from(schema.campaignContactLists).where(eq(schema.campaignContactLists.campaignId, campaignId));
      await db.insert(schema.contactListMembers).values({ workspaceId, contactListId: contactListId!, contactId: waiting.id });
      expect(await enrollmentsFor(sequenceId)).toHaveLength(1);

      const result = await runOperation(operation("leads.import"), context(), { leads: [
        { email: ready.email, customFields: { icebreaker: "New line" } },
        { email: waiting.email, customFields: { icebreaker: "Wake line" } },
      ] });
      expect(result).toMatchObject({ customFieldsRefresh: { enrolledWaiting: 1, rerendered: 1 } });
      expect(await enrollmentsFor(sequenceId)).toHaveLength(2);
      const messages = await db.select().from(schema.messages).where(eq(schema.messages.workspaceId, workspaceId));
      const bodyFor = (contactId: string) => (messages.find((message) => message.contactId === contactId)?.metadata as { bodyText: string }).bodyText;
      expect(bodyFor(ready.id)).toContain("New line");
      expect(bodyFor(ready.id)).not.toContain("Old line");
      expect(bodyFor(waiting.id)).toContain("Wake line");
    });

    it("do not need a refresh when nothing changed", async () => {
      const lead = await createContact("plain");
      const result = await runOperation(operation("leads.import"), context(), { leads: [{ email: lead.email, firstName: "Plain" }] });
      expect(result.customFieldsRefresh).toBeUndefined();
    });
  });

  describe("leads.import campaign variables", () => {
    it("require a workspace manager", async () => {
      const sequenceId = await createSequence("manager");
      const member = await createWorkspace("lv2member", "member");
      // The member joins the first workspace as a plain member.
      await db.insert(schema.memberships).values({ id: randomUUID(), workspaceId, userId: member.userId, role: "member", status: "active", joinedAt: new Date() });
      const lead = await createContact("manager");
      const memberContext = context({ userId: member.userId });
      await expect(runOperation(operation("leads.import"), memberContext, { sequenceId, leads: [{ email: lead.email, variables: { icebreaker: "x" } }] })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(runOperation(operation("leads.import"), memberContext, { leads: [{ email: lead.email, firstName: "Fine" }] })).resolves.toMatchObject({ updated: 1 });
      await expect(runOperation(operation("leads.import"), context(), { sequenceId, leads: [{ email: lead.email, variables: { icebreaker: "x" } }] })).resolves.toMatchObject({ variables: { updated: 1 } });
    });
  });

  describe("sequences.launch gate", () => {
    it("uses the campaign enrollment will attach, so completed history does not cause a false 409", async () => {
      const sequenceId = await createSequence("history");
      const oldVersionId = randomUUID();
      await db.insert(schema.sequenceVersions).values({ id: oldVersionId, workspaceId, sequenceId, version: 2, status: "archived", snapshot: {} });
      const past = await createContact("past");
      const campaignId = randomUUID();
      await db.insert(schema.campaigns).values({ id: campaignId, workspaceId, sequenceId, emailAccountId: mailboxId, name: "Finished", status: "completed", launchedAt: new Date(), createdByUserId: userId });
      const listId = await createListWith([past.id]);
      await db.insert(schema.campaignContactLists).values({ campaignId, contactListId: listId, workspaceId });
      await db.insert(schema.enrollments).values({ id: randomUUID(), workspaceId, contactId: past.id, sequenceId, sequenceVersionId: oldVersionId, campaignId, emailAccountId: mailboxId, status: "completed" });

      await expect(runOperation(operation("sequences.launch"), context(), { id: sequenceId, listIds: [listId] })).resolves.toMatchObject({ enrolled: 0, skipped: { already_enrolled: 1 } });

      // A genuinely new lead that lacks the variable is still blocked.
      const fresh = await createContact("fresh");
      await db.insert(schema.contactListMembers).values({ workspaceId, contactListId: listId, contactId: fresh.id });
      await expect(runOperation(operation("sequences.launch"), context(), { id: sequenceId, listIds: [listId] })).rejects.toMatchObject({ code: "CONFLICT", details: { code: "missing_variables", total: 1, sampleEmails: [fresh.email] } });
    });
  });

  describe("campaigns.getLeadVariables", () => {
    async function seedAudience() {
      const sequenceId = await createSequence("grid", "{{icebreaker}} and {{hook}}");
      const a = await createContact("a", { firstName: "Ada", customFields: { hook: "from lead" } });
      const b = await createContact("b", { firstName: "Bea", customFields: { icebreaker: "lead line" } });
      const c = await createContact("c", { firstName: "Cora" });
      const d = await createContact("d", { firstName: "Dan" });
      const e = await createContact("e", { firstName: "Eve" });
      const suppressed = await createContact("f", { firstName: "Fay", status: "suppressed" });
      const outsider = await createContact("g", { firstName: "Gus" });
      const campaignId = await createCampaign(sequenceId, [await createListWith([a.id, b.id, c.id, suppressed.id])]);
      await db.insert(schema.campaignLeadVariables).values({ sequenceId, contactId: a.id, workspaceId, values: { icebreaker: "campaign line", ignored: "x" } });
      await db.insert(schema.stagedEnrollments).values({ id: randomUUID(), workspaceId, sequenceId, leadId: d.id, campaignId: null });
      await db.insert(schema.enrollments).values({ id: randomUUID(), workspaceId, contactId: e.id, sequenceId, sequenceVersionId: (await db.select().from(schema.sequences).where(eq(schema.sequences.id, sequenceId)))[0]!.currentVersionId!, emailAccountId: mailboxId, status: "completed" });
      return { sequenceId, campaignId, a, b, c, d, e, suppressed, outsider };
    }

    it("reports coverage per variable and the union audience with value sources", async () => {
      const { sequenceId, campaignId, a, b, c, d, e, suppressed, outsider } = await seedAudience();
      const op = operation("campaigns.getLeadVariables");
      const bySequence = await runOperation(op, context(), { sequenceId });
      const byCampaign = await runOperation(op, context(), { campaignId });
      expect(byCampaign).toEqual(bySequence);
      expect(bySequence.variables).toEqual([{ name: "hook", ready: 1, missing: 4 }, { name: "icebreaker", ready: 2, missing: 3 }]);
      expect(bySequence).toMatchObject({ audienceTotal: 5, total: 5, page: 1, pageSize: 50 });
      const ids = bySequence.leads.map((lead: { contactId: string }) => lead.contactId);
      expect(ids).toEqual([a.id, b.id, c.id, d.id, e.id]);
      expect(ids).not.toContain(suppressed.id);
      expect(ids).not.toContain(outsider.id);
      expect(bySequence.leads[0]).toEqual({ contactId: a.id, email: a.email, firstName: "Ada", lastName: null, values: { hook: { value: "from lead", source: "lead" }, icebreaker: { value: "campaign line", source: "campaign" } }, missing: [] });
      expect(bySequence.leads[1]).toMatchObject({ values: { hook: null, icebreaker: { value: "lead line", source: "lead" } }, missing: ["hook"] });
      expect(bySequence.leads[2]).toMatchObject({ values: { hook: null, icebreaker: null }, missing: ["hook", "icebreaker"] });
    });

    it("filters missing leads (optionally by variable), searches and pages", async () => {
      const { sequenceId, b, c, d, e } = await seedAudience();
      const op = operation("campaigns.getLeadVariables");
      const missing = await runOperation(op, context(), { sequenceId, filter: "missing" });
      expect(missing.leads.map((lead: { contactId: string }) => lead.contactId)).toEqual([b.id, c.id, d.id, e.id]);
      expect(missing).toMatchObject({ total: 4, audienceTotal: 5 });
      const noIcebreaker = await runOperation(op, context(), { sequenceId, filter: "missing", variable: "icebreaker" });
      expect(noIcebreaker.leads.map((lead: { contactId: string }) => lead.contactId)).toEqual([c.id, d.id, e.id]);
      expect(await runOperation(op, context(), { sequenceId, filter: "missing", variable: "unused" })).toMatchObject({ total: 0, leads: [] });
      const searched = await runOperation(op, context(), { sequenceId, search: "CORA" });
      expect(searched).toMatchObject({ total: 1, audienceTotal: 5 });
      expect(searched.leads[0].contactId).toBe(c.id);
      expect((await runOperation(op, context(), { sequenceId, search: "%" })).total).toBe(0);
      const second = await runOperation(op, context(), { sequenceId, page: 2, pageSize: 2 });
      expect(second).toMatchObject({ page: 2, pageSize: 2, total: 5 });
      expect(second.leads.map((lead: { contactId: string }) => lead.contactId)).toEqual([c.id, d.id]);
    });

    it("returns an empty variable list when the steps use only built-ins", async () => {
      const sequenceId = await createSequence("builtin", "Hi {{first_name}} at {{company_name}}");
      const lead = await createContact("builtin");
      await createCampaign(sequenceId, [await createListWith([lead.id])]);
      const result = await runOperation(operation("campaigns.getLeadVariables"), context(), { sequenceId });
      expect(result).toMatchObject({ variables: [], audienceTotal: 1, total: 1 });
      expect(result.leads[0]).toMatchObject({ values: {}, missing: [] });
      expect((await runOperation(operation("campaigns.getLeadVariables"), context(), { sequenceId, filter: "missing" })).total).toBe(0);
    });

    it("never reads another workspace's sequence or campaign", async () => {
      const foreignSequenceId = await createSequence("foreign", "{{icebreaker}}", context({ workspaceId: foreignWorkspaceId, userId: foreignUserId }));
      const foreignCampaignId = randomUUID();
      await db.insert(schema.campaigns).values({ id: foreignCampaignId, workspaceId: foreignWorkspaceId, sequenceId: foreignSequenceId, emailAccountId: foreignMailboxId, name: "Foreign", status: "draft" });
      const op = operation("campaigns.getLeadVariables");
      await expect(runOperation(op, context(), { sequenceId: foreignSequenceId })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(runOperation(op, context(), { campaignId: foreignCampaignId })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(runOperation(op, context(), {})).rejects.toThrow();
      await expect(runOperation(op, context(), { sequenceId: foreignSequenceId, campaignId: foreignCampaignId })).rejects.toThrow();
    });

    it("is a read operation", () => {
      expect(operation("campaigns.getLeadVariables").access).toBe("read");
      expect(operation("campaigns.listLeadVariableNames").access).toBe("read");
    });
  });

  describe("campaigns.listLeadVariableNames", () => {
    it("lists distinct custom names from lead fields and campaign values, minus internal keys, built-ins and other workspaces", async () => {
      const sequenceId = await createSequence("names");
      const lead = await createContact("names", { customFields: { hook: "x", Topic: "y", replyBackfillCheckedAt: "2026-01-01", first_name: "alias", "bad-name": "z", firstName: "built-in" } });
      await createContact("names2", { customFields: { hook: "again" } });
      await createContact("foreign", { ws: foreignWorkspaceId, customFields: { secret: "nope" } });
      await db.insert(schema.campaignLeadVariables).values({ sequenceId, contactId: lead.id, workspaceId, values: { icebreaker: "line", hook: "dup" } });
      const result = await runOperation(operation("campaigns.listLeadVariableNames"), context(), {});
      expect(result).toEqual({ names: ["Topic", "hook", "icebreaker"] });
      expect(await runOperation(operation("campaigns.listLeadVariableNames"), context({ workspaceId: foreignWorkspaceId, userId: foreignUserId }), {})).toEqual({ names: ["secret"] });
    });
  });
});
