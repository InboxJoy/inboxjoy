import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { and, eq, inArray } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { findEligibleEnrollmentAudience } from "../src/enrollment-eligibility.js";
import { exportWorkspace, importWorkspace, OpError, type WorkspaceTransferFile } from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

describe.skipIf(!databaseUrl)("workspace export and import", () => {
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);
  let ownerId: string;
  let adminId: string;
  let otherOwnerId: string;
  let sourceId: string;
  let targetId: string;
  let otherId: string;
  let mailboxId: string;
  let anaId: string;

  const userIds = () => [ownerId, adminId, otherOwnerId];
  const workspaceIds = () => [sourceId, targetId, otherId];

  async function user(id: string, email: string) {
    await db.insert(schema.authUsers).values({ id, name: email, email, emailVerified: true });
    await db.insert(schema.users).values({ id, email, normalizedEmail: email, displayName: email });
  }

  async function workspace(id: string, name: string, owner: string) {
    await db.insert(schema.workspaces).values({ id, name, slug: id, createdByUserId: owner });
    await db.insert(schema.memberships).values({ id: randomUUID(), workspaceId: id, userId: owner, role: "owner", status: "active", joinedAt: new Date() });
  }

  async function sequence(workspaceId: string, name: string, status: "draft" | "active" | "archived", steps: Array<{ subject: string; bodyText: string; delayDays: number }>) {
    const sequenceId = randomUUID();
    const versionId = randomUUID();
    await db.insert(schema.sequences).values({ id: sequenceId, workspaceId, name, status });
    await db.insert(schema.sequenceVersions).values({ id: versionId, workspaceId, sequenceId, version: 1, status, snapshot: { description: `${name} description`, enrolledCount: 0 } });
    if (steps.length) await db.insert(schema.sequenceSteps).values(steps.map((step, index) => ({ id: randomUUID(), workspaceId, sequenceVersionId: versionId, stepOrder: index + 1, ...step })));
    await db.update(schema.sequences).set({ currentVersionId: versionId }).where(eq(schema.sequences.id, sequenceId));
    return { sequenceId, versionId };
  }

  const countedTables = {
    contacts: "contacts",
    lists: "contact_lists",
    listMembers: "contact_list_members",
    sequences: "sequences",
    versions: "sequence_versions",
    suppressions: "suppressions",
    campaigns: "campaigns",
    enrollments: "enrollments",
    messages: "messages",
    invitations: "invitations",
    staged: "staged_enrollments",
    leadVariables: "campaign_lead_variables",
    memberships: "memberships",
  } as const;

  async function counts(workspaceId: string): Promise<Record<keyof typeof countedTables, number>> {
    const result = {} as Record<keyof typeof countedTables, number>;
    for (const [key, table] of Object.entries(countedTables) as Array<[keyof typeof countedTables, string]>) {
      const { rows } = await pool.query<{ n: number }>(`select count(*)::int as n from ${table} where workspace_id = $1`, [workspaceId]);
      result[key] = rows[0]?.n ?? 0;
    }
    return result;
  }

  const ctx = (workspaceId: string, userId = ownerId) => ({ db, workspaceId, userId });

  beforeAll(async () => { await pool.query("select 1"); });

  beforeEach(async () => {
    ownerId = randomUUID();
    adminId = randomUUID();
    otherOwnerId = randomUUID();
    sourceId = randomUUID();
    targetId = randomUUID();
    otherId = randomUUID();
    mailboxId = randomUUID();
    anaId = randomUUID();
    await user(ownerId, `owner-${ownerId}@example.test`);
    await user(adminId, `admin-${adminId}@example.test`);
    await user(otherOwnerId, `other-${otherOwnerId}@example.test`);
    await workspace(sourceId, "Source workspace", ownerId);
    await workspace(targetId, "Fresh install", ownerId);
    await workspace(otherId, "Somebody else", otherOwnerId);
    await db.insert(schema.memberships).values({ id: randomUUID(), workspaceId: sourceId, userId: adminId, role: "admin", status: "active", joinedAt: new Date() });
    await db.update(schema.workspaces).set({ defaultTimezone: "Asia/Dubai", dailySendCap: 350, openTrackingEnabled: true, postalAddress: "1 Main St, Dubai" }).where(eq(schema.workspaces.id, sourceId));

    // Source: leads, lists, suppressions, a live campaign with history, a mailbox with secrets.
    const boId = randomUUID();
    await db.insert(schema.contacts).values([
      { id: anaId, workspaceId: sourceId, email: "Ana@Example.com", normalizedEmail: "ana@example.com", firstName: "Ana", company: "Example", customFields: { icebreaker: "Saw your talk" }, status: "enrolled", createdAt: new Date("2026-09-01T08:00:00.000Z") },
      { id: boId, workspaceId: sourceId, email: "bo@example.com", normalizedEmail: "bo@example.com", firstName: "Bo", status: "replied", repliedAt: new Date("2026-09-10T09:00:00.000Z"), createdAt: new Date("2026-09-02T08:00:00.000Z") },
    ]);
    const listId = randomUUID();
    await db.insert(schema.contactLists).values({ id: listId, workspaceId: sourceId, name: "Founders" });
    await db.insert(schema.contactListMembers).values([{ workspaceId: sourceId, contactListId: listId, contactId: anaId }, { workspaceId: sourceId, contactListId: listId, contactId: boId }]);
    await db.insert(schema.suppressions).values({ id: randomUUID(), workspaceId: sourceId, email: "gone@example.com", normalizedEmail: "gone@example.com", emailHash: sha("gone@example.com"), reason: "unsubscribed", source: "link" });
    await db.insert(schema.emailAccounts).values({ id: mailboxId, workspaceId: sourceId, userId: ownerId, provider: "smtp", composioConnectedAccountId: `composio-secret-${mailboxId}`, email: "sales@acme.test", normalizedEmail: "sales@acme.test", alias: `sales-${mailboxId}`, status: "active", dailyLimit: 40, providerMetadata: { refreshToken: "provider-secret-token" } });
    await db.insert(schema.mailboxCredentials).values({ emailAccountId: mailboxId, workspaceId: sourceId, smtpHost: "smtp.acme.test", smtpPort: 465, smtpUsername: "sales", smtpPasswordEncrypted: "smtp-secret-ciphertext", imapHost: "imap.acme.test", imapPort: 993, imapUsername: "sales", imapPasswordEncrypted: "imap-secret-ciphertext" });
    await db.insert(schema.mailboxSchedules).values({ id: randomUUID(), workspaceId: sourceId, emailAccountId: mailboxId, dayOfWeek: 1, startTime: "09:00:00", endTime: "17:00:00", timezone: "Asia/Dubai" });
    await db.insert(schema.apiKeys).values({ id: randomUUID(), workspaceId: sourceId, name: "CI", keyHash: "api-key-secret-hash", createdByUserId: ownerId });
    const live = await sequence(sourceId, "Intro", "active", [{ subject: "Hi {{firstName}}", bodyText: "{{icebreaker}}", delayDays: 0 }, { subject: "Following up", bodyText: "Any thoughts?", delayDays: 3 }]);
    await sequence(sourceId, "Retired", "archived", [{ subject: "Old", bodyText: "Old", delayDays: 0 }]);
    const campaignId = randomUUID();
    await db.insert(schema.campaigns).values({ id: campaignId, workspaceId: sourceId, sequenceId: live.sequenceId, contactListId: listId, emailAccountId: mailboxId, name: "Intro - Founders", status: "active", launchedAt: new Date() });
    await db.insert(schema.campaignContactLists).values({ campaignId, contactListId: listId, workspaceId: sourceId });
    await db.insert(schema.campaignLeadVariables).values({ sequenceId: live.sequenceId, contactId: anaId, workspaceId: sourceId, values: { icebreaker: "Loved the podcast" } });
    const [firstStep] = await db.select({ id: schema.sequenceSteps.id }).from(schema.sequenceSteps).where(and(eq(schema.sequenceSteps.sequenceVersionId, live.versionId), eq(schema.sequenceSteps.stepOrder, 1)));
    const enrollmentId = randomUUID();
    await db.insert(schema.enrollments).values({ id: enrollmentId, workspaceId: sourceId, contactId: anaId, sequenceId: live.sequenceId, sequenceVersionId: live.versionId, campaignId, emailAccountId: mailboxId, status: "active" });
    await db.insert(schema.messages).values({ id: randomUUID(), workspaceId: sourceId, enrollmentId, sequenceStepId: firstStep!.id, emailAccountId: mailboxId, contactId: anaId, status: "accepted", idempotencyKey: `${enrollmentId}:1`, scheduledAt: new Date(), recipientEmail: "Ana@Example.com", normalizedRecipientEmail: "ana@example.com", subject: "SENT-MESSAGE-SUBJECT", bodyHash: "hash" });

    // Another tenant with an overlapping address and its own campaign.
    await db.insert(schema.contacts).values([
      { id: randomUUID(), workspaceId: otherId, email: "ana@example.com", normalizedEmail: "ana@example.com", firstName: "Other tenant Ana", status: "active" },
      { id: randomUUID(), workspaceId: otherId, email: "only-other@example.com", normalizedEmail: "only-other@example.com", status: "active" },
    ]);
    await db.insert(schema.contactLists).values({ id: randomUUID(), workspaceId: otherId, name: "Other tenant list" });
    await db.insert(schema.suppressions).values({ id: randomUUID(), workspaceId: otherId, email: "other-suppressed@example.com", normalizedEmail: "other-suppressed@example.com", emailHash: sha("other-suppressed@example.com"), reason: "manual", source: "manual" });
    await sequence(otherId, "Other tenant campaign", "active", [{ subject: "Other subject", bodyText: "Other body", delayDays: 0 }]);
  });

  afterEach(async () => {
    await db.delete(schema.workspaces).where(inArray(schema.workspaces.id, workspaceIds()));
    await db.delete(schema.users).where(inArray(schema.users.id, userIds()));
    await db.delete(schema.authUsers).where(inArray(schema.authUsers.id, userIds()));
  });

  afterAll(async () => { await pool.end(); });

  it("exports only the owner's workspace and no secrets or history", async () => {
    const { file, filename } = await exportWorkspace(ctx(sourceId), { now: new Date("2026-10-29T10:00:00.000Z"), source: { edition: "cloud" } });
    const text = JSON.stringify(file);
    expect(filename).toBe("inboxjoy-source-workspace-2026-10-29.json");
    expect(file.leads.map((lead) => lead.email)).toEqual(["Ana@Example.com", "bo@example.com"]);
    expect(file.lists).toEqual([{ name: "Founders", leadEmails: ["Ana@Example.com", "bo@example.com"] }]);
    expect(file.sequences.map((row) => [row.name, row.status, row.steps.length])).toEqual([["Intro", "active", 2], ["Retired", "archived", 1]]);
    expect(file.sequences[0]?.campaigns).toEqual([{ name: "Intro - Founders", status: "active", listNames: ["Founders"], senderEmail: "sales@acme.test" }]);
    expect(file.sequences[0]?.leadVariables).toEqual([{ email: "Ana@Example.com", values: { icebreaker: "Loved the podcast" } }]);
    expect(file.mailboxes).toEqual([expect.objectContaining({ email: "sales@acme.test", provider: "smtp", dailyLimit: 40, sendingWindows: [expect.objectContaining({ dayOfWeek: 1, startTime: "09:00:00" })] })]);
    expect(file.team.map((member) => member.role).sort()).toEqual(["admin", "owner"]);
    for (const leaked of ["Other tenant", "only-other@example.com", "other-suppressed", "composio-secret", "provider-secret-token", "smtp-secret", "imap-secret", "api-key-secret-hash", "SENT-MESSAGE-SUBJECT", sourceId, mailboxId, anaId]) {
      expect(text).not.toContain(leaked);
    }
  });

  it("lets only the owner export or import", async () => {
    await expect(exportWorkspace(ctx(sourceId, adminId))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(exportWorkspace(ctx(otherId, ownerId))).rejects.toMatchObject({ code: "FORBIDDEN" });
    const { file } = await exportWorkspace(ctx(sourceId));
    await expect(importWorkspace(ctx(otherId, ownerId), file)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await counts(otherId)).contacts).toBe(2);
  });

  it("imports into an empty workspace as drafts without sending, enrolling or touching another tenant", async () => {
    const otherBefore = await counts(otherId);
    const sourceBefore = await counts(sourceId);
    const { file } = await exportWorkspace(ctx(sourceId));
    const result = await importWorkspace(ctx(targetId), JSON.parse(JSON.stringify(file)));

    expect(result.imported).toEqual({ leads: 2, lists: 1, listMemberships: 2, suppressions: 1, sequences: 2, steps: 3, leadVariables: 1, invitations: 1 });
    expect(result.mailboxesToReconnect).toEqual([expect.objectContaining({ email: "sales@acme.test", provider: "smtp" })]);
    expect(result.campaignsToRebuild).toEqual([{ campaign: "Intro", name: "Intro - Founders", sourceStatus: "active", listNames: ["Founders"], senderEmail: "sales@acme.test" }]);

    const [settings] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, targetId));
    expect(settings).toMatchObject({ name: "Source workspace", defaultTimezone: "Asia/Dubai", dailySendCap: 350, openTrackingEnabled: true, postalAddress: "1 Main St, Dubai", killSwitchEnabled: false });

    const leads = await db.select().from(schema.contacts).where(eq(schema.contacts.workspaceId, targetId)).orderBy(schema.contacts.normalizedEmail);
    expect(leads.map((lead) => [lead.normalizedEmail, lead.status])).toEqual([["ana@example.com", "active"], ["bo@example.com", "replied"]]);
    expect(leads.every((lead) => lead.id !== anaId)).toBe(true);
    expect(leads[0]?.customFields).toEqual({ icebreaker: "Saw your talk" });

    const sequences = await db.select().from(schema.sequences).where(eq(schema.sequences.workspaceId, targetId)).orderBy(schema.sequences.name);
    expect(sequences.map((row) => [row.name, row.status])).toEqual([["Intro", "draft"], ["Retired", "archived"]]);
    const versions = await db.select().from(schema.sequenceVersions).where(eq(schema.sequenceVersions.workspaceId, targetId));
    expect(versions.map((row) => row.status).sort()).toEqual(["archived", "draft"]);
    expect(versions.every((row) => row.launchedAt === null)).toBe(true);
    expect(await db.select().from(schema.sequenceEmailAccounts).where(eq(schema.sequenceEmailAccounts.workspaceId, targetId))).toEqual([]);

    const after = await counts(targetId);
    expect(after).toMatchObject({ contacts: 2, lists: 1, sequences: 2, suppressions: 1, campaigns: 0, enrollments: 0, messages: 0, staged: 0, leadVariables: 1, invitations: 1 });
    expect(await counts(otherId)).toEqual(otherBefore);
    expect(await counts(sourceId)).toEqual(sourceBefore);

    // The teammate is a pending invitation whose link only the importer got back.
    const [invitation] = await db.select().from(schema.invitations).where(eq(schema.invitations.workspaceId, targetId));
    expect(result.invitations).toEqual([expect.objectContaining({ email: `admin-${adminId}@example.test`, role: "admin" })]);
    expect(invitation).toMatchObject({ normalizedEmail: `admin-${adminId}@example.test`, role: "admin", acceptedAt: null, invitedByUserId: ownerId });
    expect(invitation?.tokenHash).toBe(sha(result.invitations[0]!.token));
    expect(result.invitations[0]!.token.startsWith(`${targetId}.`)).toBe(true);
  });

  it("round-trips: exporting the imported workspace gives the same content", async () => {
    const first = (await exportWorkspace(ctx(sourceId), { now: new Date("2026-10-29T10:00:00.000Z") })).file;
    await importWorkspace(ctx(targetId), first);
    const second = (await exportWorkspace(ctx(targetId), { now: new Date("2026-10-29T10:00:00.000Z") })).file;
    const comparable = (file: WorkspaceTransferFile) => ({
      workspace: file.workspace,
      leads: file.leads.map(({ createdAt: _createdAt, ...lead }) => lead),
      lists: file.lists,
      suppressions: file.suppressions.map(({ createdAt: _createdAt, ...row }) => row),
      // Steps, descriptions and variables move; live campaigns come back as drafts without a sender.
      sequences: file.sequences.map((row) => ({ name: row.name, description: row.description, steps: row.steps, leadVariables: row.leadVariables, customVariablesEnforced: row.customVariablesEnforced })),
    });
    expect(comparable(second)).toEqual(comparable(first));
    expect(second.sequences.map((row) => row.status)).toEqual(["draft", "archived"]);
    expect(second.sequences.every((row) => row.campaigns.length === 0)).toBe(true);
    expect(second.mailboxes).toEqual([]);
  });

  it("refuses a workspace that already has data and leaves it unchanged", async () => {
    const { file } = await exportWorkspace(ctx(sourceId));
    await db.insert(schema.contactLists).values({ id: randomUUID(), workspaceId: targetId, name: "Existing" });
    const before = await counts(targetId);
    const [settingsBefore] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, targetId));
    await expect(importWorkspace(ctx(targetId), file)).rejects.toMatchObject({ code: "CONFLICT", details: expect.objectContaining({ code: "workspace_not_empty", hasLists: true }) });
    expect(await counts(targetId)).toEqual(before);
    const [settingsAfter] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, targetId));
    expect(settingsAfter?.name).toBe(settingsBefore?.name);
  });

  it("rolls back everything when the database refuses a value late in the import", async () => {
    const { file } = await exportWorkspace(ctx(sourceId));
    const [settingsBefore] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, targetId));
    // Valid JSON and valid for the schema, but PostgreSQL text cannot hold a
    // NUL byte, so the last sequence fails after leads, lists and suppressions.
    const broken = { ...file, sequences: [...file.sequences, { name: "Broken", steps: [{ delayDays: 0, subject: "x", bodyText: "bad \u0000 byte" }] }] };
    const error = await importWorkspace(ctx(targetId), broken).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(OpError);
    expect(error).toMatchObject({ code: "BAD_INPUT", details: expect.objectContaining({ code: "invalid_export" }) });
    expect(await counts(targetId)).toMatchObject({ contacts: 0, lists: 0, sequences: 0, suppressions: 0, invitations: 0, leadVariables: 0 });
    const [settingsAfter] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, targetId));
    expect(settingsAfter?.name).toBe(settingsBefore?.name);
  });

  it("keeps the sending pause on and existing suppressions and postal address as they were", async () => {
    await db.update(schema.workspaces).set({ killSwitchEnabled: true, postalAddress: "Existing address" }).where(eq(schema.workspaces.id, targetId));
    await db.insert(schema.suppressions).values({ id: randomUUID(), workspaceId: targetId, email: "gone@example.com", normalizedEmail: "gone@example.com", emailHash: sha("gone@example.com"), reason: "bounced", source: "webhook" });
    const { file } = await exportWorkspace(ctx(sourceId));
    const result = await importWorkspace(ctx(targetId), { ...file, workspace: { ...file.workspace, killSwitchEnabled: false, postalAddress: null } });
    const [settings] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, targetId));
    expect(settings).toMatchObject({ killSwitchEnabled: true, postalAddress: "Existing address" });
    expect(result.imported.suppressions).toBe(0);
    expect(result.warnings.join(" ")).toContain("already in this workspace");
    const [suppression] = await db.select().from(schema.suppressions).where(eq(schema.suppressions.workspaceId, targetId));
    expect(suppression?.reason).toBe("bounced");
  });

  it("imports a lead covered by a suppression, hash-only included, as suppressed so enrollment skips it", async () => {
    // Already in the target: an erased address, kept only as its hash.
    await db.insert(schema.suppressions).values({ id: randomUUID(), workspaceId: targetId, email: null, normalizedEmail: null, emailHash: sha("pre@example.com"), reason: "manual", source: "manual" });
    const file = {
      format: "inboxjoy-workspace",
      version: 1,
      exportedAt: "2026-10-29T10:00:00.000Z",
      workspace: { name: "Hand-made" },
      leads: [
        { email: "X@Example.com" },
        { email: "replied@example.com", status: "replied", repliedAt: "2026-09-10T09:00:00.000Z" },
        { email: "bounced@example.com", status: "bounced", bouncedAt: "2026-09-11T09:00:00.000Z" },
        { email: "pre@example.com" },
        { email: "ok@example.com" },
      ],
      suppressions: [
        { emailHash: sha("x@example.com"), reason: "manual", source: "manual" },
        { emailHash: sha("replied@example.com"), reason: "unsubscribed", source: "link" },
        { email: "bounced@example.com", reason: "bounced", source: "provider_webhook" },
      ],
    };
    const result = await importWorkspace(ctx(targetId), file, { now: new Date("2026-10-29T12:00:00.000Z") });

    const leads = await db.select({ id: schema.contacts.id, normalizedEmail: schema.contacts.normalizedEmail, status: schema.contacts.status, unsubscribedAt: schema.contacts.unsubscribedAt })
      .from(schema.contacts).where(eq(schema.contacts.workspaceId, targetId)).orderBy(schema.contacts.normalizedEmail);
    // A bounced lead keeps its own blocking state; every other match is suppressed.
    expect(leads.map((lead) => [lead.normalizedEmail, lead.status])).toEqual([
      ["bounced@example.com", "bounced"],
      ["ok@example.com", "active"],
      ["pre@example.com", "suppressed"],
      ["replied@example.com", "suppressed"],
      ["x@example.com", "suppressed"],
    ]);
    expect(leads.find((lead) => lead.normalizedEmail === "x@example.com")?.unsubscribedAt?.toISOString()).toBe("2026-10-29T12:00:00.000Z");
    expect(result.warnings.join(" ")).toContain("3 leads match a suppression");

    const audience = await findEligibleEnrollmentAudience({ db, workspaceId: targetId, sequenceVersionId: null, leadIds: leads.map((lead) => lead.id) });
    expect(audience.eligible.map((lead) => lead.normalizedEmail)).toEqual(["ok@example.com"]);
    expect(audience.skipped.suppressed).toBe(4);
  });

  it("refuses an owner whose email is not verified and imports nothing", async () => {
    const { file } = await exportWorkspace(ctx(sourceId));
    await db.update(schema.authUsers).set({ emailVerified: false }).where(eq(schema.authUsers.id, ownerId));
    await expect(importWorkspace(ctx(targetId), file)).rejects.toMatchObject({ code: "FORBIDDEN", details: { code: "email_unverified" } });
    expect(await counts(targetId)).toMatchObject({ contacts: 0, lists: 0, sequences: 0, suppressions: 0, invitations: 0 });
    // Export is the owner's own data and does not need a verified email.
    await expect(exportWorkspace(ctx(sourceId))).resolves.toMatchObject({ file: expect.objectContaining({ format: "inboxjoy-workspace" }) });
  });

  it("skips teammates who are already members or invited and respects the open invitation cap", async () => {
    const team = Array.from({ length: 22 }, (_, index) => ({ email: `teammate-${index}@example.test`, role: "member" as const }));
    const { file } = await exportWorkspace(ctx(sourceId));
    await db.insert(schema.invitations).values({ id: randomUUID(), workspaceId: targetId, email: "teammate-0@example.test", normalizedEmail: "teammate-0@example.test", role: "member", tokenHash: sha("existing"), expiresAt: new Date(Date.now() + 86_400_000), invitedByUserId: ownerId });
    const result = await importWorkspace(ctx(targetId), { ...file, team: [{ email: `owner-${ownerId}@example.test`, role: "owner" }, ...team] });
    expect(result.notInvited).toContainEqual({ email: "teammate-0@example.test", reason: "already_invited" });
    expect(result.notInvited.filter((row) => row.reason === "invitation_limit")).toHaveLength(2);
    expect(result.invitations).toHaveLength(19);
    expect(result.invitations.map((row) => row.email)).not.toContain(`owner-${ownerId}@example.test`);
    expect((await counts(targetId)).invitations).toBe(20);
  });
});
