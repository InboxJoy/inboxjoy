import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ComposioRequestError } from "@inboxjoy/composio";
import { claimMessage, completeAcceptedBookkeeping, preSendReplyCheck, recordFailure, updateMailboxHealthForFailure, updateMailboxHealthForSuccess, type ClaimedMessage } from "../src/jobs/send-message.js";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("delivery control integration", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const ids = {
    user: randomUUID(),
    workspace: randomUUID(),
    mailbox: randomUUID(),
    contact: randomUUID(),
    sequence: randomUUID(),
    version: randomUUID(),
    step: randomUUID(),
    enrollment: randomUUID(),
    message: randomUUID(),
  };
  const message: ClaimedMessage = {
    id: ids.message,
    workspace_id: ids.workspace,
    enrollment_id: ids.enrollment,
    sequence_step_id: ids.step,
    email_account_id: ids.mailbox,
    contact_id: ids.contact,
    recipient_email: "delivery-control-lead@example.com",
    normalized_recipient_email: "delivery-control-lead@example.com",
    subject: "Follow-up",
    metadata: {},
    provider: "gmail",
    composio_connected_account_id: `delivery-control-${ids.mailbox}`,
    daily_limit: 40,
    hourly_limit: 10,
    ramp_started_on: null,
    workspace_daily_cap: 200,
    postal_address: "123 Main St",
    mailbox_email: "sender@example.com",
  };

  beforeAll(async () => {
    await pool.query("SELECT 1");
    await pool.query("INSERT INTO auth_users (id,name,email,email_verified) VALUES ($1,'Delivery Control',$2,true)", [ids.user, `delivery-control-${ids.user}@example.com`]);
    await pool.query("INSERT INTO users (id,email,normalized_email) VALUES ($1,$2,$2)", [ids.user, `delivery-control-${ids.user}@example.com`]);
    await pool.query("INSERT INTO workspaces (id,name,slug,created_by_user_id,postal_address) VALUES ($1,'Delivery Control',$2,$3,'123 Main St')", [ids.workspace, `delivery-control-${ids.workspace}`, ids.user]);
    await pool.query("INSERT INTO memberships (id,workspace_id,user_id,role,status) VALUES ($1,$2,$3,'owner','active')", [randomUUID(), ids.workspace, ids.user]);
    await pool.query("INSERT INTO subscriptions (id,workspace_id,status) VALUES ($1,$2,'active')", [randomUUID(), ids.workspace]);
    await pool.query(`INSERT INTO email_accounts (id,workspace_id,user_id,provider,composio_connected_account_id,email,normalized_email,alias,status,daily_limit,hourly_limit)
      VALUES ($1,$2,$3,'gmail',$4,'sender@example.com','sender@example.com','delivery-control','active',40,10)`, [ids.mailbox, ids.workspace, ids.user, message.composio_connected_account_id]);
    await pool.query("INSERT INTO contacts (id,workspace_id,email,normalized_email,status) VALUES ($1,$2,$3,$3,'enrolled')", [ids.contact, ids.workspace, message.recipient_email]);
    await pool.query("INSERT INTO sequences (id,workspace_id,name,status,created_by_user_id) VALUES ($1,$2,'Delivery Control','active',$3)", [ids.sequence, ids.workspace, ids.user]);
    await pool.query("INSERT INTO sequence_versions (id,workspace_id,sequence_id,version,status,created_by_user_id) VALUES ($1,$2,$3,1,'active',$4)", [ids.version, ids.workspace, ids.sequence, ids.user]);
    await pool.query("UPDATE sequences SET current_version_id=$2 WHERE id=$1", [ids.sequence, ids.version]);
    await pool.query("INSERT INTO sequence_steps (id,workspace_id,sequence_version_id,step_order,delay_days,subject,body_text) VALUES ($1,$2,$3,2,1,'Follow-up','Hello')", [ids.step, ids.workspace, ids.version]);
    await pool.query(`INSERT INTO enrollments (id,workspace_id,contact_id,sequence_id,sequence_version_id,email_account_id,status,next_step_order)
      VALUES ($1,$2,$3,$4,$5,$6,'active',2)`, [ids.enrollment, ids.workspace, ids.contact, ids.sequence, ids.version, ids.mailbox]);
    await pool.query(`INSERT INTO messages (id,workspace_id,enrollment_id,sequence_step_id,email_account_id,contact_id,status,idempotency_key,scheduled_at,
      recipient_email,normalized_recipient_email,subject,body_hash) VALUES ($1,$2,$3,$4,$5,$6,'sending',$7,now(),$8,$8,'Follow-up','hash')`,
    [ids.message, ids.workspace, ids.enrollment, ids.step, ids.mailbox, ids.contact, `delivery-control:${ids.message}`, message.recipient_email]);
    await pool.query("INSERT INTO send_attempts (id,workspace_id,message_id,attempt_number,status) VALUES ($1,$2,$3,1,'sending')", [randomUUID(), ids.workspace, ids.message]);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM provider_circuit WHERE provider='gmail'");
    await pool.query("DELETE FROM workspaces WHERE id=$1", [ids.workspace]);
    await pool.query("DELETE FROM users WHERE id=$1", [ids.user]);
    await pool.query("DELETE FROM auth_users WHERE id=$1", [ids.user]);
    await pool.end();
  });

  it("persists throttling, escalation, and gradual recovery", async () => {
    const client = await pool.connect();
    try {
      for (const at of ["2026-09-01T12:00:00.000Z", "2026-09-01T12:01:00.000Z", "2026-09-01T12:02:00.000Z"]) {
        await client.query("BEGIN");
        await updateMailboxHealthForFailure(client, message, "temporary", new Date(at));
        await client.query("COMMIT");
      }
      const throttled = await pool.query("SELECT state,effective_daily_limit,consecutive_failures,throttled_until FROM mailbox_health WHERE email_account_id=$1", [ids.mailbox]);
      expect(throttled.rows[0]).toMatchObject({ state: "throttled", effective_daily_limit: 10, consecutive_failures: 3 });
      expect(new Date(throttled.rows[0].throttled_until).toISOString()).toBe("2026-09-01T14:02:00.000Z");

      await client.query("BEGIN");
      await updateMailboxHealthForSuccess(client, message, new Date("2026-09-01T12:03:00.000Z"));
      await client.query("COMMIT");
      const recovered = await pool.query("SELECT state,effective_daily_limit,consecutive_failures,throttled_until FROM mailbox_health WHERE email_account_id=$1", [ids.mailbox]);
      expect(recovered.rows[0]).toMatchObject({ state: "throttled", effective_daily_limit: 20, consecutive_failures: 2, throttled_until: null });
    } finally {
      client.release();
    }
  });

  it("opens the provider circuit after consecutive provider failures", async () => {
    await pool.query("DELETE FROM provider_circuit WHERE provider='gmail'");
    await pool.query("UPDATE enrollments SET status='active',stop_reason=NULL WHERE id=$1", [ids.enrollment]);
    for (let attemptNumber = 1; attemptNumber <= 5; attemptNumber += 1) {
      await pool.query("UPDATE messages SET status='sending' WHERE id=$1", [ids.message]);
      await pool.query("INSERT INTO send_attempts (id,workspace_id,message_id,attempt_number,status) VALUES ($1,$2,$3,$4,'sending') ON CONFLICT (message_id,attempt_number) DO UPDATE SET status='sending'", [randomUUID(), ids.workspace, ids.message, attemptNumber]);
      const client = await pool.connect();
      try {
        await recordFailure(client, message, attemptNumber, new ComposioRequestError(429, { error: "rate limited" }));
      } finally {
        client.release();
      }
    }
    const circuit = await pool.query("SELECT state,failure_count,next_probe_at FROM provider_circuit WHERE provider='gmail'");
    expect(circuit.rows[0]).toMatchObject({ state: "open", failure_count: 5 });
    expect(circuit.rows[0].next_probe_at).not.toBeNull();
  });

  it("cancels a sending follow-up when reply evidence exists for its contact", async () => {
    await pool.query("UPDATE enrollments SET status='active',stop_reason=NULL WHERE id=$1", [ids.enrollment]);
    await pool.query("UPDATE contacts SET status='enrolled',replied_at=NULL WHERE id=$1", [ids.contact]);
    await pool.query("UPDATE messages SET status='sending',blocked_reason=NULL,error_class=NULL WHERE id=$1", [ids.message]);
    await pool.query("UPDATE send_attempts SET status='sending',error_class=NULL,error_message=NULL WHERE message_id=$1 AND attempt_number=1", [ids.message]);
    await pool.query("INSERT INTO message_events (id,workspace_id,event_type,occurred_at,metadata) VALUES ($1,$2,'replied',now(),$3::jsonb)", [randomUUID(), ids.workspace, JSON.stringify({ sender: message.normalized_recipient_email })]);
    const client = await pool.connect();
    try {
      await expect(preSendReplyCheck(client, message, 1, false, { edition: "cloud" })).resolves.toBe(false);
    } finally {
      client.release();
    }
    const result = await pool.query("SELECT status,blocked_reason FROM messages WHERE id=$1", [ids.message]);
    expect(result.rows[0]).toEqual({ status: "cancelled", blocked_reason: "already_replied" });
  });

  it("atomically reserves hourly mailbox capacity across concurrent claims", async () => {
    await pool.query("DELETE FROM provider_circuit WHERE provider='gmail'");
    const mailboxId = randomUUID();
    const contactIds = [randomUUID(), randomUUID()];
    const enrollmentIds = [randomUUID(), randomUUID()];
    const messageIds = [randomUUID(), randomUUID()];
    await pool.query(`INSERT INTO email_accounts (id,workspace_id,user_id,provider,composio_connected_account_id,email,normalized_email,alias,status,daily_limit,hourly_limit)
      VALUES ($1,$2,$3,'gmail',$4,'capacity@example.com','capacity@example.com','capacity','active',50,1)`, [mailboxId, ids.workspace, ids.user, `delivery-control-${mailboxId}`]);
    for (let index = 0; index < 2; index += 1) {
      await pool.query("INSERT INTO contacts (id,workspace_id,email,normalized_email,status) VALUES ($1,$2,$3,$3,'enrolled')", [contactIds[index], ids.workspace, `capacity-${index}@example.com`]);
      await pool.query(`INSERT INTO enrollments (id,workspace_id,contact_id,sequence_id,sequence_version_id,email_account_id,status,next_step_order)
        VALUES ($1,$2,$3,$4,$5,$6,'active',2)`, [enrollmentIds[index], ids.workspace, contactIds[index], ids.sequence, ids.version, mailboxId]);
      await pool.query(`INSERT INTO messages (id,workspace_id,enrollment_id,sequence_step_id,email_account_id,contact_id,status,idempotency_key,scheduled_at,
        recipient_email,normalized_recipient_email,subject,body_hash,tracking_token,metadata) VALUES ($1,$2,$3,$4,$5,$6,'scheduled',$7,now()-interval '1 minute',$8,$8,'Hi','hash',$9,$10::jsonb)`,
      [messageIds[index], ids.workspace, enrollmentIds[index], ids.step, mailboxId, contactIds[index], `capacity:${index}:${messageIds[index]}`, `capacity-${index}@example.com`, randomUUID().replaceAll("-", ""), JSON.stringify({ bodyText: "Hi" })]);
    }

    const clients = await Promise.all([pool.connect(), pool.connect()]);
    try {
      const claims = await Promise.all(messageIds.map((messageId, index) => claimMessage(clients[index]!, {
        workspaceId: ids.workspace,
        enrollmentId: enrollmentIds[index]!,
        sequenceStepId: ids.step,
        idempotencyKey: `capacity:${index}:${messageId}`,
      }, { edition: "cloud" })));
      expect(claims.filter((claim) => claim.message).length).toBe(1);
      const sending = await pool.query("SELECT count(*)::int AS count FROM messages WHERE email_account_id=$1 AND status='sending'", [mailboxId]);
      expect(sending.rows[0].count).toBe(1);
    } finally {
      clients.forEach((client) => client.release());
    }
  });
  it("recovers an abandoned provider probe before evaluating the send gate", async () => {
    const [candidate] = (await pool.query("SELECT m.id,m.enrollment_id,m.idempotency_key FROM messages m JOIN email_accounts a ON a.id=m.email_account_id WHERE m.workspace_id=$1 AND a.alias='capacity' AND m.status='scheduled' LIMIT 1", [ids.workspace])).rows;
    await pool.query("UPDATE messages SET status='cancelled' WHERE workspace_id=$1 AND status='sending'", [ids.workspace]);
    await pool.query("UPDATE messages SET scheduled_at=now()-interval '1 minute' WHERE id=$1", [candidate.id]);
    await pool.query("INSERT INTO provider_circuit (provider,state,failure_count,updated_at) VALUES ('gmail','half_open',5,now()-interval '11 minutes') ON CONFLICT (provider) DO UPDATE SET state='half_open',updated_at=now()-interval '11 minutes'");
    const client = await pool.connect();
    try {
      const result = await claimMessage(client, { workspaceId: ids.workspace, enrollmentId: candidate.enrollment_id, sequenceStepId: ids.step, idempotencyKey: candidate.idempotency_key }, { edition: "cloud" });
      expect(result.message?.id).toBe(candidate.id);
      expect((await pool.query("SELECT state FROM provider_circuit WHERE provider='gmail'")).rows[0].state).toBe("half_open");
    } finally { client.release(); }
  });

  it.each(["final_step", "cancelled"] as const)("finishes a campaign through worker %s bookkeeping", async (path) => {
    const contactId = randomUUID();
    const enrollmentId = randomUUID();
    const campaignId = randomUUID();
    const messageId = randomUUID();
    const email = `worker-finish-${contactId}@example.com`;
    await pool.query("INSERT INTO contacts (id,workspace_id,email,normalized_email,status) VALUES ($1,$2,$3,$3,'enrolled')", [contactId, ids.workspace, email]);
    await pool.query("INSERT INTO campaigns (id,workspace_id,sequence_id,email_account_id,name,status,launched_at) VALUES ($1,$2,$3,$4,$5,'active',now())", [campaignId, ids.workspace, ids.sequence, ids.mailbox, campaignId]);
    await pool.query("INSERT INTO enrollments (id,workspace_id,contact_id,sequence_id,sequence_version_id,email_account_id,campaign_id,status) VALUES ($1,$2,$3,$4,$5,$6,$7,'active')", [enrollmentId, ids.workspace, contactId, ids.sequence, ids.version, ids.mailbox, campaignId]);
    await pool.query("INSERT INTO messages (id,workspace_id,enrollment_id,sequence_step_id,email_account_id,contact_id,status,idempotency_key,scheduled_at,recipient_email,normalized_recipient_email,subject,body_hash,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),$9,$9,'Hello','hash',$10::jsonb)", [messageId, ids.workspace, enrollmentId, ids.step, ids.mailbox, contactId, path === "final_step" ? "accepted" : "sending", messageId, email, JSON.stringify({ acceptanceBookkeepingPending: path === "final_step" })]);
    const client = await pool.connect();
    try {
      const claimed = { ...message, id: messageId, contact_id: contactId, enrollment_id: enrollmentId, campaign_id: campaignId };
      if (path === "final_step") {
        expect(await completeAcceptedBookkeeping(client, claimed, { pool })).toBe(true);
        expect(await completeAcceptedBookkeeping(client, claimed, { pool })).toBe(false);
      } else {
        await recordFailure(client, { ...claimed, sequence_id: ids.sequence, mailbox_user_id: ids.user }, 1, new Error("Message tracking token is missing; refusing to send"), false);
      }
      const campaign = await pool.query("SELECT status,completed_at FROM campaigns WHERE id=$1", [campaignId]);
      expect(campaign.rows[0].status).toBe("completed");
      expect(campaign.rows[0].completed_at).toBeInstanceOf(Date);
      const notifications = await pool.query("SELECT id FROM notifications WHERE workspace_id=$1 AND type='campaign_completed' AND title=$2", [ids.workspace, `Campaign completed: ${campaignId}`]);
      expect(notifications.rows).toHaveLength(1);
    } finally {
      client.release();
    }
  });
});
