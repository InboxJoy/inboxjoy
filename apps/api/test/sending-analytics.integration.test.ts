import { loadAppEnv } from "@inboxjoy/config";
import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { createAuthenticatedSession } from "./auth-helper.js";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("sending and analytics operations", () => {
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);
  const suffix = randomUUID().slice(0, 8);
  const ids = { inbox: randomUUID(), list: randomUUID(), secondList: randomUUID(), campaign: "", sequence: "" };
  const contacts = Array.from({ length: 4 }, () => randomUUID());
  const env = loadAppEnv({ ...process.env, NODE_ENV: "test", DATABASE_URL: databaseUrl ?? "postgresql://localhost/inboxjoy_test", API_BASE_URL: "https://api.example.test", WEB_BASE_URL: "https://app.example.test", CORS_ORIGINS: "https://app.example.test", AUTH_SECRET: "sending-analytics-test-secret-at-least-32" });
  let app: Awaited<ReturnType<typeof buildApp>>;
  let session: Awaited<ReturnType<typeof createAuthenticatedSession>>;

  beforeAll(async () => {
    app = await buildApp({ env, db });
    session = await createAuthenticatedSession(app, `Sending ${suffix}`);
    await db.update(schema.workspaces).set({ postalAddress: "123 Main St\nAustin, TX 78701" }).where(eq(schema.workspaces.id, session.workspaceId));
    await db.insert(schema.emailAccounts).values({ id: ids.inbox, workspaceId: session.workspaceId, userId: session.userId, provider: "gmail", composioConnectedAccountId: `sending-${suffix}`, email: `sender-${suffix}@example.com`, normalizedEmail: `sender-${suffix}@example.com`, alias: `sending-${suffix}`, status: "active" });
    await db.insert(schema.contactLists).values([
      { id: ids.list, workspaceId: session.workspaceId, name: `Prospects ${suffix}` },
      { id: ids.secondList, workspaceId: session.workspaceId, name: `VIP prospects ${suffix}` },
    ]);
    await db.insert(schema.contacts).values(contacts.map((id, index) => ({ id, workspaceId: session.workspaceId, email: `person-${suffix}-${index}@example.com`, normalizedEmail: `person-${suffix}-${index}@example.com`, firstName: `Person${index}`, company: index === 0 ? `Acme, Inc. ${suffix}` : `Company ${index}`, status: index === 2 ? "suppressed" : index === 3 ? "replied" : "active" })));
    await db.insert(schema.contactListMembers).values(contacts.map((contactId) => ({ workspaceId: session.workspaceId, contactListId: ids.list, contactId })));
    await db.insert(schema.contactListMembers).values({ workspaceId: session.workspaceId, contactListId: ids.secondList, contactId: contacts[0]! });
  });

  afterAll(async () => {
    await app?.close();
    if (session) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, session.workspaceId));
    await pool.end();
  });

  it("runs the complete campaign, analytics, utility, and tracking surface", async () => {
    const headers = { cookie: session.cookie };
    const templates = await app.inject({ method: "GET", url: "/v1/templates", headers });
    expect(templates.json().templates.map((item: { key: string }) => item.key)).toEqual(["cold-opener", "reactivation", "event-follow-up"]);
    expect((await app.inject({ method: "POST", url: "/v1/sequences/from-template/reactivation", headers })).statusCode).toBe(201);

    const createdSequence = await app.inject({ method: "POST", url: "/v1/sequences", headers, payload: { name: `Campaign sequence ${suffix}`, steps: [{ delayDays: 0, subject: "Hello {{firstName}}", body: "Hello there" }] } });
    ids.sequence = createdSequence.json().sequence.id;
    const createdCampaign = await app.inject({ method: "POST", url: "/v1/campaigns", headers, payload: { name: `Campaign ${suffix}`, sequenceId: ids.sequence, listIds: [ids.list, ids.secondList, ids.list], inboxId: ids.inbox } });
    expect(createdCampaign.statusCode).toBe(201);
    expect(createdCampaign.json().campaign).toMatchObject({ listIds: [ids.list, ids.secondList], listId: ids.list, contactListId: ids.list });
    ids.campaign = createdCampaign.json().campaign.id;
    expect(await db.select().from(schema.campaignContactLists).where(eq(schema.campaignContactLists.campaignId, ids.campaign))).toHaveLength(2);

    const preview = await app.inject({ method: "POST", url: "/v1/campaigns/audience-preview", headers, payload: { listIds: [ids.list, ids.secondList] } });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ eligible: 2, total: 4, skipped: { suppressed: 1, already_enrolled: 0, replied: 1, bounced: 0, unsubscribed: 0 } });

    const launched = await app.inject({ method: "POST", url: `/v1/campaigns/${ids.campaign}/launch`, headers });
    expect(launched.statusCode).toBe(200);
    expect(launched.json().enrollment.enrolled).toBe(2);
    const enrollmentRows = await db.select().from(schema.enrollments).where(eq(schema.enrollments.campaignId, ids.campaign));
    expect(enrollmentRows).toHaveLength(2);

    const enrollmentList = await app.inject({ method: "GET", url: `/v1/sequences/${ids.sequence}/enrollments?page=1&pageSize=1`, headers });
    expect(enrollmentList.json().pagination).toMatchObject({ page: 1, pageSize: 1, total: 2 });
    expect(enrollmentList.json().enrollments[0].contact.email).toContain(suffix);

    const [message] = await db.select().from(schema.messages).where(eq(schema.messages.enrollmentId, enrollmentRows[0]!.id));
    expect(message?.trackingToken).toMatch(/^[0-9a-f]{32}$/);
    const firstOpen = await app.inject({ method: "GET", url: `/t/${message!.trackingToken}.gif` });
    const secondOpen = await app.inject({ method: "GET", url: `/t/${message!.trackingToken}.gif` });
    expect(firstOpen.statusCode).toBe(200);
    expect(firstOpen.rawPayload).toHaveLength(43);
    expect(secondOpen.statusCode).toBe(200);
    const opens = await db.select().from(schema.messageEvents).where(and(eq(schema.messageEvents.messageId, message!.id), eq(schema.messageEvents.eventType, "opened")));
    expect(opens).toHaveLength(1);

    const fixedDate = new Date(); fixedDate.setUTCDate(fixedDate.getUTCDate() - 2); fixedDate.setUTCHours(12, 0, 0, 0);
    await db.update(schema.messages).set({ status: "accepted", acceptedAt: fixedDate }).where(eq(schema.messages.id, message!.id));
    await db.update(schema.messageEvents).set({ occurredAt: fixedDate }).where(eq(schema.messageEvents.id, opens[0]!.id));
    await db.update(schema.enrollments).set({ status: "replied", stoppedAt: fixedDate }).where(eq(schema.enrollments.id, enrollmentRows[0]!.id));
    await db.update(schema.contacts).set({ status: "replied", repliedAt: fixedDate }).where(eq(schema.contacts.id, enrollmentRows[0]!.contactId));

    const analytics = await app.inject({ method: "GET", url: "/v1/analytics/summary?range=7", headers });
    const bucket = analytics.json().summary.series.find((item: { date: string }) => item.date === fixedDate.toISOString().slice(0, 10));
    expect(analytics.json().summary.series).toHaveLength(7);
    expect(bucket).toMatchObject({ sent: 1, replied: 1, opened: 1 });
    expect(analytics.json().summary.bySequence).toEqual(expect.arrayContaining([expect.objectContaining({ sequenceId: ids.sequence })]));

    const campaign = await app.inject({ method: "GET", url: `/v1/campaigns/${ids.campaign}`, headers });
    expect(campaign.json().totals).toMatchObject({ enrolled: 2, sent: 1, replied: 1, opened: 1 });
    expect(campaign.json().campaign).toMatchObject({ listIds: [ids.list, ids.secondList], listId: ids.list });
    expect((await app.inject({ method: "GET", url: "/v1/campaigns", headers })).json().campaigns[0]).toHaveProperty("openRate");
    expect((await app.inject({ method: "GET", url: "/v1/sequences", headers })).json().sequences.find((item: { id: string }) => item.id === ids.sequence)).toHaveProperty("replyRate");
    expect((await app.inject({ method: "GET", url: "/v1/leads", headers })).json().leads.find((item: { id: string }) => item.id === enrollmentRows[0]!.contactId).lastTouchAt).toBe(fixedDate.toISOString());

    const leadCsv = await app.inject({ method: "GET", url: "/v1/export.csv?kind=leads", headers });
    expect(leadCsv.headers["content-type"]).toContain("text/csv");
    expect(leadCsv.body.split("\r\n")[0]).toBe("id,email,firstName,lastName,company,title,status,createdAt");
    expect(leadCsv.body).toContain(`"Acme, Inc. ${suffix}"`);
    expect((await app.inject({ method: "GET", url: "/v1/export.csv?kind=suppressions", headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/v1/export.csv?kind=campaign-results&campaignId=${ids.campaign}`, headers })).body).toContain("enrollmentId,email");

    const search = await app.inject({ method: "GET", url: `/v1/search?q=${suffix}`, headers });
    expect(search.json().results.campaigns).toHaveLength(1);
    await db.insert(schema.notifications).values({ id: randomUUID(), workspaceId: session.workspaceId, type: "reply", title: "New reply", body: "Test reply" });
    const notification = (await app.inject({ method: "GET", url: "/v1/notifications?unreadOnly=true", headers })).json().notifications[0];
    expect(notification.readAt).toBeNull();
    expect((await app.inject({ method: "POST", url: `/v1/notifications/${notification.id}/read`, headers })).json().markedRead).toBe(1);
    expect((await app.inject({ method: "POST", url: "/v1/notifications/read-all", headers })).statusCode).toBe(200);

    expect((await app.inject({ method: "POST", url: `/v1/campaigns/${ids.campaign}/pause`, headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/v1/campaigns/${ids.campaign}/resume`, headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/v1/campaigns/${ids.campaign}/pause`, headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/v1/campaigns/${ids.campaign}/archive`, headers })).statusCode).toBe(200);
  });

  it("keeps legacy campaign listId and accepts listIds when replacing a draft audience", async () => {
    const headers = { cookie: session.cookie };
    const sequence = await app.inject({ method: "POST", url: "/v1/sequences", headers, payload: { name: `Audience contract ${suffix}`, steps: [{ delayDays: 0, subject: "Hello", body: "Hello" }] } });
    const sequenceId = sequence.json().sequence.id as string;
    const created = await app.inject({ method: "POST", url: "/v1/campaigns", headers, payload: { name: `Legacy audience ${suffix}`, sequenceId, listId: ids.list, inboxId: ids.inbox } });
    expect(created.statusCode).toBe(201);
    expect(created.json().campaign).toMatchObject({ listIds: [ids.list], listId: ids.list });

    const updated = await app.inject({ method: "PATCH", url: `/v1/campaigns/${created.json().campaign.id}`, headers, payload: { listIds: [ids.secondList] } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().campaign).toMatchObject({ listIds: [ids.secondList], listId: ids.secondList, contactListId: ids.secondList });

    const ambiguous = await app.inject({ method: "PATCH", url: `/v1/campaigns/${created.json().campaign.id}`, headers, payload: { listIds: [ids.list], listId: ids.secondList } });
    expect(ambiguous.statusCode).toBe(400);
    expect(ambiguous.json()).toMatchObject({ code: "BAD_INPUT" });
  });

  it("keeps a campaign's only list until the campaign is archived from the app", async () => {
    const headers = { cookie: session.cookie };
    const listId = randomUUID();
    await db.insert(schema.contactLists).values({ id: listId, workspaceId: session.workspaceId, name: `Sole audience ${suffix}` });
    const sequence = await app.inject({ method: "POST", url: "/v1/sequences", headers, payload: { name: `Sole audience ${suffix}`, steps: [{ delayDays: 0, subject: "Hello", body: "Hello" }] } });
    const sequenceId = sequence.json().sequence.id as string;
    const campaign = await app.inject({ method: "POST", url: "/v1/campaigns", headers, payload: { name: `Sole audience ${suffix}`, sequenceId, listIds: [listId], inboxId: ids.inbox } });
    expect(campaign.statusCode).toBe(201);

    const blocked = await app.inject({ method: "DELETE", url: `/v1/lists/${listId}`, headers });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ code: "CONFLICT", error: `This list is the only audience for the draft campaign "Sole audience ${suffix}". Add another list to that campaign or archive it, then delete this list.` });
    expect(await db.select().from(schema.contactLists).where(eq(schema.contactLists.id, listId))).toHaveLength(1);

    // The app's Archive button archives the sequence and leaves the campaign row's status as is.
    expect((await app.inject({ method: "POST", url: `/v1/sequences/${sequenceId}/archive`, headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/v1/lists/${listId}`, headers })).statusCode).toBe(204);
    expect(await db.select().from(schema.contactLists).where(eq(schema.contactLists.id, listId))).toHaveLength(0);
  });

  it("blocks campaign launch until a postal address is configured", async () => {
    const headers = { cookie: session.cookie };
    const sequence = await app.inject({ method: "POST", url: "/v1/sequences", headers, payload: { name: `Postal guard ${suffix}`, steps: [{ delayDays: 0, subject: "Hello", body: "Hello" }] } });
    const sequenceId = sequence.json().sequence.id as string;
    const campaign = await app.inject({ method: "POST", url: "/v1/campaigns", headers, payload: { name: `Postal guard ${suffix}`, sequenceId, listId: ids.list, inboxId: ids.inbox } });
    await db.update(schema.workspaces).set({ postalAddress: null }).where(eq(schema.workspaces.id, session.workspaceId));

    const launch = await app.inject({ method: "POST", url: `/v1/campaigns/${campaign.json().campaign.id}/launch`, headers });

    expect(launch.statusCode).toBe(200);
    await db.update(schema.workspaces).set({ postalAddress: "123 Main St\nAustin, TX 78701" }).where(eq(schema.workspaces.id, session.workspaceId));
  });
});
