import { loadAppEnv } from "@inboxjoy/config";
import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { readDeliveryAdvisor } from "@inboxjoy/core";
import { buildApp } from "../src/app.js";
import { createAuthenticatedSession, type AuthenticatedSession } from "./auth-helper.js";

// Wrap (not replace) the real implementation: the "enabled" tests still need
// genuine reads, but every test can now assert whether the advisor read ran
// at all, not just infer it from the response body.
vi.mock("@inboxjoy/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@inboxjoy/core")>();
  return { ...actual, readDeliveryAdvisor: vi.fn(actual.readDeliveryAdvisor) };
});

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("delivery advisor route", () => {
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);
  const baseEnv = { NODE_ENV: "test" as const, DATABASE_URL: databaseUrl ?? "postgresql://localhost/inboxjoy_test", API_BASE_URL: "https://api.example.test", WEB_BASE_URL: "https://app.example.test", AUTH_SECRET: "delivery-advisor-auth-secret-at-least-32-characters", LOG_LEVEL: "silent" as const };

  let setupApp: Awaited<ReturnType<typeof buildApp>>;
  let owner: AuthenticatedSession;
  let other: AuthenticatedSession;
  let mailboxId: string;
  let sequenceId: string;
  let campaignId: string;
  let foreignCampaignId: string;
  let apiKey: string;

  async function createCampaignFixture(workspaceId: string, userId: string) {
    const mailbox = randomUUID();
    const email = `${mailbox}@example.com`;
    await db.insert(schema.emailAccounts).values({ id: mailbox, workspaceId, userId, provider: "gmail", composioConnectedAccountId: mailbox, email, normalizedEmail: email, alias: mailbox, status: "active" });
    const sequence = randomUUID();
    const version = randomUUID();
    const step = randomUUID();
    await db.insert(schema.sequences).values({ id: sequence, workspaceId, name: "Advisor route sequence", status: "active", createdByUserId: userId });
    await db.insert(schema.sequenceVersions).values({ id: version, workspaceId, sequenceId: sequence, version: 1, status: "active", createdByUserId: userId });
    await db.update(schema.sequences).set({ currentVersionId: version }).where(eq(schema.sequences.id, sequence));
    await db.insert(schema.sequenceSteps).values({ id: step, workspaceId, sequenceVersionId: version, stepOrder: 1, delayDays: 0, subject: "Hello", bodyText: "Hello" });
    const campaign = randomUUID();
    await db.insert(schema.campaigns).values({ id: campaign, workspaceId, sequenceId: sequence, emailAccountId: mailbox, name: "Advisor route campaign", status: "active", launchedAt: new Date(), createdByUserId: userId });
    await db.insert(schema.subscriptions).values({ id: randomUUID(), workspaceId, status: "active" });
    return { mailboxId: mailbox, sequenceId: sequence, campaignId: campaign };
  }

  beforeAll(async () => {
    setupApp = await buildApp({ env: loadAppEnv(baseEnv), db });
    owner = await createAuthenticatedSession(setupApp, "Advisor Owner");
    other = await createAuthenticatedSession(setupApp, "Advisor Foreign");
    const fixture = await createCampaignFixture(owner.workspaceId, owner.userId);
    mailboxId = fixture.mailboxId;
    sequenceId = fixture.sequenceId;
    campaignId = fixture.campaignId;
    const foreignFixture = await createCampaignFixture(other.workspaceId, other.userId);
    foreignCampaignId = foreignFixture.campaignId;

    const keyResponse = await setupApp.inject({ method: "POST", url: "/v1/api-keys", headers: { cookie: owner.cookie }, payload: { name: "Advisor key" } });
    expect(keyResponse.statusCode).toBe(201);
    apiKey = keyResponse.json().key as string;
    await setupApp.close();
  });

  beforeEach(() => {
    vi.mocked(readDeliveryAdvisor).mockClear();
  });

  afterAll(async () => {
    for (const session of [owner, other]) {
      if (session) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, session.workspaceId));
    }
    for (const session of [owner, other]) {
      if (!session) continue;
      await db.delete(schema.users).where(eq(schema.users.id, session.userId));
      await db.delete(schema.authUsers).where(eq(schema.authUsers.id, session.userId));
    }
    await pool.end();
  });

  describe("when the workspace is not on the allowlist (default)", () => {
    let app: Awaited<ReturnType<typeof buildApp>>;
    beforeAll(async () => { app = await buildApp({ env: loadAppEnv(baseEnv), db }); });
    afterAll(async () => { await app.close(); });

    it("returns only {enabled:false} and never performs an advisor read, even for a real campaign", async () => {
      const response = await app.inject({ method: "GET", url: `/v1/campaigns/${campaignId}/delivery-advisor`, headers: { cookie: owner.cookie } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ enabled: false });
      expect(readDeliveryAdvisor).not.toHaveBeenCalled();
    });

    it("still returns {enabled:false} rather than leaking a foreign campaign's not-found status", async () => {
      const response = await app.inject({ method: "GET", url: `/v1/campaigns/${foreignCampaignId}/delivery-advisor`, headers: { cookie: owner.cookie } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ enabled: false });
      expect(readDeliveryAdvisor).not.toHaveBeenCalled();
    });
  });

  describe("when the workspace is on the allowlist", () => {
    let app: Awaited<ReturnType<typeof buildApp>>;
    beforeAll(async () => {
      app = await buildApp({ env: loadAppEnv({ ...baseEnv, DELIVERY_ADVISOR_WORKSPACE_IDS: owner.workspaceId }), db });
    });
    afterAll(async () => { await app.close(); });

    it("returns a ready snapshot scoped to the authenticated workspace, for a session", async () => {
      const response = await app.inject({ method: "GET", url: `/v1/campaigns/${campaignId}/delivery-advisor`, headers: { cookie: owner.cookie } });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.enabled).toBe(true);
      expect(["ready", "partial"]).toContain(body.status);
      expect(body.snapshot.campaignId).toBe(campaignId);
      expect(body.snapshot.senders[0]).toMatchObject({ emailAccountId: mailboxId });
      expect(readDeliveryAdvisor).toHaveBeenCalledTimes(1);
    });

    it("returns the same snapshot for a workspace-pinned API key", async () => {
      const response = await app.inject({ method: "GET", url: `/v1/campaigns/${campaignId}/delivery-advisor`, headers: { authorization: `Bearer ${apiKey}` } });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.enabled).toBe(true);
      expect(body.snapshot.campaignId).toBe(campaignId);
    });

    it("returns 404 for a campaign that belongs to a different workspace, exposing no campaign data", async () => {
      const response = await app.inject({ method: "GET", url: `/v1/campaigns/${foreignCampaignId}/delivery-advisor`, headers: { cookie: owner.cookie } });
      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain(foreignCampaignId);
    });

    it("returns 404 for an unknown campaign id", async () => {
      const response = await app.inject({ method: "GET", url: `/v1/campaigns/${randomUUID()}/delivery-advisor`, headers: { cookie: owner.cookie } });
      expect(response.statusCode).toBe(404);
    });

    it("returns 400 for a malformed campaign id instead of querying the database", async () => {
      const response = await app.inject({ method: "GET", url: "/v1/campaigns/not-a-uuid/delivery-advisor", headers: { cookie: owner.cookie } });
      expect(response.statusCode).toBe(400);
      expect(readDeliveryAdvisor).not.toHaveBeenCalled();
    });

    it("requires authentication like every other /v1 route", async () => {
      const response = await app.inject({ method: "GET", url: `/v1/campaigns/${campaignId}/delivery-advisor` });
      expect(response.statusCode).toBe(401);
    });
  });
});
