import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { OpError, operationByName, runOperation, type OperationContext } from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;

function operation(name: string) {
  const found = operationByName.get(name);
  if (!found) throw new Error(`Missing operation ${name}`);
  return found;
}

describe.skipIf(!databaseUrl)("custom lead variables gate launch and rendering", () => {
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);
  let userId = "";
  let workspaceId = "";
  let mailboxId = "";

  function context(): OperationContext {
    return { db, workspaceId, userId, env: { edition: "selfhost", authSecret: "lead-variables-test-auth-secret-at-least-32-chars", apiBaseUrl: "https://api.example.test" } };
  }

  async function createSequence(label: string, body = "Hi {{firstName}},\n\n{{icebreaker}}\n\nWorth a chat?") {
    const created = await runOperation(operation("sequences.create"), context(), { name: label, steps: [{ delayDays: 0, subject: "Quick note", body }] });
    return created.sequence.id as string;
  }

  async function createContact(label: string, customFields: Record<string, unknown> = {}) {
    const id = randomUUID();
    const email = `${label}-${randomUUID().slice(0, 8)}@example.com`;
    await db.insert(schema.contacts).values({ id, workspaceId, email, normalizedEmail: email, firstName: label, status: "active", customFields });
    return { id, email };
  }

  async function createListWith(contactIds: string[]) {
    const listId = randomUUID();
    await db.insert(schema.contactLists).values({ id: listId, workspaceId, name: `list ${listId.slice(0, 8)}`, createdByUserId: userId });
    if (contactIds.length) await db.insert(schema.contactListMembers).values(contactIds.map((contactId) => ({ workspaceId, contactListId: listId, contactId })));
    return listId;
  }

  async function createCampaign(sequenceId: string, listIds: string[]) {
    const created = await runOperation(operation("campaigns.create"), context(), { name: `campaign ${randomUUID().slice(0, 6)}`, sequenceId, listIds, inboxId: mailboxId });
    return created.campaign.id as string;
  }

  async function setVariable(sequenceId: string, contactId: string, values: Record<string, string>) {
    await db.insert(schema.campaignLeadVariables).values({ sequenceId, contactId, workspaceId, values }).onConflictDoUpdate({ target: [schema.campaignLeadVariables.sequenceId, schema.campaignLeadVariables.contactId], set: { values } });
  }

  async function enrollmentCount(sequenceId: string) {
    return (await db.select().from(schema.enrollments).where(eq(schema.enrollments.sequenceId, sequenceId))).length;
  }

  beforeEach(async () => {
    const suffix = randomUUID().slice(0, 8);
    userId = randomUUID();
    workspaceId = randomUUID();
    mailboxId = randomUUID();
    const email = `lv-user-${suffix}@example.com`;
    await db.insert(schema.authUsers).values({ id: userId, name: "lv", email, emailVerified: true });
    await db.insert(schema.users).values({ id: userId, email, normalizedEmail: email, displayName: "lv" });
    await db.insert(schema.workspaces).values({ id: workspaceId, name: `lv ${suffix}`, slug: `lv-${suffix}`, createdByUserId: userId });
    await db.insert(schema.memberships).values({ id: randomUUID(), workspaceId, userId, role: "owner", status: "active", joinedAt: new Date() });
    const mailboxEmail = `lv-mailbox-${suffix}@example.com`;
    await db.insert(schema.emailAccounts).values({ id: mailboxId, workspaceId, userId, provider: "gmail", composioConnectedAccountId: `lv-${suffix}`, email: mailboxEmail, normalizedEmail: mailboxEmail, alias: `lv-${suffix}`, status: "active" });
  });

  afterEach(async () => {
    if (workspaceId) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
  });

  afterAll(async () => {
    await pool.end();
  });

  it("blocks campaigns.launch when leads miss a custom variable and enrolls nothing", async () => {
    const sequenceId = await createSequence("blocked");
    const complete = await createContact("complete");
    const incompleteA = await createContact("incompletea");
    const incompleteB = await createContact("incompleteb");
    await setVariable(sequenceId, complete.id, { icebreaker: "Loved your talk." });
    const campaignId = await createCampaign(sequenceId, [await createListWith([complete.id, incompleteA.id, incompleteB.id])]);

    const error = await runOperation(operation("campaigns.launch"), context(), { id: campaignId }).catch((caught) => caught);
    expect(error).toBeInstanceOf(OpError);
    expect(error.message).toBe("2 leads are missing {{icebreaker}}. Add their lines with campaigns.setLeadVariables, then launch again.");
    expect(error.details).toMatchObject({ code: "missing_variables", total: 2, byVariable: { icebreaker: 2 }, variables: ["icebreaker"] });
    expect(error.details.sampleEmails.sort()).toEqual([incompleteA.email, incompleteB.email].sort());
    expect(await enrollmentCount(sequenceId)).toBe(0);
    const [campaign] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
    expect(campaign?.status).toBe("draft");
    const [sequence] = await db.select().from(schema.sequences).where(eq(schema.sequences.id, sequenceId));
    expect(sequence?.status).not.toBe("active");
    expect(await db.select().from(schema.messages).where(eq(schema.messages.workspaceId, workspaceId))).toHaveLength(0);
  });

  it("launches when campaign values or lead custom fields cover every lead and renders them", async () => {
    const sequenceId = await createSequence("complete");
    const withCampaignValue = await createContact("campaignvalue");
    const withCustomField = await createContact("customfield", { icebreaker: "From the lead record." });
    const overridden = await createContact("overridden", { icebreaker: "Lead-level line." });
    await setVariable(sequenceId, withCampaignValue.id, { icebreaker: "Campaign line.\nSecond line" });
    await setVariable(sequenceId, overridden.id, { icebreaker: "Campaign wins." });
    const campaignId = await createCampaign(sequenceId, [await createListWith([withCampaignValue.id, withCustomField.id, overridden.id])]);

    const launched = await runOperation(operation("campaigns.launch"), context(), { id: campaignId });
    expect(launched).toMatchObject({ campaign: { status: "active" }, enrollment: { enrolled: 3 } });
    const messages = await db.select().from(schema.messages).where(eq(schema.messages.workspaceId, workspaceId));
    const bodyFor = (contactId: string) => (messages.find((message) => message.contactId === contactId)?.metadata as { bodyText: string }).bodyText;
    expect(bodyFor(withCampaignValue.id)).toContain("Campaign line. Second line");
    expect(bodyFor(withCustomField.id)).toContain("From the lead record.");
    expect(bodyFor(overridden.id)).toContain("Campaign wins.");
    expect(messages.every((message) => !(message.metadata as { bodyText: string }).bodyText.includes("{{"))).toBe(true);
  });

  it("does not block launches when the steps use only built-in variables", async () => {
    const sequenceId = await createSequence("builtin", "Hi {{firstName}} at {{company}},\n\nWorth a chat?");
    const lead = await createContact("plain");
    const campaignId = await createCampaign(sequenceId, [await createListWith([lead.id])]);
    await expect(runOperation(operation("campaigns.launch"), context(), { id: campaignId })).resolves.toMatchObject({ enrollment: { enrolled: 1 } });
  });

  it("blocks publish when queued leads are missing variables, and publishes once they arrive", async () => {
    const sequenceId = await createSequence("staged");
    const lead = await createContact("queued");
    await runOperation(operation("sequences.enroll"), context(), { id: sequenceId, leadIds: [lead.id] });
    await expect(runOperation(operation("sequences.publish"), context(), { id: sequenceId })).rejects.toMatchObject({ details: { code: "missing_variables", total: 1 } });
    const [stillDraft] = await db.select().from(schema.sequences).where(eq(schema.sequences.id, sequenceId));
    expect(stillDraft?.status).toBe("draft");
    expect(await db.select().from(schema.stagedEnrollments).where(eq(schema.stagedEnrollments.sequenceId, sequenceId))).toHaveLength(1);
    await setVariable(sequenceId, lead.id, { icebreaker: "Hello there." });
    await expect(runOperation(operation("sequences.publish"), context(), { id: sequenceId })).resolves.toMatchObject({ queuedEnrollment: { enrolled: 1 } });
  });

  it("reports missingVariables in the audience preview and the sequence preview", async () => {
    const sequenceId = await createSequence("preview");
    const ready = await createContact("ready");
    const waiting = await createContact("waiting");
    await setVariable(sequenceId, ready.id, { icebreaker: "Nice post." });
    const listId = await createListWith([ready.id, waiting.id]);
    const audience = await runOperation(operation("campaigns.audiencePreview"), context(), { sequenceId, listIds: [listId] });
    expect(audience.missingVariables).toEqual({ total: 1, byVariable: { icebreaker: 1 }, sampleEmails: [waiting.email] });

    const forReady = await runOperation(operation("sequences.preview"), context(), { id: sequenceId, contactId: ready.id });
    expect(forReady.steps[0]).toMatchObject({ missingVariables: [] });
    expect(forReady.steps[0].body).toContain("Nice post.");
    const forWaiting = await runOperation(operation("sequences.preview"), context(), { id: sequenceId, contactId: waiting.id });
    expect(forWaiting.steps[0]).toMatchObject({ missingVariables: ["icebreaker"] });
    expect(forWaiting.steps[0].body).toContain("[icebreaker]");
    const sample = await runOperation(operation("sequences.preview"), context(), { id: sequenceId });
    expect(sample.steps[0].body).toContain("[icebreaker]");
  });

  it("lets a lead run in two sequences at once", async () => {
    const firstSequenceId = await createSequence("first", "Hi {{firstName}},\n\nFirst?");
    const secondSequenceId = await createSequence("second", "Hi {{firstName}},\n\nSecond?");
    const lead = await createContact("both");
    const listId = await createListWith([lead.id]);
    await runOperation(operation("campaigns.launch"), context(), { id: await createCampaign(firstSequenceId, [listId]) });
    await expect(runOperation(operation("campaigns.launch"), context(), { id: await createCampaign(secondSequenceId, [listId]) })).resolves.toMatchObject({ enrollment: { enrolled: 1 } });
    expect(await enrollmentCount(firstSequenceId)).toBe(1);
    expect(await enrollmentCount(secondSequenceId)).toBe(1);
  });
});
