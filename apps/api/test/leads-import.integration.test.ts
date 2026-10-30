import { loadAppEnv } from "@inboxjoy/config";
import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { and, eq, inArray } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { createAuthenticatedSession, type AuthenticatedSession } from "./auth-helper.js";

const databaseUrl = process.env.DATABASE_URL;
const authSecret = "lead-import-test-secret-at-least-32-characters";

describe.skipIf(!databaseUrl)("lead creation and CSV imports", () => {
  const suffix = randomUUID().slice(0, 8);
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);
  const env = loadAppEnv({ ...process.env, NODE_ENV: "test", DATABASE_URL: databaseUrl ?? "postgresql://localhost/inboxjoy_test", API_BASE_URL: "https://api.example.test", WEB_BASE_URL: "https://app.example.test", CORS_ORIGINS: "https://app.example.test", AUTH_SECRET: authSecret });
  let app: Awaited<ReturnType<typeof buildApp>>;
  let userA: AuthenticatedSession;
  let userB: AuthenticatedSession;

  async function createLinkedListFixture() {
    const listId = randomUUID();
    const listName = `Linked import ${listId}`;
    const mailboxId = randomUUID();
    const pastContactId = randomUUID();
    const waitingContactId = randomUUID();
    const outsideContactId = randomUUID();
    const contactIds = [pastContactId, waitingContactId, outsideContactId];
    const pastEmail = `past-${listId}@example.com`;
    const waitingEmail = `waiting-${listId}@example.com`;
    const outsideEmail = `outside-${listId}@example.com`;
    const completedAt = new Date("2026-09-01T12:00:00Z");
    const campaigns = ["completed", "active"].map((status) => ({ id: randomUUID(), sequenceId: randomUUID(), versionId: randomUUID(), stepId: randomUUID(), name: `${status} import ${listId}`, status: status as "completed" | "active" }));
    await db.insert(schema.contactLists).values({ id: listId, workspaceId: userA.workspaceId, name: listName });
    await db.insert(schema.emailAccounts).values({ id: mailboxId, workspaceId: userA.workspaceId, userId: userA.userId, provider: "gmail", composioConnectedAccountId: `linked-import-${listId}`, email: `sender-${listId}@example.com`, normalizedEmail: `sender-${listId}@example.com`, alias: `linked-import-${listId}`, status: "active" });
    await db.insert(schema.contacts).values([
      { id: pastContactId, workspaceId: userA.workspaceId, email: pastEmail, normalizedEmail: pastEmail, firstName: "Past", status: "active" },
      { id: waitingContactId, workspaceId: userA.workspaceId, email: waitingEmail, normalizedEmail: waitingEmail, firstName: "Waiting", status: "active" },
      { id: outsideContactId, workspaceId: userA.workspaceId, email: outsideEmail, normalizedEmail: outsideEmail, firstName: "Outside", status: "active" },
    ]);
    await db.insert(schema.contactListMembers).values([pastContactId, waitingContactId].map((contactId) => ({ contactId, contactListId: listId, workspaceId: userA.workspaceId })));
    for (const [index, campaign] of campaigns.entries()) {
      await db.insert(schema.sequences).values({ id: campaign.sequenceId, workspaceId: userA.workspaceId, name: campaign.name, status: "active" });
      await db.insert(schema.sequenceVersions).values({ id: campaign.versionId, workspaceId: userA.workspaceId, sequenceId: campaign.sequenceId, version: 1, status: "active", snapshot: { lastSuccessfulTestSendAt: completedAt.toISOString(), enrolledCount: 1 } });
      await db.update(schema.sequences).set({ currentVersionId: campaign.versionId }).where(eq(schema.sequences.id, campaign.sequenceId));
      await db.insert(schema.sequenceSteps).values({ id: campaign.stepId, workspaceId: userA.workspaceId, sequenceVersionId: campaign.versionId, stepOrder: 1, delayDays: 0, subject: "Hello {{firstName}}", bodyText: "Hello {{firstName}}" });
      await db.insert(schema.campaigns).values({ id: campaign.id, workspaceId: userA.workspaceId, sequenceId: campaign.sequenceId, contactListId: index === 0 ? listId : null, emailAccountId: mailboxId, name: campaign.name, status: campaign.status, launchedAt: new Date(index === 0 ? "2026-08-01T12:00:00Z" : "2026-08-02T12:00:00Z"), completedAt: campaign.status === "completed" ? completedAt : null, createdByUserId: userA.userId });
      await db.insert(schema.campaignContactLists).values({ campaignId: campaign.id, contactListId: listId, workspaceId: userA.workspaceId });
      await db.insert(schema.enrollments).values({ id: randomUUID(), workspaceId: userA.workspaceId, contactId: pastContactId, sequenceId: campaign.sequenceId, sequenceVersionId: campaign.versionId, campaignId: campaign.id, emailAccountId: mailboxId, status: "completed", startedAt: new Date("2026-08-01T12:00:00Z"), stoppedAt: completedAt });
    }
    const campaignIds = campaigns.map((campaign) => campaign.id);
    const enrollments = await db.select().from(schema.enrollments).where(inArray(schema.enrollments.campaignId, campaignIds)).orderBy(schema.enrollments.id);
    return {
      listId, listName, mailboxId, pastContactId, waitingContactId, outsideContactId, pastEmail, waitingEmail, outsideEmail, contactIds, campaigns, campaignIds, enrollments,
      async cleanup() {
        const members = await db.select({ contactId: schema.contactListMembers.contactId }).from(schema.contactListMembers).where(eq(schema.contactListMembers.contactListId, listId));
        await db.delete(schema.contacts).where(inArray(schema.contacts.id, [...new Set([...contactIds, ...members.map((member) => member.contactId)])]));
        await db.delete(schema.sequences).where(inArray(schema.sequences.id, campaigns.map((campaign) => campaign.sequenceId)));
        await db.delete(schema.contactLists).where(eq(schema.contactLists.id, listId));
        await db.delete(schema.emailAccounts).where(eq(schema.emailAccounts.id, mailboxId));
      },
    };
  }

  beforeAll(async () => {
    app = await buildApp({ env, db });
    userA = await createAuthenticatedSession(app, "Lead Import Alpha");
    userB = await createAuthenticatedSession(app, "Lead Import Beta");
  });

  afterAll(async () => {
    await app?.close();
    if (userA) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, userA.workspaceId));
    if (userB) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, userB.workspaceId));
    await pool.end();
  });

  it("creates and edits workspace-scoped leads without changing identity or lifecycle", async () => {
    const listId = randomUUID();
    await db.insert(schema.contactLists).values({ id: listId, workspaceId: userA.workspaceId, name: `Manual ${suffix}` });
    const email = `Manual-${suffix}@Example.com`;
    const created = await app.inject({ method: "POST", url: "/v1/leads", headers: { cookie: userA.cookie }, payload: { email, firstName: "  Ava ", company: "Acme", listId } });
    expect(created.statusCode).toBe(201);
    expect(created.json().lead).toMatchObject({ email, normalizedEmail: email.toLowerCase(), firstName: "Ava", company: "Acme", listName: `Manual ${suffix}` });

    const leadId = created.json().lead.id as string;
    expect((await app.inject({ method: "POST", url: "/v1/leads", headers: { cookie: userA.cookie }, payload: { email: email.toLowerCase() } })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/v1/leads", headers: { cookie: userB.cookie }, payload: { email: email.toLowerCase() } })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/v1/leads", headers: { cookie: userB.cookie }, payload: { email: `other-${suffix}@example.com`, listId } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/v1/imports/preview", headers: { cookie: userB.cookie }, payload: { csv: `email\nforeign-list-${suffix}@example.com`, listId } })).statusCode).toBe(404);

    await db.update(schema.contacts).set({ source: "Protected source", status: "replied" }).where(and(eq(schema.contacts.id, leadId), eq(schema.contacts.workspaceId, userA.workspaceId)));
    expect((await app.inject({ method: "PATCH", url: `/v1/leads/${leadId}`, headers: { cookie: userB.cookie }, payload: { firstName: "Nope" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "PATCH", url: `/v1/leads/${leadId}`, headers: { cookie: userA.cookie }, payload: { email } })).statusCode).toBe(400);
    const patched = await app.inject({ method: "PATCH", url: `/v1/leads/${leadId}`, headers: { cookie: userA.cookie }, payload: { firstName: " Ada ", company: "" } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().lead).toMatchObject({ email, normalizedEmail: email.toLowerCase(), firstName: "Ada", company: "", source: "Protected source", status: "Replied" });
  });

  it("previews deterministic actions, preserves blanks, and records commit conflicts", async () => {
    const existingEmail = `existing-${suffix}@example.com`;
    const newEmail = `new-${suffix}@example.com`;
    const suppressedEmail = `suppressed-${suffix}@example.com`;
    const hashSuppressedEmail = `hash-suppressed-${suffix}@example.com`;
    const existing = await app.inject({ method: "POST", url: "/v1/leads", headers: { cookie: userA.cookie }, payload: { email: existingEmail, firstName: "Before", company: "Keep Co", title: "Original" } });
    const existingId = existing.json().lead.id as string;
    await db.update(schema.contacts).set({ source: "Original source" }).where(eq(schema.contacts.id, existingId));
    await db.insert(schema.suppressions).values({ id: randomUUID(), workspaceId: userA.workspaceId, email: suppressedEmail, normalizedEmail: suppressedEmail, emailHash: createHash("sha256").update(suppressedEmail).digest("hex"), reason: "manual", source: "manual" });
    await db.insert(schema.suppressions).values({ id: randomUUID(), workspaceId: userA.workspaceId, email: null, normalizedEmail: null, emailHash: createHash("sha256").update(hashSuppressedEmail).digest("hex"), reason: "manual", source: "manual" });

    const listName = `Import ${suffix}`;
    const previewResponse = await app.inject({
      method: "POST",
      url: "/v1/imports/preview",
      headers: { cookie: userA.cookie },
      payload: {
        mode: "add_and_update",
        listName,
        csv: `email,firstName,company,source\n${existingEmail},After,,\n${existingEmail},Duplicate,Changed,Changed\n${newEmail},New,New Co,Partner\n${suppressedEmail},Suppressed,Nope,Nope\n${hashSuppressedEmail},Hash Suppressed,Nope,Nope\ninvalid,Invalid,Nope,Nope`,
      },
    });
    expect(previewResponse.statusCode).toBe(200);
    const preview = previewResponse.json().import;
    expect(preview.mode).toBe("add_and_update");
    expect(preview.rows.map((row: { action: string }) => row.action)).toEqual(["update", "duplicate", "create", "suppressed", "suppressed", "rejected"]);
    expect(preview.rows[0].changedFields).toEqual({ firstName: { before: "Before", after: "After" } });
    expect(preview.stats).toMatchObject({ totalRows: 6, readyRows: 2, createRows: 1, updateRows: 1, unchangedRows: 0, duplicateRows: 1, suppressedRows: 2, rejectedRows: 1, skippedRows: 4, createdRows: 0, updatedRows: 0 });
    expect(await db.select().from(schema.contactLists).where(and(eq(schema.contactLists.workspaceId, userA.workspaceId), eq(schema.contactLists.name, listName)))).toEqual([]);

    await db.update(schema.contacts).set({ title: "Changed after preview", updatedAt: new Date() }).where(eq(schema.contacts.id, existingId));
    const committed = await app.inject({ method: "POST", url: `/v1/imports/${preview.id as string}/commit`, headers: { cookie: userA.cookie } });
    expect(committed.statusCode).toBe(200);
    expect(committed.json().import.stats).toMatchObject({ createdRows: 1, updatedRows: 0, unchangedRows: 0, duplicateRows: 1, suppressedRows: 2, rejectedRows: 1, skippedRows: 5 });
    expect(committed.json().import.rows[0]).toMatchObject({ action: "update", status: "skipped", error: "Conflict: lead changed after preview" });
    expect((await db.select().from(schema.contacts).where(and(eq(schema.contacts.workspaceId, userA.workspaceId), eq(schema.contacts.normalizedEmail, newEmail)))).length).toBe(1);
    expect((await db.select().from(schema.contactLists).where(and(eq(schema.contactLists.workspaceId, userA.workspaceId), eq(schema.contactLists.name, listName)))).length).toBe(1);
  });

  it("updates only nonblank mapped fields and commits idempotently under retries", async () => {
    const email = `update-${suffix}@example.com`;
    const created = await app.inject({ method: "POST", url: "/v1/leads", headers: { cookie: userA.cookie }, payload: { email, firstName: "Old", company: "Keep", title: "Keep title" } });
    const leadId = created.json().lead.id as string;
    await db.update(schema.contacts).set({ source: "Keep source" }).where(eq(schema.contacts.id, leadId));
    const missingEmail = `missing-${suffix}@example.com`;
    const previewResponse = await app.inject({ method: "POST", url: "/v1/imports/preview", headers: { cookie: userA.cookie }, payload: { mode: "update_only", listName: `Updates ${suffix}`, csv: `email,firstName,company,source\n${email},New Name,,\n${missingEmail},Missing,Missing,Missing` } });
    expect(previewResponse.statusCode).toBe(200);
    const preview = previewResponse.json().import;
    expect(preview.rows.map((row: { action: string }) => row.action)).toEqual(["update", "not_found"]);

    const [firstCommit, retryCommit] = await Promise.all([
      app.inject({ method: "POST", url: `/v1/imports/${preview.id as string}/commit`, headers: { cookie: userA.cookie } }),
      app.inject({ method: "POST", url: `/v1/imports/${preview.id as string}/commit`, headers: { cookie: userA.cookie } }),
    ]);
    expect(firstCommit.statusCode).toBe(200);
    expect(retryCommit.statusCode).toBe(200);
    expect(firstCommit.json().import.stats).toEqual(retryCommit.json().import.stats);
    expect(firstCommit.json().import.stats).toMatchObject({ createdRows: 0, updatedRows: 1, unchangedRows: 0, skippedRows: 1 });

    const [contact] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, leadId));
    expect(contact).toMatchObject({ firstName: "New Name", company: "Keep", title: "Keep title", source: "Keep source" });
    const history = await app.inject({ method: "GET", url: "/v1/imports", headers: { cookie: userA.cookie } });
    expect(history.json().imports).toEqual(expect.arrayContaining([expect.objectContaining({ id: preview.id, mode: "update_only", stats: expect.objectContaining({ updatedRows: 1, skippedRows: 1 }) })]));
  });

  it("add-only imports write custom cells onto existing leads without touching standard fields or list membership", async () => {
    const headers = { cookie: userA.cookie };
    const withLine = `addonly-line-${suffix}@example.com`;
    const withoutLine = `addonly-plain-${suffix}@example.com`;
    const ids: string[] = [];
    for (const email of [withLine, withoutLine]) {
      const created = await app.inject({ method: "POST", url: "/v1/leads", headers, payload: { email, firstName: "Old", company: "Keep" } });
      ids.push(created.json().lead.id as string);
    }
    const listName = `Add only ${suffix}`;
    const fieldMapping = { email: "email", firstName: "firstName", "custom:icebreaker": "icebreaker" };
    const previewResponse = await app.inject({ method: "POST", url: "/v1/imports/preview", headers, payload: { listName, fieldMapping, csv: `email,firstName,icebreaker\n${withLine},Changed,Great talk\n${withoutLine},Changed,` } });
    expect(previewResponse.statusCode).toBe(200);
    const preview = previewResponse.json().import;
    expect(preview.mode).toBe("add_only");
    expect(preview.rows.map((row: { action: string; status: string; error: string | null }) => [row.action, row.status, row.error])).toEqual([["update", "ready", null], ["unchanged", "unchanged", "Lead already exists"]]);
    expect(preview.rows[0].changedFields).toBeUndefined();
    expect(preview.stats).toMatchObject({ updateRows: 1, unchangedRows: 1 });

    const committed = await app.inject({ method: "POST", url: `/v1/imports/${preview.id as string}/commit`, headers });
    expect(committed.statusCode).toBe(200);
    expect(committed.json().import.stats).toMatchObject({ createdRows: 0, updatedRows: 1, unchangedRows: 1 });
    expect(committed.json().import.rows.map((row: { status: string }) => row.status)).toEqual(["updated", "unchanged"]);
    expect(committed.json().customFields).toMatchObject({ storedAs: "lead", leads: 1 });
    const contacts = await db.select().from(schema.contacts).where(inArray(schema.contacts.id, ids));
    const byEmail = new Map(contacts.map((contact) => [contact.normalizedEmail, contact]));
    expect(byEmail.get(withLine)).toMatchObject({ firstName: "Old", company: "Keep", customFields: { icebreaker: "Great talk" } });
    expect(byEmail.get(withoutLine)).toMatchObject({ firstName: "Old", company: "Keep", customFields: {} });
    const members = await db.select({ contactId: schema.contactListMembers.contactId }).from(schema.contactListMembers).innerJoin(schema.contactLists, eq(schema.contactListMembers.contactListId, schema.contactLists.id)).where(and(eq(schema.contactLists.workspaceId, userA.workspaceId), eq(schema.contactLists.name, listName)));
    expect(members).toEqual([]);
  });

  it("returns one CSV campaign update per campaign, enrolls only new membership rows, and returns no updates on commit retry", async () => {
    const fixture = await createLinkedListFixture();
    try {
      const firstEmail = `csv-first-${fixture.listId}@example.com`;
      const secondEmail = `csv-second-${fixture.listId}@example.com`;
      const preview = await app.inject({ method: "POST", url: "/v1/imports/preview", headers: { cookie: userA.cookie }, payload: {
        mode: "add_and_update", listId: fixture.listId,
        csv: `email,firstName\n${fixture.pastEmail},Past\n${fixture.waitingEmail},Updated waiting\n${fixture.outsideEmail},Updated outside\n${firstEmail},First\n${secondEmail},Second`,
      } });
      expect(preview.statusCode).toBe(200);
      expect(preview.json().import.rows.map((row: { action: string }) => row.action)).toEqual(["unchanged", "update", "update", "create", "create"]);
      const commitUrl = `/v1/imports/${preview.json().import.id}/commit`;
      const committed = await app.inject({ method: "POST", url: commitUrl, headers: { cookie: userA.cookie } });
      expect(committed.statusCode).toBe(200);
      expect(committed.json().import.stats).toMatchObject({ createdRows: 2, updatedRows: 2, unchangedRows: 1 });
      const expectedUpdates = fixture.campaigns.map((campaign) => ({ campaignId: campaign.id, name: campaign.name, enrolled: 3, restarted: campaign.status === "completed", blockedReason: null }));
      expect(committed.json().campaignUpdates).toHaveLength(2);
      expect(committed.json().campaignUpdates).toEqual(expect.arrayContaining(expectedUpdates));

      const addedContacts = await db.select().from(schema.contacts).where(and(eq(schema.contacts.workspaceId, userA.workspaceId), inArray(schema.contacts.normalizedEmail, [fixture.outsideEmail, firstEmail, secondEmail])));
      expect(addedContacts).toHaveLength(3);
      const newMemberIds = addedContacts.map((contact) => contact.id).sort();
      const enrollmentsAfterCommit = await db.select().from(schema.enrollments).where(inArray(schema.enrollments.campaignId, fixture.campaignIds)).orderBy(schema.enrollments.id);
      // A lead can run in several campaigns at once, so new members join both campaigns.
      expect(enrollmentsAfterCommit).toHaveLength(8);
      expect(enrollmentsAfterCommit.filter((enrollment) => enrollment.contactId === fixture.pastContactId)).toEqual(fixture.enrollments);
      for (const campaign of fixture.campaigns) {
        const newEnrollments = enrollmentsAfterCommit.filter((enrollment) => enrollment.campaignId === campaign.id && enrollment.contactId !== fixture.pastContactId);
        const expectedMemberIds = newMemberIds;
        expect(newEnrollments.map((enrollment) => enrollment.contactId).sort()).toEqual(expectedMemberIds);
        expect(newEnrollments).toEqual(expect.arrayContaining(expectedMemberIds.map((contactId) => expect.objectContaining({ contactId, status: "scheduled", sequenceVersionId: campaign.versionId, emailAccountId: fixture.mailboxId }))));
      }
      expect(enrollmentsAfterCommit.some((enrollment) => enrollment.contactId === fixture.waitingContactId)).toBe(false);
      const campaignsAfterCommit = await db.select().from(schema.campaigns).where(inArray(schema.campaigns.id, fixture.campaignIds)).orderBy(schema.campaigns.id);
      expect(campaignsAfterCommit.every((campaign) => campaign.status === "active")).toBe(true);
      const newEnrollmentIds = enrollmentsAfterCommit.filter((enrollment) => enrollment.contactId !== fixture.pastContactId).map((enrollment) => enrollment.id);
      const messagesAfterCommit = await db.select().from(schema.messages).where(inArray(schema.messages.enrollmentId, newEnrollmentIds)).orderBy(schema.messages.id);
      expect(messagesAfterCommit).toHaveLength(6);

      const retried = await app.inject({ method: "POST", url: commitUrl, headers: { cookie: userA.cookie } });
      expect(retried.statusCode).toBe(200);
      expect(retried.json().campaignUpdates).toEqual([]);
      expect(retried.json().import.stats).toEqual(committed.json().import.stats);
      expect(await db.select().from(schema.enrollments).where(inArray(schema.enrollments.campaignId, fixture.campaignIds)).orderBy(schema.enrollments.id)).toEqual(enrollmentsAfterCommit);
      expect(await db.select().from(schema.messages).where(inArray(schema.messages.enrollmentId, newEnrollmentIds)).orderBy(schema.messages.id)).toEqual(messagesAfterCommit);
      expect(await db.select().from(schema.campaigns).where(inArray(schema.campaigns.id, fixture.campaignIds)).orderBy(schema.campaigns.id)).toEqual(campaignsAfterCommit);

      const nextPreview = await app.inject({ method: "POST", url: "/v1/imports/preview", headers: { cookie: userA.cookie }, payload: { listId: fixture.listId, csv: `email\ncsv-next-${fixture.listId}@example.com` } });
      expect(nextPreview.statusCode).toBe(200);
      const nextCommit = await app.inject({ method: "POST", url: `/v1/imports/${nextPreview.json().import.id}/commit`, headers: { cookie: userA.cookie } });
      expect(nextCommit.statusCode).toBe(200);
      expect(nextCommit.json().campaignUpdates).toHaveLength(2);
      expect(nextCommit.json().campaignUpdates).toEqual(expect.arrayContaining(fixture.campaigns.map((campaign) => ({ campaignId: campaign.id, name: campaign.name, enrolled: 1, restarted: false, blockedReason: null }))));
      expect(await db.select().from(schema.enrollments).where(inArray(schema.enrollments.campaignId, fixture.campaignIds))).toHaveLength(10);
      expect(await db.select().from(schema.enrollments).where(and(inArray(schema.enrollments.campaignId, fixture.campaignIds), eq(schema.enrollments.contactId, fixture.pastContactId))).orderBy(schema.enrollments.id)).toEqual(fixture.enrollments);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each(["API", "MCP"] as const)("returns linked-list campaignUpdates through the leads.import %s transport", async (transport) => {
    const fixture = await createLinkedListFixture();
    let apiKeyId: string | undefined;
    try {
      const email = `transport-${fixture.listId}@example.com`;
      const payload = { listName: fixture.listName, leads: [{ email, firstName: "Transport lead" }] };
      let result: { imported: number; listId: string; campaignUpdates: unknown[] };
      if (transport === "API") {
        const imported = await app.inject({ method: "POST", url: "/v1/leads/import", headers: { cookie: userA.cookie }, payload });
        expect(imported.statusCode).toBe(200);
        result = imported.json();
      } else {
        const key = await app.inject({ method: "POST", url: "/v1/api-keys", headers: { cookie: userA.cookie }, payload: { name: `Import transport ${fixture.listId}` } });
        expect(key.statusCode).toBe(201);
        apiKeyId = key.json().apiKey.id as string;
        const called = await app.inject({ method: "POST", url: "/mcp", headers: { authorization: `Bearer ${key.json().key as string}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, payload: { jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: { name: "inboxjoy_leads_import", arguments: payload } } });
        expect(called.statusCode).toBe(200);
        expect(called.json().result.isError).not.toBe(true);
        result = JSON.parse(called.json().result.content[0].text);
      }
      expect(result).toMatchObject({ imported: 1, listId: fixture.listId });
      expect(result.campaignUpdates).toHaveLength(2);
      expect(result.campaignUpdates).toEqual(expect.arrayContaining(fixture.campaigns.map((campaign) => ({ campaignId: campaign.id, name: campaign.name, enrolled: 1, restarted: campaign.status === "completed", blockedReason: null }))));
    } finally {
      if (apiKeyId) await db.delete(schema.apiKeys).where(eq(schema.apiKeys.id, apiKeyId));
      await fixture.cleanup();
    }
  });

  it("stores a maximum-size preview without exceeding PostgreSQL parameter limits", async () => {
    const csv = ["email,company", ...Array.from({ length: 10_000 }, (_, index) => `bulk-${suffix}-${index}@example.com,Example`)].join("\n");
    const response = await app.inject({ method: "POST", url: "/v1/imports/preview", headers: { cookie: userA.cookie }, payload: { csv } });
    expect(response.statusCode).toBe(200);
    expect(response.json().import.stats).toMatchObject({ totalRows: 10_000, readyRows: 10_000 });
    const rows = await db.select({ id: schema.importRows.id }).from(schema.importRows).where(eq(schema.importRows.importId, response.json().import.id));
    expect(rows).toHaveLength(10_000);
  }, 30_000);

  it("honors skipped columns and rechecks suppressions at commit", async () => {
    const email = `mapped-${suffix}@example.com`;
    const blockedEmail = `blocked-later-${suffix}@example.com`;
    const created = await app.inject({ method: "POST", url: "/v1/leads", headers: { cookie: userA.cookie }, payload: { email, firstName: "Original", company: "Keep" } });
    const preview = await app.inject({ method: "POST", url: "/v1/imports/preview", headers: { cookie: userA.cookie }, payload: {
      mode: "add_and_update", csv: `email,firstName,company\n${email},Updated,Ignored\n${blockedEmail},New,Ignored`, fieldMapping: { email: "email", firstName: "firstName" },
    } });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().import.rows[0].changedFields).toEqual({ firstName: { before: "Original", after: "Updated" } });
    await db.insert(schema.suppressions).values({ id: randomUUID(), workspaceId: userA.workspaceId, normalizedEmail: blockedEmail, emailHash: createHash("sha256").update(blockedEmail).digest("hex"), reason: "manual", source: "test" });
    const committed = await app.inject({ method: "POST", url: `/v1/imports/${preview.json().import.id}/commit`, headers: { cookie: userA.cookie } });
    expect(committed.statusCode).toBe(200);
    expect(committed.json().import.stats).toMatchObject({ createdRows: 0, updatedRows: 1, suppressedRows: 1, skippedRows: 1 });
    const [contact] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, created.json().lead.id));
    expect(contact).toMatchObject({ firstName: "Updated", company: "Keep" });
    expect(committed.json().import.rows[1]).toMatchObject({ status: "suppressed" });
  });

});
