import { loadAppEnv } from "@inboxjoy/config";
import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { disabledTransactionalEmailService, type TransactionalEmailService } from "@inboxjoy/email";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { createAuthenticatedSession } from "./auth-helper.js";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("custom lead variables over REST", () => {
  const suffix = randomUUID().slice(0, 8);
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);
  const sent: Array<{ subject: string; body: string }> = [];
  const transactionalEmail: TransactionalEmailService = {
    ...disabledTransactionalEmailService,
    enabled: true,
    senderAddress: `azure-${suffix}@example.com`,
    async sendWelcome() {},
    async sendPasswordReset() {},
    async sendSequenceTest(input) { sent.push({ subject: input.subject, body: input.plainText }); },
  };
  const env = loadAppEnv({ ...process.env, NODE_ENV: "test", DATABASE_URL: databaseUrl ?? "postgresql://localhost/inboxjoy_test", API_BASE_URL: "https://api.example.test", WEB_BASE_URL: "https://app.example.test", CORS_ORIGINS: "https://app.example.test", AUTH_SECRET: "lead-variables-api-secret-at-least-32-chars" });
  const inboxId = randomUUID();
  const listId = randomUUID();
  const withValue = randomUUID();
  const without = randomUUID();
  let app: Awaited<ReturnType<typeof buildApp>>;
  let session: Awaited<ReturnType<typeof createAuthenticatedSession>>;

  beforeAll(async () => {
    app = await buildApp({ env, db, transactionalEmail });
    session = await createAuthenticatedSession(app, `Variables ${suffix}`);
    const workspaceId = session.workspaceId;
    await db.insert(schema.emailAccounts).values({ id: inboxId, workspaceId, userId: session.userId, provider: "gmail", composioConnectedAccountId: `lv-${suffix}`, email: `sender-${suffix}@example.com`, normalizedEmail: `sender-${suffix}@example.com`, alias: `lv-${suffix}`, status: "active" });
    await db.insert(schema.contactLists).values({ id: listId, workspaceId, name: `Variables ${suffix}` });
    await db.insert(schema.contacts).values([
      { id: withValue, workspaceId, email: `with-${suffix}@example.com`, normalizedEmail: `with-${suffix}@example.com`, firstName: "Wendy", status: "active" },
      { id: without, workspaceId, email: `without-${suffix}@example.com`, normalizedEmail: `without-${suffix}@example.com`, firstName: "Walt", status: "active" },
    ]);
    await db.insert(schema.contactListMembers).values([withValue, without].map((contactId) => ({ workspaceId, contactListId: listId, contactId })));
  });

  afterAll(async () => {
    await app?.close();
    if (session) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, session.workspaceId));
    await pool.end();
  });

  it("blocks launch with a structured 409, then launches once values arrive; test sends use the lead's values", async () => {
    const headers = { cookie: session.cookie };
    const created = await app.inject({ method: "POST", url: "/v1/sequences", headers, payload: { name: `Variables ${suffix}`, steps: [{ delayDays: 0, subject: "Hi {{firstName}}", body: "{{icebreaker}} Worth a chat?" }] } });
    const sequenceId = created.json().sequence.id as string;
    const campaign = await app.inject({ method: "POST", url: "/v1/campaigns", headers, payload: { name: `Variables campaign ${suffix}`, sequenceId, listIds: [listId], inboxId } });
    const campaignId = campaign.json().campaign.id as string;
    await db.insert(schema.campaignLeadVariables).values({ sequenceId, contactId: withValue, workspaceId: session.workspaceId, values: { icebreaker: "Congrats on the launch." } });

    const audience = await app.inject({ method: "POST", url: "/v1/campaigns/audience-preview", headers, payload: { campaignId, listIds: [listId] } });
    expect(audience.json().missingVariables).toMatchObject({ total: 1, byVariable: { icebreaker: 1 }, sampleEmails: [`without-${suffix}@example.com`] });

    const blocked = await app.inject({ method: "POST", url: `/v1/campaigns/${campaignId}/launch`, headers });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ code: "missing_variables", error: expect.stringContaining("1 lead is missing {{icebreaker}}"), details: { total: 1, variables: ["icebreaker"], byVariable: { icebreaker: 1 }, sampleEmails: [`without-${suffix}@example.com`] } });
    expect(await db.select().from(schema.enrollments).where(eq(schema.enrollments.sequenceId, sequenceId))).toHaveLength(0);

    const placeholderSend = await app.inject({ method: "POST", url: `/v1/sequences/${sequenceId}/test-send`, headers, payload: { stepOrder: 1, to: session.email } });
    expect(placeholderSend.statusCode).toBe(200);
    expect(sent.at(-1)?.body).toContain("[icebreaker] Worth a chat?");
    const personalSend = await app.inject({ method: "POST", url: `/v1/sequences/${sequenceId}/test-send`, headers, payload: { stepOrder: 1, to: session.email, contactId: withValue } });
    expect(personalSend.statusCode).toBe(200);
    expect(sent.at(-1)?.body).toContain("Congrats on the launch. Worth a chat?");

    await db.insert(schema.campaignLeadVariables).values({ sequenceId, contactId: without, workspaceId: session.workspaceId, values: { icebreaker: "Saw your post." } });
    const launched = await app.inject({ method: "POST", url: `/v1/campaigns/${campaignId}/launch`, headers });
    expect(launched.statusCode).toBe(200);
    expect(launched.json().enrollment.enrolled).toBe(2);
  });
});
