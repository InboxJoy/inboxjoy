import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { operationByName, runOperation, type OperationContext } from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;

function operation(name: string) {
  const found = operationByName.get(name);
  if (!found) throw new Error(`Missing operation ${name}`);
  return found;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

// Publishing a draft converts its queued (staged) contacts into enrollments. These cover
// the two ways that conversion used to lose the queue: the process dying part-way through,
// and a large blocked queue that could not be written back in one statement.
describe.skipIf(!databaseUrl)("staged enrollment conversion durability", () => {
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);

  let userId = "";
  let workspaceId = "";
  let mailboxId = "";
  const cleanupSql: string[] = [];

  function context(): OperationContext {
    return {
      db,
      workspaceId,
      userId,
      env: {
        edition: "selfhost",
        authSecret: "staged-durability-test-auth-secret-at-least-32-chars",
        apiBaseUrl: "https://api.example.test",
      },
    };
  }

  async function createDraftSequence(label: string) {
    const created = await runOperation(operation("sequences.create"), context(), {
      name: label,
      steps: [{ delayDays: 0, subject: "Hi {{firstName}}", body: "Hello {{firstName}}" }],
    });
    return created.sequence.id as string;
  }

  async function createContacts(label: string, count: number) {
    const rows = Array.from({ length: count }, (_, index) => {
      const email = `${label}-${index}-${randomUUID()}@example.com`;
      return { id: randomUUID(), workspaceId, email, normalizedEmail: email, firstName: `Lead${index}`, status: "active" as const };
    });
    for (const batch of chunk(rows, 1000)) await db.insert(schema.contacts).values(batch);
    return rows.map((row) => row.id);
  }

  async function stagedCount(sequenceId: string) {
    const { rows } = await pool.query<{ count: string }>("select count(*) from staged_enrollments where sequence_id = $1", [sequenceId]);
    return Number(rows[0]?.count ?? 0);
  }

  async function enrollmentCount(sequenceId: string) {
    const { rows } = await pool.query<{ count: string; contacts: string }>("select count(*) as count, count(distinct contact_id) as contacts from enrollments where sequence_id = $1", [sequenceId]);
    return { total: Number(rows[0]?.count ?? 0), distinctContacts: Number(rows[0]?.contacts ?? 0) };
  }

  // Simulates the API process dying mid-conversion: from the moment the first enrollment
  // row is written, every further write this workspace attempts fails, so no in-process
  // cleanup or restore step can run. Scoped to this test's workspace so parallel suites
  // sharing the database are unaffected.
  async function simulateCrashAfterClaim() {
    const fn = `staged_crash_${randomUUID().replace(/-/g, "")}`;
    await pool.query(`create function ${fn}() returns trigger language plpgsql as $$ begin raise exception 'simulated crash'; end $$`);
    await pool.query(`create trigger ${fn}_enrollments before insert on enrollments for each row when (new.workspace_id = '${workspaceId}') execute function ${fn}()`);
    await pool.query(`create trigger ${fn}_staged before insert on staged_enrollments for each row when (new.workspace_id = '${workspaceId}') execute function ${fn}()`);
    const drop = [`drop trigger if exists ${fn}_enrollments on enrollments`, `drop trigger if exists ${fn}_staged on staged_enrollments`, `drop function if exists ${fn}()`];
    cleanupSql.push(...drop);
    return async () => {
      for (const statement of drop) await pool.query(statement);
    };
  }

  beforeAll(async () => {
    await pool.query("select 1");
  });

  beforeEach(async () => {
    const suffix = randomUUID().slice(0, 8);
    userId = randomUUID();
    workspaceId = randomUUID();
    mailboxId = randomUUID();
    const email = `durability-user-${suffix}@example.com`;
    const mailboxEmail = `durability-mailbox-${suffix}@example.com`;
    await db.insert(schema.authUsers).values({ id: userId, name: "durability test", email, emailVerified: true });
    await db.insert(schema.users).values({ id: userId, email, normalizedEmail: email, displayName: "durability test" });
    await db.insert(schema.workspaces).values({ id: workspaceId, name: `durability ${suffix}`, slug: `durability-${suffix}`, createdByUserId: userId });
    await db.insert(schema.memberships).values({ id: randomUUID(), workspaceId, userId, role: "owner", status: "active", joinedAt: new Date() });
    await db.insert(schema.emailAccounts).values({ id: mailboxId, workspaceId, userId, provider: "gmail", composioConnectedAccountId: `durability-${suffix}`, email: mailboxEmail, normalizedEmail: mailboxEmail, alias: `durability-${suffix}`, status: "active" });
  });

  afterEach(async () => {
    for (const statement of cleanupSql.splice(0)) await pool.query(statement);
    if (workspaceId) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    if (userId) {
      await db.delete(schema.users).where(eq(schema.users.id, userId));
      await db.delete(schema.authUsers).where(eq(schema.authUsers.id, userId));
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  it("keeps queued contacts when the process dies between claiming and enrolling, and converts them on retry", async () => {
    const sequenceId = await createDraftSequence("Crash mid-conversion");
    const leadIds = await createContacts("crash", 3);
    await runOperation(operation("sequences.enroll"), context(), { id: sequenceId, leadIds, inboxId: mailboxId });
    expect(await stagedCount(sequenceId)).toBe(3);

    const recover = await simulateCrashAfterClaim();
    // The crash surfaces as a failed query (drizzle wraps the "simulated crash" cause).
    await expect(runOperation(operation("sequences.publish"), context(), { id: sequenceId })).rejects.toThrow();

    // Nothing enrolled, and nothing lost: every queued contact is still stored.
    expect((await enrollmentCount(sequenceId)).total).toBe(0);
    expect(await stagedCount(sequenceId)).toBe(3);

    // The API comes back; publishing again converts the whole queue exactly once.
    await recover();
    const retried = await runOperation(operation("sequences.publish"), context(), { id: sequenceId });
    expect(retried.queuedEnrollment).toMatchObject({ enrolled: 3 });
    expect(await enrollmentCount(sequenceId)).toEqual({ total: 3, distinctContacts: 3 });
    expect(await stagedCount(sequenceId)).toBe(0);

    // A further retry is a no-op: never a second enrollment.
    const again = await runOperation(operation("sequences.publish"), context(), { id: sequenceId });
    expect(again.queuedEnrollment).toBeUndefined();
    expect(await enrollmentCount(sequenceId)).toEqual({ total: 3, distinctContacts: 3 });
  });

  it("keeps every contact of a 10,000-contact queue when conversion is blocked", async () => {
    const sequenceId = await createDraftSequence("Large blocked queue");
    const leadIds = await createContacts("bulk", 10_000);
    const createdAt = new Date();
    const staged = leadIds.map((leadId) => ({ id: randomUUID(), workspaceId, sequenceId, leadId, campaignId: null, inboxIds: null, createdAt }));
    for (const batch of chunk(staged, 1000)) await db.insert(schema.stagedEnrollments).values(batch);
    expect(await stagedCount(sequenceId)).toBe(10_000);

    // The launch gate refuses: no mailbox in the workspace can send.
    await db.update(schema.emailAccounts).set({ status: "disconnected" }).where(eq(schema.emailAccounts.id, mailboxId));
    const blocked = await runOperation(operation("sequences.publish"), context(), { id: sequenceId });
    expect(blocked.queuedEnrollment).toMatchObject({ blocked: true, enrolled: 0 });
    expect((await enrollmentCount(sequenceId)).total).toBe(0);
    expect(await stagedCount(sequenceId)).toBe(10_000);
  }, 120_000);
});
