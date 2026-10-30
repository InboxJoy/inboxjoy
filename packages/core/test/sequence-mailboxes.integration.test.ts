import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { operationByName, removeMailbox, runOperation, type OperationContext } from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("saved sequence sender mailboxes", () => {
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);
  let userId: string;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let sequenceId: string;
  let versionId: string;
  let firstStepId: string;
  let secondStepId: string;
  let mailboxIds: string[];
  let foreignMailboxId: string;

  function context(): OperationContext {
    return { db, workspaceId, userId, env: {
      edition: "selfhost",
      authSecret: "sequence-mailboxes-test-secret-at-least-32-characters",
      apiBaseUrl: "https://api.example.test",
    } };
  }

  async function run(name: string, input: unknown) {
    const operation = operationByName.get(name);
    if (!operation) throw new Error(`Missing operation ${name}`);
    return runOperation(operation, context(), input);
  }

  async function contacts(count = 1): Promise<string[]> {
    const rows = Array.from({ length: count }, () => {
      const contactId = randomUUID();
      const email = `${contactId}@example.com`;
      return { id: contactId, workspaceId, email, normalizedEmail: email, status: "active" as const };
    });
    await db.insert(schema.contacts).values(rows);
    return rows.map((row) => row.id);
  }

  async function enrolled(leadIds: string[]) {
    return db.select().from(schema.enrollments).where(and(
      eq(schema.enrollments.workspaceId, workspaceId),
      eq(schema.enrollments.sequenceId, sequenceId),
      inArray(schema.enrollments.contactId, leadIds),
    )).orderBy(schema.enrollments.id);
  }

  async function enroll(leadIds: string[], override: { inboxIds?: string[]; inboxId?: string } = {}) {
    expect(await run("sequences.enroll", { id: sequenceId, leadIds, ...override })).toMatchObject({ enrolled: leadIds.length });
    return enrolled(leadIds);
  }

  async function setMailboxes(selection: string[]) {
    return run("sequences.setMailboxes", { id: sequenceId, mailboxIds: selection });
  }

  async function savedMailboxes(): Promise<string[]> {
    const rows = await db.select().from(schema.sequenceEmailAccounts).where(eq(schema.sequenceEmailAccounts.sequenceId, sequenceId));
    return rows.map((row) => row.emailAccountId).sort();
  }

  // Mirrors the worker's auth-expiry bookkeeping in send-message.ts recordFailure.
  async function expireMailbox(mailboxId: string) {
    const now = new Date();
    await db.update(schema.emailAccounts).set({ status: "expired" }).where(eq(schema.emailAccounts.id, mailboxId));
    await db.update(schema.enrollments).set({ statusBeforePause: sql`status`, status: "paused", pausedAt: now, stopReason: "mailbox_auth_expired" }).where(and(
      eq(schema.enrollments.emailAccountId, mailboxId),
      inArray(schema.enrollments.status, ["scheduled", "active"]),
    ));
  }

  async function sequenceEnrollments() {
    return db.select().from(schema.enrollments).where(eq(schema.enrollments.sequenceId, sequenceId)).orderBy(schema.enrollments.id);
  }

  async function workspaceMessages() {
    return db.select().from(schema.messages).where(eq(schema.messages.workspaceId, workspaceId)).orderBy(schema.messages.id);
  }

  beforeAll(async () => { await pool.query("select 1"); });

  beforeEach(async () => {
    userId = randomUUID();
    workspaceId = randomUUID();
    otherWorkspaceId = randomUUID();
    sequenceId = randomUUID();
    versionId = randomUUID();
    firstStepId = randomUUID();
    secondStepId = randomUUID();
    mailboxIds = Array.from({ length: 3 }, () => randomUUID());
    foreignMailboxId = randomUUID();
    const email = `${userId}@example.com`;
    await db.insert(schema.authUsers).values({ id: userId, name: "Mailbox test", email, emailVerified: true });
    await db.insert(schema.users).values({ id: userId, email, normalizedEmail: email, displayName: "Mailbox test" });
    await db.insert(schema.workspaces).values([
      { id: workspaceId, name: "Mailbox test", slug: workspaceId, createdByUserId: userId },
      { id: otherWorkspaceId, name: "Foreign mailbox test", slug: otherWorkspaceId, createdByUserId: userId },
    ]);
    await db.insert(schema.memberships).values({ id: randomUUID(), workspaceId, userId, role: "owner", status: "active", joinedAt: new Date() });
    await db.insert(schema.emailAccounts).values([...mailboxIds, foreignMailboxId].map((mailboxId) => ({
      id: mailboxId,
      workspaceId: mailboxId === foreignMailboxId ? otherWorkspaceId : workspaceId,
      userId,
      provider: "gmail" as const,
      composioConnectedAccountId: mailboxId,
      email: `${mailboxId}@example.com`,
      normalizedEmail: `${mailboxId}@example.com`,
      alias: mailboxId,
      status: "active" as const,
      dailyLimit: 20,
    })));
    await db.insert(schema.sequences).values({ id: sequenceId, workspaceId, name: "Sender selection", status: "active", createdByUserId: userId });
    await db.insert(schema.sequenceVersions).values({ id: versionId, workspaceId, sequenceId, version: 1, status: "active", createdByUserId: userId });
    await db.update(schema.sequences).set({ currentVersionId: versionId }).where(eq(schema.sequences.id, sequenceId));
    await db.insert(schema.sequenceSteps).values([
      { id: firstStepId, workspaceId, sequenceVersionId: versionId, stepOrder: 1, delayDays: 1, subject: "Hello", bodyText: "Hello" },
      { id: secondStepId, workspaceId, sequenceVersionId: versionId, stepOrder: 2, delayDays: 2, subject: "Follow up", bodyText: "Follow up" },
    ]);
  });

  afterEach(async () => {
    await db.delete(schema.workspaces).where(inArray(schema.workspaces.id, [workspaceId, otherWorkspaceId]));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await db.delete(schema.authUsers).where(eq(schema.authUsers.id, userId));
  });

  afterAll(async () => { await pool.end(); });

  it("keeps legacy rotate-all behavior with no saved rows and after clearing", async () => {
    expect(await savedMailboxes()).toEqual([]);
    const legacyEnrollments = await enroll(await contacts(6));
    expect(legacyEnrollments.map((row) => row.emailAccountId).sort()).toEqual(mailboxIds.flatMap((mailboxId) => [mailboxId, mailboxId]).sort());
    await setMailboxes([mailboxIds[0]!]);
    const beforeClear = await db.select().from(schema.enrollments).where(eq(schema.enrollments.sequenceId, sequenceId));
    expect(await setMailboxes([])).toMatchObject({ mailboxIds: [], reassigned: 0, sequence: { mailboxIds: [] } });
    expect(await savedMailboxes()).toEqual([]);
    expect(await db.select().from(schema.enrollments).where(eq(schema.enrollments.sequenceId, sequenceId))).toEqual(beforeClear);
    const clearedEnrollments = await enroll(await contacts(6));
    expect(new Set(clearedEnrollments.map((row) => row.emailAccountId))).toEqual(new Set(mailboxIds));
  });

  it("restricts enrollment to the saved selection and exposes it in get and list", async () => {
    const selectedId = mailboxIds[1]!;
    expect(await setMailboxes([selectedId, selectedId])).toMatchObject({ mailboxIds: [selectedId], reassigned: 0 });
    expect(await savedMailboxes()).toEqual([selectedId]);
    expect((await enroll(await contacts(4))).every((row) => row.emailAccountId === selectedId)).toBe(true);
    expect(await run("sequences.get", { id: sequenceId })).toMatchObject({ mailboxIds: [selectedId] });
    expect((await run("sequences.list", {})).sequences).toEqual(expect.arrayContaining([expect.objectContaining({ id: sequenceId, mailboxIds: [selectedId] })]));
  });

  it("lets explicit inboxIds and legacy inboxId override the saved selection", async () => {
    await setMailboxes([mailboxIds[0]!]);
    const overrideIds = mailboxIds.slice(1);
    expect(new Set((await enroll(await contacts(4), { inboxIds: overrideIds })).map((row) => row.emailAccountId))).toEqual(new Set(overrideIds));
    expect((await enroll(await contacts(), { inboxId: mailboxIds[2]! }))[0]!.emailAccountId).toBe(mailboxIds[2]);
    expect(await savedMailboxes()).toEqual([mailboxIds[0]!]);
  });

  it("rejects foreign or nonexistent mailboxes atomically without changing selection or senders", async () => {
    await setMailboxes([mailboxIds[0]!]);
    const before = await enroll(await contacts());
    for (const invalidId of [foreignMailboxId, randomUUID()]) {
      await expect(setMailboxes([mailboxIds[1]!, invalidId])).rejects.toMatchObject({ code: "BAD_INPUT" });
      expect(await savedMailboxes()).toEqual([mailboxIds[0]!]);
      expect(await enrolled(before.map((row) => row.contactId))).toEqual(before);
    }
  });

  it("allows draft, active and paused sequences, but rejects archived sequences", async () => {
    for (const status of ["draft", "active", "paused"] as const) {
      await db.update(schema.sequences).set({ status }).where(eq(schema.sequences.id, sequenceId));
      await expect(setMailboxes([mailboxIds[0]!])).resolves.toMatchObject({ mailboxIds: [mailboxIds[0]!] });
    }
    await db.update(schema.sequences).set({ status: "archived" }).where(eq(schema.sequences.id, sequenceId));
    await expect(setMailboxes([mailboxIds[1]!])).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await savedMailboxes()).toEqual([mailboxIds[0]!]);
  });

  it("reassigns scheduled and active never-sent enrollments round-robin and updates pending messages", async () => {
    const leads = await contacts(5);
    const waiting = await enroll(leads, { inboxId: mailboxIds[0]! });
    const active = waiting[0]!;
    await db.update(schema.enrollments).set({ status: "active" }).where(eq(schema.enrollments.id, active.id));
    await db.update(schema.messages).set({ status: "retryable", blockedReason: "mailbox_unhealthy" }).where(eq(schema.messages.enrollmentId, active.id));
    const alreadySelected = (await enroll(await contacts(), { inboxId: mailboxIds[1]! }))[0]!;
    const selectedMessagesBefore = await db.select().from(schema.messages).where(eq(schema.messages.enrollmentId, alreadySelected.id));
    expect(await setMailboxes(mailboxIds.slice(1))).toMatchObject({ reassigned: 5 });
    const after = await enrolled(leads);
    const counts = mailboxIds.slice(1).map((mailboxId) => after.filter((row) => row.emailAccountId === mailboxId).length).sort();
    expect(counts).toEqual([2, 3]);
    const messages = await db.select().from(schema.messages).where(inArray(schema.messages.enrollmentId, after.map((row) => row.id)));
    for (const enrollment of after) {
      expect(messages.filter((message) => message.enrollmentId === enrollment.id).every((message) => message.emailAccountId === enrollment.emailAccountId)).toBe(true);
    }
    expect(await db.select().from(schema.messages).where(eq(schema.messages.enrollmentId, alreadySelected.id))).toEqual(selectedMessagesBefore);
    expect(await setMailboxes(mailboxIds.slice(1))).toMatchObject({ reassigned: 0 });
  });

  it("keeps mid-sequence, claimed, sending, previously accepted and uncertain sends on their sender", async () => {
    const [midSequence, claimed, sending, recordedAcceptance, uncertain, paused, cancelled, completed] = await enroll(await contacts(8), { inboxId: mailboxIds[0]! });
    await db.update(schema.enrollments).set({ status: "active", nextStepOrder: 2 }).where(eq(schema.enrollments.id, midSequence!.id));
    await db.update(schema.messages).set({ status: "accepted", acceptedAt: new Date(), providerMessageId: "first-sent" }).where(eq(schema.messages.enrollmentId, midSequence!.id));
    await db.insert(schema.messages).values({
      id: randomUUID(), workspaceId, enrollmentId: midSequence!.id, sequenceStepId: secondStepId, emailAccountId: mailboxIds[0]!,
      contactId: midSequence!.contactId, status: "scheduled", idempotencyKey: `${midSequence!.id}:2`, scheduledAt: new Date(),
      recipientEmail: "follow-up@example.com", normalizedRecipientEmail: "follow-up@example.com", subject: "Follow up", bodyHash: "follow-up",
    });
    await db.update(schema.messages).set({ status: "claimed", claimedAt: new Date(), claimExpiresAt: new Date(Date.now() + 60_000) }).where(eq(schema.messages.enrollmentId, claimed!.id));
    await db.update(schema.messages).set({ status: "sending", claimedAt: new Date(), claimExpiresAt: new Date(Date.now() + 60_000) }).where(eq(schema.messages.enrollmentId, sending!.id));
    await db.update(schema.messages).set({ status: "retryable", acceptedAt: new Date() }).where(eq(schema.messages.enrollmentId, recordedAcceptance!.id));
    await db.update(schema.messages).set({ status: "failed", errorClass: "unknown_provider_result" }).where(eq(schema.messages.enrollmentId, uncertain!.id));
    for (const [enrollment, status] of [[paused!, "paused"], [cancelled!, "cancelled"], [completed!, "completed"]] as const) {
      await db.update(schema.enrollments).set({ status }).where(eq(schema.enrollments.id, enrollment.id));
    }
    const enrollmentsBefore = await sequenceEnrollments();
    const messagesBefore = await workspaceMessages();
    // The paused contact has never sent, so it is the only one that changes sender.
    expect(await setMailboxes([mailboxIds[1]!])).toMatchObject({ reassigned: 1 });
    expect((await sequenceEnrollments()).filter((row) => row.id !== paused!.id)).toEqual(enrollmentsBefore.filter((row) => row.id !== paused!.id));
    expect((await workspaceMessages()).filter((row) => row.enrollmentId !== paused!.id)).toEqual(messagesBefore.filter((row) => row.enrollmentId !== paused!.id));
    expect((await enrolled([paused!.contactId]))[0]).toMatchObject({ emailAccountId: mailboxIds[1], status: "paused" });
    expect((await db.select().from(schema.messages).where(eq(schema.messages.enrollmentId, paused!.id))).map((message) => message.emailAccountId)).toEqual([mailboxIds[1]]);
  });

  it("moves auth-expired never-sent enrollments to the selected healthy mailbox and restores them", async () => {
    const [failedFirstSend, queued] = await enroll(await contacts(2), { inboxId: mailboxIds[0]! });
    await db.update(schema.enrollments).set({ status: "active" }).where(eq(schema.enrollments.id, queued!.id));
    const [failedMessage] = await db.update(schema.messages).set({ status: "retryable", errorClass: "mailbox_authentication", errorMessage: "401" })
      .where(eq(schema.messages.enrollmentId, failedFirstSend!.id)).returning({ id: schema.messages.id });
    await db.insert(schema.sendAttempts).values({ id: randomUUID(), workspaceId, messageId: failedMessage!.id, attemptNumber: 1, status: "retryable", providerStatusCode: 401, errorClass: "mailbox_authentication", finishedAt: new Date() });
    await expireMailbox(mailboxIds[0]!);
    expect((await sequenceEnrollments()).map((row) => row.stopReason)).toEqual(["mailbox_auth_expired", "mailbox_auth_expired"]);

    expect(await setMailboxes([mailboxIds[1]!])).toMatchObject({ reassigned: 2 });
    const restored = { emailAccountId: mailboxIds[1], statusBeforePause: null, pausedAt: null, stopReason: null };
    expect((await enrolled([failedFirstSend!.contactId]))[0]).toMatchObject({ ...restored, status: "scheduled" });
    expect((await enrolled([queued!.contactId]))[0]).toMatchObject({ ...restored, status: "active" });
    const messages = await workspaceMessages();
    expect(messages.map((message) => message.emailAccountId)).toEqual([mailboxIds[1], mailboxIds[1]]);
    expect(messages.map((message) => message.status).sort()).toEqual(["retryable", "scheduled"]);
  });

  it("moves sequence-paused never-sent enrollments and keeps them paused until the sequence resumes", async () => {
    const [waiting] = await enroll(await contacts(), { inboxId: mailboxIds[0]! });
    await run("sequences.pause", { id: sequenceId });
    const [pausedBefore] = await enrolled([waiting!.contactId]);
    expect(pausedBefore).toMatchObject({ status: "paused", statusBeforePause: "scheduled", stopReason: null });

    expect(await setMailboxes([mailboxIds[1]!])).toMatchObject({ reassigned: 1 });
    expect((await enrolled([waiting!.contactId]))[0]).toEqual({ ...pausedBefore, emailAccountId: mailboxIds[1], updatedAt: expect.any(Date) });
    expect((await workspaceMessages()).map((message) => message.emailAccountId)).toEqual([mailboxIds[1]]);

    await run("sequences.resume", { id: sequenceId });
    expect((await enrolled([waiting!.contactId]))[0]).toMatchObject({ emailAccountId: mailboxIds[1], status: "scheduled", statusBeforePause: null, pausedAt: null });
  });

  it("keeps a paused enrollment that already sent its first email on its sender", async () => {
    const [midSequence] = await enroll(await contacts(), { inboxId: mailboxIds[0]! });
    await db.update(schema.enrollments).set({ status: "active", nextStepOrder: 2 }).where(eq(schema.enrollments.id, midSequence!.id));
    await db.update(schema.messages).set({ status: "accepted", acceptedAt: new Date(), providerMessageId: "first-sent" }).where(eq(schema.messages.enrollmentId, midSequence!.id));
    await db.insert(schema.messages).values({
      id: randomUUID(), workspaceId, enrollmentId: midSequence!.id, sequenceStepId: secondStepId, emailAccountId: mailboxIds[0]!,
      contactId: midSequence!.contactId, status: "scheduled", idempotencyKey: `${midSequence!.id}:2`, scheduledAt: new Date(),
      recipientEmail: "follow-up@example.com", normalizedRecipientEmail: "follow-up@example.com", subject: "Follow up", bodyHash: "follow-up",
    });
    await expireMailbox(mailboxIds[0]!);
    const enrollmentsBefore = await sequenceEnrollments();
    const messagesBefore = await workspaceMessages();
    expect(enrollmentsBefore[0]).toMatchObject({ status: "paused", statusBeforePause: "active", stopReason: "mailbox_auth_expired" });
    expect(await setMailboxes([mailboxIds[1]!])).toMatchObject({ reassigned: 0 });
    expect(await sequenceEnrollments()).toEqual(enrollmentsBefore);
    expect(await workspaceMessages()).toEqual(messagesBefore);
  });

  it("moves never-sent contacts off an unsendable mailbox when rotating across all healthy mailboxes", async () => {
    await setMailboxes(mailboxIds.slice(0, 2));
    const stranded = await enroll(await contacts(4), { inboxId: mailboxIds[0]! });
    const [onHealthy] = await enroll(await contacts(), { inboxId: mailboxIds[1]! });
    await db.update(schema.emailAccounts).set({ status: "disconnected" }).where(eq(schema.emailAccounts.id, mailboxIds[0]!));
    const healthyMessagesBefore = await db.select().from(schema.messages).where(eq(schema.messages.enrollmentId, onHealthy!.id));

    expect(await setMailboxes([])).toMatchObject({ mailboxIds: [], reassigned: 4 });
    const moved = await enrolled(stranded.map((row) => row.contactId));
    expect(mailboxIds.slice(1).map((mailboxId) => moved.filter((row) => row.emailAccountId === mailboxId).length)).toEqual([2, 2]);
    const movedMessages = await db.select().from(schema.messages).where(inArray(schema.messages.enrollmentId, moved.map((row) => row.id)));
    for (const enrollment of moved) {
      expect(movedMessages.filter((message) => message.enrollmentId === enrollment.id).map((message) => message.emailAccountId)).toEqual([enrollment.emailAccountId]);
    }
    expect(await enrolled([onHealthy!.contactId])).toEqual([onHealthy]);
    expect(await db.select().from(schema.messages).where(eq(schema.messages.enrollmentId, onHealthy!.id))).toEqual(healthyMessagesBefore);
    expect(await setMailboxes([])).toMatchObject({ reassigned: 0 });
  });

  it("leaves contacts on an already-selected mailbox untouched when a mailbox is added", async () => {
    await setMailboxes([mailboxIds[0]!]);
    await enroll(await contacts(4));
    const enrollmentsBefore = await sequenceEnrollments();
    const messagesBefore = await workspaceMessages();
    expect(enrollmentsBefore.every((row) => row.emailAccountId === mailboxIds[0])).toBe(true);
    expect(await setMailboxes(mailboxIds.slice(0, 2))).toMatchObject({ reassigned: 0 });
    expect(await sequenceEnrollments()).toEqual(enrollmentsBefore);
    expect(await workspaceMessages()).toEqual(messagesBefore);
  });

  it("rejects enrollment through another workspace's inbox and enrolls nobody", async () => {
    const leads = await contacts(2);
    for (const override of [{ inboxId: foreignMailboxId }, { inboxIds: [mailboxIds[0]!, foreignMailboxId] }]) {
      await expect(run("sequences.enroll", { id: sequenceId, leadIds: leads, ...override })).rejects.toMatchObject({ code: "BAD_INPUT", message: "One or more inboxes do not belong to this workspace." });
      expect(await enrolled(leads)).toEqual([]);
      expect(await workspaceMessages()).toEqual([]);
    }
  });

  it("removes a deleted mailbox from saved selections through the foreign key cascade", async () => {
    const removedMailboxId = randomUUID();
    await db.insert(schema.emailAccounts).values({
      id: removedMailboxId, workspaceId, userId, provider: "gmail", composioConnectedAccountId: removedMailboxId,
      email: `${removedMailboxId}@example.com`, normalizedEmail: `${removedMailboxId}@example.com`, alias: removedMailboxId, status: "active", dailyLimit: 20,
    });
    await setMailboxes([mailboxIds[0]!, removedMailboxId]);
    expect(await savedMailboxes()).toEqual([mailboxIds[0]!, removedMailboxId].sort());
    await db.delete(schema.emailAccounts).where(eq(schema.emailAccounts.id, removedMailboxId));
    expect(await savedMailboxes()).toEqual([mailboxIds[0]!]);
    expect(await run("sequences.get", { id: sequenceId })).toMatchObject({ mailboxIds: [mailboxIds[0]!] });
  });

  it("waits for a concurrent worker claim and preserves the claimed sender", async () => {
    const [enrollment] = await enroll(await contacts(), { inboxId: mailboxIds[0]! });
    const claimClient = await pool.connect();
    let selectionPromise: ReturnType<typeof setMailboxes> | undefined;
    try {
      await claimClient.query("begin");
      await claimClient.query("select pg_advisory_xact_lock(hashtext('send-capacity:' || $1::text))", [workspaceId]);
      await claimClient.query("select id from enrollments where id=$1 for update", [enrollment!.id]);
      await claimClient.query("update messages set status='sending',claimed_at=now(),claim_expires_at=now()+interval '5 minutes' where enrollment_id=$1", [enrollment!.id]);
      selectionPromise = setMailboxes([mailboxIds[1]!]);
      await claimClient.query("commit");
      expect(await selectionPromise).toMatchObject({ reassigned: 0 });
      expect((await enrolled([enrollment!.contactId]))[0]!.emailAccountId).toBe(mailboxIds[0]);
      expect((await db.select().from(schema.messages).where(eq(schema.messages.enrollmentId, enrollment!.id)))[0]!.emailAccountId).toBe(mailboxIds[0]);
    } finally {
      await claimClient.query("rollback");
      claimClient.release();
      await selectionPromise;
    }
  });

  it("saves unavailable selections without reassigning or falling back to other mailboxes", async () => {
    const [waiting] = await enroll(await contacts(), { inboxId: mailboxIds[0]! });
    await db.update(schema.emailAccounts).set({ status: "paused" }).where(eq(schema.emailAccounts.id, mailboxIds[1]!));
    await db.update(schema.emailAccounts).set({ email: null, normalizedEmail: null }).where(eq(schema.emailAccounts.id, mailboxIds[2]!));
    expect(await setMailboxes(mailboxIds.slice(1))).toMatchObject({ reassigned: 0 });
    expect((await enrolled([waiting!.contactId]))[0]!.emailAccountId).toBe(mailboxIds[0]);
    await expect(run("sequences.enroll", { id: sequenceId, leadIds: await contacts() })).rejects.toMatchObject({ code: "CONFLICT", message: "None of the mailboxes selected for this campaign can send right now. Reconnect one or choose other mailboxes." });
    await expect(run("sequences.enroll", { id: sequenceId, leadIds: [] })).rejects.toMatchObject({ code: "CONFLICT" });
    await enroll(await contacts(), { inboxId: mailboxIds[0]! });
  });

  it("skips unhealthy selected mailboxes during reassignment and enrollment", async () => {
    await enroll(await contacts(), { inboxId: mailboxIds[0]! });
    await db.insert(schema.mailboxHealth).values({ id: randomUUID(), workspaceId, emailAccountId: mailboxIds[1]!, state: "critical", effectiveDailyLimit: 0 });
    expect(await setMailboxes(mailboxIds.slice(1))).toMatchObject({ reassigned: 1 });
    expect((await enroll(await contacts(2))).every((row) => row.emailAccountId === mailboxIds[2])).toBe(true);
    expect(await setMailboxes([mailboxIds[1]!])).toMatchObject({ reassigned: 0 });
    await expect(run("sequences.enroll", { id: sequenceId, leadIds: await contacts() })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("persists launch mailboxIds before enrolling and reuses them when omitted", async () => {
    const listId = randomUUID();
    const leads = await contacts(2);
    await db.insert(schema.contactLists).values({ id: listId, workspaceId, name: "Launch list" });
    await db.insert(schema.contactListMembers).values(leads.map((contactId) => ({ workspaceId, contactListId: listId, contactId })));
    await db.update(schema.sequences).set({ status: "draft" }).where(eq(schema.sequences.id, sequenceId));
    expect(await run("sequences.launch", { id: sequenceId, listIds: [listId], mailboxIds: [mailboxIds[1]!, mailboxIds[1]!] })).toMatchObject({ enrolled: 2, sequence: { mailboxIds: [mailboxIds[1]!] } });
    expect(await savedMailboxes()).toEqual([mailboxIds[1]!]);
    expect((await enrolled(leads)).every((row) => row.emailAccountId === mailboxIds[1])).toBe(true);
    const nextLeadIds = await contacts();
    await db.insert(schema.contactListMembers).values(nextLeadIds.map((contactId) => ({ workspaceId, contactListId: listId, contactId })));
    expect(await run("sequences.launch", { id: sequenceId, listId })).toMatchObject({ enrolled: 1 });
    expect((await enrolled(nextLeadIds))[0]!.emailAccountId).toBe(mailboxIds[1]);
    expect(await run("sequences.launch", { id: sequenceId, mailboxIds: [] })).toMatchObject({ enrolled: 0, sequence: { mailboxIds: [] } });
    expect(await savedMailboxes()).toEqual([]);
    await expect(run("sequences.launch", { id: sequenceId, mailboxIds: [foreignMailboxId] })).rejects.toMatchObject({ code: "BAD_INPUT" });
  });

  it("keeps the separate campaigns.launch explicit inboxId behavior", async () => {
    await setMailboxes([mailboxIds[1]!]);
    const leads = await contacts();
    const created = await run("campaigns.create", { name: "Legacy campaign", sequenceId, inboxId: mailboxIds[0]! });
    expect(await run("campaigns.launch", { id: created.campaign.id })).toMatchObject({ enrollment: { enrolled: 1 } });
    expect((await enrolled(leads))[0]!.emailAccountId).toBe(mailboxIds[0]);
    expect(await savedMailboxes()).toEqual([mailboxIds[1]!]);
  });

  describe("deleting a mailbox", () => {
    it("keeps enrolling and saving senders after one saved sender is deleted", async () => {
      await setMailboxes([mailboxIds[0]!, mailboxIds[1]!]);
      // Another workspace cannot delete it.
      expect(await removeMailbox(db, { workspaceId: otherWorkspaceId, mailboxId: mailboxIds[1]! })).toEqual({ removed: false, reassigned: 0, stopped: 0 });
      expect(await removeMailbox(db, { workspaceId, mailboxId: mailboxIds[1]! })).toEqual({ removed: true, reassigned: 0, stopped: 0 });
      expect((await enroll(await contacts(2))).map((row) => row.emailAccountId)).toEqual([mailboxIds[0], mailboxIds[0]]);
      expect((await enroll(await contacts(), { inboxIds: [mailboxIds[0]!, mailboxIds[1]!] }))[0]!.emailAccountId).toBe(mailboxIds[0]);
      // The editor re-saves the list it loaded, deleted sender included.
      await setMailboxes([mailboxIds[0]!, mailboxIds[1]!]);
      expect(await savedMailboxes()).toEqual([mailboxIds[0]!, mailboxIds[1]!].sort());
    });

    it("moves leads it has not emailed and stops the ones it has", async () => {
      await setMailboxes([mailboxIds[0]!, mailboxIds[1]!]);
      const [threaded] = await enroll(await contacts(4), { inboxId: mailboxIds[0]! });
      await db.update(schema.enrollments).set({ status: "active", nextStepOrder: 2 }).where(eq(schema.enrollments.id, threaded!.id));
      await db.update(schema.messages).set({ status: "accepted", acceptedAt: new Date(), providerMessageId: "first-sent" }).where(eq(schema.messages.enrollmentId, threaded!.id));
      const followUpId = randomUUID();
      await db.insert(schema.messages).values({
        id: followUpId, workspaceId, enrollmentId: threaded!.id, sequenceStepId: secondStepId, emailAccountId: mailboxIds[0]!,
        contactId: threaded!.contactId, status: "scheduled", idempotencyKey: `${threaded!.id}:2`, scheduledAt: new Date(),
        recipientEmail: "follow-up@example.com", normalizedRecipientEmail: "follow-up@example.com", subject: "Follow up", bodyHash: "follow-up",
      });

      expect(await removeMailbox(db, { workspaceId, mailboxId: mailboxIds[0]! })).toEqual({ removed: true, reassigned: 3, stopped: 1 });

      const after = await sequenceEnrollments();
      expect(after.find((row) => row.id === threaded!.id)).toMatchObject({ status: "cancelled", stopReason: "mailbox_removed", emailAccountId: mailboxIds[0] });
      const moved = after.filter((row) => row.id !== threaded!.id);
      expect(moved.map((row) => row.emailAccountId)).toEqual([mailboxIds[1], mailboxIds[1], mailboxIds[1]]);
      const messages = await workspaceMessages();
      for (const enrollment of moved) {
        expect(messages.filter((message) => message.enrollmentId === enrollment.id).every((message) => message.emailAccountId === mailboxIds[1])).toBe(true);
      }
      expect(messages.find((message) => message.id === followUpId)).toMatchObject({ status: "cancelled", blockedReason: "mailbox_removed" });
      expect(messages.find((message) => message.enrollmentId === threaded!.id && message.id !== followUpId)).toMatchObject({ status: "accepted" });
      expect(await savedMailboxes()).toEqual([mailboxIds[0]!, mailboxIds[1]!].sort());
    });

    it("never widens a campaign whose only sender was deleted", async () => {
      await setMailboxes([mailboxIds[0]!]);
      const leads = (await enroll(await contacts(2))).map((row) => row.contactId);
      expect(await removeMailbox(db, { workspaceId, mailboxId: mailboxIds[0]! })).toEqual({ removed: true, reassigned: 0, stopped: 0 });
      expect((await enrolled(leads)).map((row) => row.emailAccountId)).toEqual([mailboxIds[0], mailboxIds[0]]);
      expect(await savedMailboxes()).toEqual([mailboxIds[0]!]);
      // Adding a sender picks the waiting leads up.
      expect(await setMailboxes([mailboxIds[0]!, mailboxIds[2]!])).toMatchObject({ reassigned: 2 });
      expect((await enrolled(leads)).map((row) => row.emailAccountId)).toEqual([mailboxIds[2], mailboxIds[2]]);
      expect(await removeMailbox(db, { workspaceId, mailboxId: mailboxIds[0]! })).toMatchObject({ removed: false });
    });

    it("spreads leads over the other healthy mailboxes when the campaign rotates across all", async () => {
      const leads = (await enroll(await contacts(2), { inboxId: mailboxIds[0]! })).map((row) => row.contactId);
      expect(await removeMailbox(db, { workspaceId, mailboxId: mailboxIds[0]! })).toMatchObject({ reassigned: 2, stopped: 0 });
      expect((await enrolled(leads)).map((row) => row.emailAccountId).sort()).toEqual([mailboxIds[1]!, mailboxIds[2]!].sort());
    });
  });
});
