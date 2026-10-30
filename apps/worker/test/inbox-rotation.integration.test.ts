import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { completeAcceptedBookkeeping, type ClaimedMessage } from "../src/jobs/send-message.js";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!process.env.DATABASE_URL).each([
  { name: "Gmail reassignment", previousProvider: "gmail", assignedProvider: "gmail", pinned: false },
  { name: "SMTP rotation assignment", previousProvider: "gmail", assignedProvider: "smtp", pinned: false },
  { name: "SMTP sender stays pinned", previousProvider: "smtp", assignedProvider: "gmail", pinned: true },
] as const)("inbox rotation follow-ups: $name", (scenario) => {
  const pool = new Pool({ connectionString: databaseUrl });
  const ids = {
    user: randomUUID(),
    workspace: randomUUID(),
    previousMailbox: randomUUID(),
    assignedMailbox: randomUUID(),
    contact: randomUUID(),
    sequence: randomUUID(),
    version: randomUUID(),
    firstStep: randomUUID(),
    secondStep: randomUUID(),
    enrollment: randomUUID(),
    message: randomUUID(),
  };
  const enrollmentMailboxId = scenario.pinned ? ids.previousMailbox : ids.assignedMailbox;
  const rfcMessageId = `<${ids.message}@messages.inboxjoy.online>`;
  const message: ClaimedMessage = {
    id: ids.message,
    workspace_id: ids.workspace,
    enrollment_id: ids.enrollment,
    sequence_step_id: ids.firstStep,
    email_account_id: ids.previousMailbox,
    contact_id: ids.contact,
    recipient_email: "sticky-follow-up@example.com",
    normalized_recipient_email: "sticky-follow-up@example.com",
    subject: "First step",
    metadata: { acceptanceBookkeepingPending: true, providerRfcMessageId: rfcMessageId },
    provider: scenario.previousProvider,
    composio_connected_account_id: `rotation-previous-${ids.previousMailbox}`,
    daily_limit: 40,
    hourly_limit: 10,
    ramp_started_on: null,
    ramp_paused_days: 0,
    workspace_daily_cap: 200,
    postal_address: "123 Main St",
    mailbox_email: "previous-sender@example.com",
  };

  beforeAll(async () => {
    await pool.query("INSERT INTO users (id,email,normalized_email) VALUES ($1,$2,$2)", [ids.user, `inbox-rotation-${ids.user}@example.com`]);
    await pool.query("INSERT INTO workspaces (id,name,slug,created_by_user_id,postal_address) VALUES ($1,'Inbox Rotation',$2,$3,'123 Main St')", [ids.workspace, `inbox-rotation-${ids.workspace}`, ids.user]);
    await pool.query(`INSERT INTO email_accounts (id,workspace_id,user_id,provider,composio_connected_account_id,email,normalized_email,alias,status,daily_limit,hourly_limit) VALUES
      ($1,$3,$4,$7,$5,'previous-sender@example.com','previous-sender@example.com','previous-sender','active',40,10),
      ($2,$3,$4,$8,$6,'assigned-sender@example.com','assigned-sender@example.com','assigned-sender','active',40,10)`, [ids.previousMailbox, ids.assignedMailbox, ids.workspace, ids.user, message.composio_connected_account_id, `rotation-assigned-${ids.assignedMailbox}`, scenario.previousProvider, scenario.assignedProvider]);
    await pool.query("INSERT INTO contacts (id,workspace_id,email,normalized_email,status) VALUES ($1,$2,$3,$3,'enrolled')", [ids.contact, ids.workspace, message.recipient_email]);
    await pool.query("INSERT INTO sequences (id,workspace_id,name,status,created_by_user_id) VALUES ($1,$2,'Sticky sequence','active',$3)", [ids.sequence, ids.workspace, ids.user]);
    await pool.query("INSERT INTO sequence_versions (id,workspace_id,sequence_id,version,status,created_by_user_id) VALUES ($1,$2,$3,1,'active',$4)", [ids.version, ids.workspace, ids.sequence, ids.user]);
    await pool.query("UPDATE sequences SET current_version_id=$2 WHERE id=$1", [ids.sequence, ids.version]);
    await pool.query(`INSERT INTO sequence_steps (id,workspace_id,sequence_version_id,step_order,delay_days,subject,body_text) VALUES
      ($1,$3,$4,1,0,'First step','Hello'),
      ($2,$3,$4,2,1,'Second step','Following up')`, [ids.firstStep, ids.secondStep, ids.workspace, ids.version]);
    await pool.query(`INSERT INTO enrollments (id,workspace_id,contact_id,sequence_id,sequence_version_id,email_account_id,status,next_step_order)
      VALUES ($1,$2,$3,$4,$5,$6,'active',1)`, [ids.enrollment, ids.workspace, ids.contact, ids.sequence, ids.version, enrollmentMailboxId]);
    await pool.query(`INSERT INTO messages (id,workspace_id,enrollment_id,sequence_step_id,email_account_id,contact_id,status,idempotency_key,scheduled_at,accepted_at,
      recipient_email,normalized_recipient_email,subject,body_hash,metadata,provider_message_id,provider_thread_id) VALUES ($1,$2,$3,$4,$5,$6,'accepted',$7,now(),now(),$8,$8,'First step','hash',$9::jsonb,$10,$10)`,
    [ids.message, ids.workspace, ids.enrollment, ids.firstStep, ids.previousMailbox, ids.contact, `inbox-rotation:${ids.message}`, message.recipient_email, JSON.stringify(message.metadata), rfcMessageId]);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM workspaces WHERE id=$1", [ids.workspace]);
    await pool.query("DELETE FROM users WHERE id=$1", [ids.user]);
    await pool.end();
  });

  it("uses the enrollment mailbox when creating a follow-up", async () => {
    const client = await pool.connect();
    try {
      await expect(completeAcceptedBookkeeping(client, message, { pool, apiBaseUrl: "https://api.example.test", authSecret: "inbox-rotation-follow-up-secret" })).resolves.toBe(true);
      await expect(completeAcceptedBookkeeping(client, message, { pool, apiBaseUrl: "https://api.example.test", authSecret: "inbox-rotation-follow-up-secret" })).resolves.toBe(false);
    } finally {
      client.release();
    }
    const followUp = await pool.query<{ email_account_id: string; provider: string }>(`SELECT m.email_account_id,a.provider FROM messages m
      JOIN email_accounts a ON a.id=m.email_account_id WHERE m.enrollment_id=$1 AND m.sequence_step_id=$2`, [ids.enrollment, ids.secondStep]);
    expect(followUp.rows).toEqual([{ email_account_id: enrollmentMailboxId, provider: scenario.pinned ? scenario.previousProvider : scenario.assignedProvider }]);
    const enrollment = await pool.query<{ email_account_id: string }>("SELECT email_account_id FROM enrollments WHERE id=$1", [ids.enrollment]);
    expect(enrollment.rows).toEqual([{ email_account_id: enrollmentMailboxId }]);
    const accepted = await pool.query<{ email_account_id: string; provider_message_id: string }>("SELECT email_account_id,provider_message_id FROM messages WHERE id=$1", [ids.message]);
    expect(accepted.rows).toEqual([{ email_account_id: ids.previousMailbox, provider_message_id: rfcMessageId }]);
  });
});
