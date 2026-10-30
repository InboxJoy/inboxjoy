import { loadAppEnv } from "@inboxjoy/config";
import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { createAuthenticatedSession } from "./auth-helper.js";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("lead variable routes and CSV custom columns", () => {
  const suffix = randomUUID().slice(0, 8);
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);
  const env = loadAppEnv({ ...process.env, NODE_ENV: "test", DATABASE_URL: databaseUrl ?? "postgresql://localhost/inboxjoy_test", API_BASE_URL: "https://api.example.test", WEB_BASE_URL: "https://app.example.test", CORS_ORIGINS: "https://app.example.test", AUTH_SECRET: "lead-variables-rest-secret-at-least-32-chars" });
  let app: Awaited<ReturnType<typeof buildApp>>;
  let session: Awaited<ReturnType<typeof createAuthenticatedSession>>;
  let foreign: Awaited<ReturnType<typeof createAuthenticatedSession>>;
  let headers: { cookie: string };
  let workspaceId = "";
  let sequenceId = "";
  let campaignId = "";
  let campaignListId = "";
  let readyId = "";
  const inboxId = randomUUID();

  async function contact(label: string, customFields: Record<string, unknown> = {}) {
    const id = randomUUID();
    const email = `${label}-${suffix}@example.com`;
    await db.insert(schema.contacts).values({ id, workspaceId, email, normalizedEmail: email, firstName: label, status: "active", customFields });
    return { id, email };
  }

  async function addToCampaignList(contactId: string) {
    await db.insert(schema.contactListMembers).values({ workspaceId, contactListId: campaignListId, contactId });
  }

  async function importCsv(payload: Record<string, unknown>) {
    const preview = await app.inject({ method: "POST", url: "/v1/imports/preview", headers, payload });
    if (preview.statusCode !== 200) return { preview, commit: undefined };
    const commit = await app.inject({ method: "POST", url: `/v1/imports/${preview.json().import.id as string}/commit`, headers });
    return { preview, commit };
  }

  async function enrollmentCount() {
    return (await db.select().from(schema.enrollments).where(eq(schema.enrollments.sequenceId, sequenceId))).length;
  }

  beforeAll(async () => {
    app = await buildApp({ env, db });
    session = await createAuthenticatedSession(app, `Variables REST ${suffix}`);
    foreign = await createAuthenticatedSession(app, `Variables foreign ${suffix}`);
    headers = { cookie: session.cookie };
    workspaceId = session.workspaceId;
    await db.insert(schema.emailAccounts).values({ id: inboxId, workspaceId, userId: session.userId, provider: "gmail", composioConnectedAccountId: `lvr-${suffix}`, email: `sender-${suffix}@example.com`, normalizedEmail: `sender-${suffix}@example.com`, alias: `lvr-${suffix}`, status: "active" });
    campaignListId = randomUUID();
    await db.insert(schema.contactLists).values({ id: campaignListId, workspaceId, name: `Audience ${suffix}` });
    const ready = await contact("ready", { hook: "from lead" });
    readyId = ready.id;
    await addToCampaignList(ready.id);
    const created = await app.inject({ method: "POST", url: "/v1/sequences", headers, payload: { name: `Variables ${suffix}`, steps: [{ delayDays: 0, subject: "Hi {{firstName}}", body: "{{icebreaker}} Worth a chat? {{hook}}" }] } });
    sequenceId = created.json().sequence.id as string;
    const campaign = await app.inject({ method: "POST", url: "/v1/campaigns", headers, payload: { name: `Variables campaign ${suffix}`, sequenceId, listIds: [campaignListId], inboxId } });
    campaignId = campaign.json().campaign.id as string;
    await db.insert(schema.campaignLeadVariables).values({ sequenceId, contactId: ready.id, workspaceId, values: { icebreaker: "Campaign line" } });
    const launched = await app.inject({ method: "POST", url: `/v1/campaigns/${campaignId}/launch`, headers });
    expect(launched.statusCode).toBe(200);
  });

  afterAll(async () => {
    await app?.close();
    for (const item of [session, foreign]) if (item) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, item.workspaceId));
    await pool.end();
  });

  it("reads the grid, filters, and isolates other workspaces", async () => {
    const waiting = await contact("grid-waiting");
    await addToCampaignList(waiting.id);
    const grid = await app.inject({ method: "GET", url: `/v1/sequences/${sequenceId}/lead-variables`, headers });
    expect(grid.statusCode).toBe(200);
    const body = grid.json();
    expect(body).toMatchObject({ audienceTotal: 2, total: 2, page: 1, pageSize: 50 });
    expect(body.variables).toEqual([{ name: "hook", ready: 1, missing: 1 }, { name: "icebreaker", ready: 1, missing: 1 }]);
    expect(body.leads.find((lead: { contactId: string }) => lead.contactId === readyId)).toMatchObject({ values: { icebreaker: { value: "Campaign line", source: "campaign" }, hook: { value: "from lead", source: "lead" } }, missing: [] });

    const missing = await app.inject({ method: "GET", url: `/v1/sequences/${sequenceId}/lead-variables?filter=missing&variable=hook&page=1&pageSize=10&search=grid-waiting`, headers });
    expect(missing.json()).toMatchObject({ total: 1, pageSize: 10, leads: [{ contactId: waiting.id, missing: ["hook", "icebreaker"] }] });

    expect((await app.inject({ method: "GET", url: `/v1/sequences/${sequenceId}/lead-variables?filter=bogus`, headers })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/v1/sequences/${sequenceId}/lead-variables?page=abc`, headers })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/v1/sequences/${sequenceId}/lead-variables`, headers: { cookie: foreign.cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: "PUT", url: `/v1/sequences/${sequenceId}/lead-variables`, headers: { cookie: foreign.cookie }, payload: { leads: [{ contactId: waiting.id, variables: { icebreaker: "leak" } }] } })).statusCode).toBe(404);
    expect(await db.select().from(schema.campaignLeadVariables).where(and(eq(schema.campaignLeadVariables.contactId, waiting.id)))).toHaveLength(0);
  });

  it("writes values with PUT, wakes the waiting lead, and lists variable names", async () => {
    const waiting = await contact("put-waiting", { hook: "ok" });
    await addToCampaignList(waiting.id);
    const before = await enrollmentCount();
    expect((await app.inject({ method: "PUT", url: `/v1/sequences/${sequenceId}/lead-variables`, headers, payload: { leads: "nope" } })).statusCode).toBe(400);
    const tooMany = await app.inject({ method: "PUT", url: `/v1/sequences/${sequenceId}/lead-variables`, headers, payload: { leads: Array.from({ length: 1001 }, () => ({ contactId: waiting.id, variables: { icebreaker: "x" } })) } });
    expect(tooMany.statusCode).toBe(400);
    const written = await app.inject({ method: "PUT", url: `/v1/sequences/${sequenceId}/lead-variables`, headers, payload: { leads: [{ contactId: waiting.id, variables: { icebreaker: "Wake line" } }, { contactId: randomUUID(), variables: { icebreaker: "x" } }] } });
    expect(written.statusCode).toBe(200);
    expect(written.json()).toMatchObject({ sequenceId, updated: 1, enrolled: 1, rerendered: 0, stillMissing: [] });
    expect(written.json().notFound).toHaveLength(1);
    expect(await enrollmentCount()).toBe(before + 1);

    const names = await app.inject({ method: "GET", url: "/v1/lead-variables/names", headers });
    expect(names.statusCode).toBe(200);
    expect(names.json()).toEqual({ names: ["hook", "icebreaker"] });
    expect((await app.inject({ method: "GET", url: "/v1/lead-variables/names", headers: { cookie: foreign.cookie } })).json()).toEqual({ names: [] });
  });

  it("validates custom: mappings and variablesSequenceId", async () => {
    const csv = `Email,Line,Topic\nvalid-${suffix}@example.com,a,b`;
    const bad = async (fieldMapping: Record<string, string>) => (await app.inject({ method: "POST", url: "/v1/imports/preview", headers, payload: { csv, fieldMapping } }));
    expect((await bad({ Email: "email", Line: "custom:firstName" })).statusCode).toBe(400);
    expect((await bad({ Email: "email", Line: "custom:company_name" })).statusCode).toBe(400);
    expect((await bad({ Email: "email", Line: "custom:bad name" })).statusCode).toBe(400);
    const duplicate = await bad({ Email: "email", Line: "custom:x", Topic: "custom:x" });
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.json().error).toMatch(/only one column/i);
    const good = await app.inject({ method: "POST", url: "/v1/imports/preview", headers, payload: { csv, fieldMapping: { Email: "email", Line: "custom:icebreaker", Topic: "custom:topic" } } });
    expect(good.statusCode).toBe(200);
    expect(good.json().import).toMatchObject({ customFields: ["icebreaker", "topic"], stats: { totalRows: 1, createRows: 1 } });
    expect(good.json().import.rows[0].customValues).toBeUndefined();
    const base = { csv, fieldMapping: { Email: "email", Line: "custom:icebreaker" } };
    expect((await app.inject({ method: "POST", url: "/v1/imports/preview", headers, payload: { ...base, variablesSequenceId: "not-a-uuid" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/v1/imports/preview", headers, payload: { ...base, variablesSequenceId: randomUUID() } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/v1/imports/preview", headers: { cookie: foreign.cookie }, payload: { ...base, variablesSequenceId: sequenceId } })).statusCode).toBe(404);
  });

  it("stores custom columns as campaign variables when variablesSequenceId is set, then wakes waiting leads", async () => {
    const waiting = await contact("csv-waiting", { hook: "ok" });
    await addToCampaignList(waiting.id);
    const newcomerEmail = `csv-newcomer-${suffix}@example.com`;
    const before = await enrollmentCount();
    const { preview, commit } = await importCsv({
      mode: "add_and_update",
      listName: `Imported ${suffix}`,
      variablesSequenceId: sequenceId,
      fieldMapping: { Email: "email", Line: "custom:icebreaker" },
      csv: `Email,Line\n${waiting.email},Wake from CSV\n${newcomerEmail},Newcomer line`,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().import).toMatchObject({ customFields: ["icebreaker"], variablesSequenceId: sequenceId });
    expect(commit?.statusCode).toBe(200);
    expect(commit?.json().customFields).toMatchObject({ storedAs: "campaign", sequenceId, leads: 2, enrolledWaiting: 1 });
    expect(commit?.json().import).toMatchObject({ customFields: ["icebreaker"], variablesSequenceId: sequenceId });
    const stored = await db.select().from(schema.campaignLeadVariables).where(eq(schema.campaignLeadVariables.sequenceId, sequenceId));
    const [newcomer] = await db.select().from(schema.contacts).where(and(eq(schema.contacts.workspaceId, workspaceId), eq(schema.contacts.normalizedEmail, newcomerEmail)));
    expect(stored.find((row) => row.contactId === waiting.id)?.values).toEqual({ icebreaker: "Wake from CSV" });
    expect(stored.find((row) => row.contactId === newcomer!.id)?.values).toEqual({ icebreaker: "Newcomer line" });
    // Lead custom fields stay untouched on this path.
    expect(newcomer?.customFields).toEqual({});
    const [waitingRow] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, waiting.id));
    expect(waitingRow?.customFields).toEqual({ hook: "ok" });
    expect(await enrollmentCount()).toBe(before + 1);

    // The stored import record keeps the mapping and the target sequence.
    const [record] = await db.select().from(schema.imports).where(eq(schema.imports.id, preview.json().import.id));
    expect(record?.fieldMapping).toMatchObject({ "custom:icebreaker": "Line" });
    expect(record?.options).toMatchObject({ variablesSequenceId: sequenceId });
  });

  it("merges custom columns into lead custom fields otherwise, leaving empty cells unchanged, and wakes waiting leads", async () => {
    const keeper = await contact("csv-keeper", { icebreaker: "keep me", topic: "old topic" });
    const waiting = await contact("csv-lead-waiting", { hook: "ok" });
    await addToCampaignList(waiting.id);
    const newcomerEmail = `csv-lead-new-${suffix}@example.com`;
    const before = await enrollmentCount();
    const { commit } = await importCsv({
      mode: "add_and_update",
      listName: `Lead fields ${suffix}`,
      fieldMapping: { Email: "email", Line: "custom:icebreaker", Topic: "custom:topic" },
      csv: `Email,Line,Topic\n${keeper.email},,new topic\n${waiting.email},Wake via lead field,\n${newcomerEmail},New line,New topic`,
    });
    expect(commit?.statusCode).toBe(200);
    expect(commit?.json().customFields).toMatchObject({ storedAs: "lead", leads: 3, enrolledWaiting: 1 });
    const fields = async (id: string) => (await db.select().from(schema.contacts).where(eq(schema.contacts.id, id)))[0]?.customFields;
    expect(await fields(keeper.id)).toEqual({ icebreaker: "keep me", topic: "new topic" });
    expect(await fields(waiting.id)).toEqual({ hook: "ok", icebreaker: "Wake via lead field" });
    const [newcomer] = await db.select().from(schema.contacts).where(and(eq(schema.contacts.workspaceId, workspaceId), eq(schema.contacts.normalizedEmail, newcomerEmail)));
    expect(newcomer?.customFields).toEqual({ icebreaker: "New line", topic: "New topic" });
    expect(await enrollmentCount()).toBe(before + 1);
    expect(await db.select().from(schema.campaignLeadVariables).where(eq(schema.campaignLeadVariables.contactId, keeper.id))).toHaveLength(0);
  });
});
