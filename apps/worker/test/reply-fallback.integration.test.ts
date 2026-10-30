import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { persistProviderReply } from "../src/jobs/send-message.js";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("provider reply fallback persistence", () => {
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
    acceptedMessage: randomUUID(),
  };
  const receivedAt = new Date("2026-09-20T12:00:00.000Z");
  const message = {
    id: randomUUID(),
    workspace_id: ids.workspace,
    enrollment_id: ids.enrollment,
    sequence_id: ids.sequence,
    email_account_id: ids.mailbox,
    contact_id: ids.contact,
    normalized_recipient_email: "lead@example.com",
    provider: "gmail" as const,
  } as never;
  const reply = {
    providerMessageId: "provider-reply-123",
    providerThreadId: "thread-123",
    subject: "Re: Hello",
    bodyText: "Sounds good",
    from: "lead@example.com",
    receivedAt,
  };

  beforeAll(async () => {
    const email = `reply-fallback-${ids.user}@example.com`;
    await pool.query("INSERT INTO auth_users (id,name,email,email_verified) VALUES ($1,'Reply Fallback',$2,true)", [ids.user, email]);
    await pool.query("INSERT INTO users (id,email,normalized_email) VALUES ($1,$2,$2)", [ids.user, email]);
    await pool.query("INSERT INTO workspaces (id,name,slug,created_by_user_id,postal_address) VALUES ($1,'Reply Fallback',$2,$3,'123 Main St')", [ids.workspace, `reply-fallback-${ids.workspace}`, ids.user]);
    await pool.query(`INSERT INTO email_accounts (id,workspace_id,user_id,provider,composio_connected_account_id,email,normalized_email,alias,status,daily_limit,hourly_limit)
      VALUES ($1,$2,$3,'gmail',$4,'sender@example.com','sender@example.com','reply-fallback','active',40,10)`, [ids.mailbox, ids.workspace, ids.user, `reply-fallback-${ids.mailbox}`]);
    await pool.query("INSERT INTO contacts (id,workspace_id,email,normalized_email,status) VALUES ($1,$2,'lead@example.com','lead@example.com','enrolled')", [ids.contact, ids.workspace]);
    await pool.query("INSERT INTO sequences (id,workspace_id,name,status,created_by_user_id) VALUES ($1,$2,'Reply Fallback','active',$3)", [ids.sequence, ids.workspace, ids.user]);
    await pool.query("INSERT INTO sequence_versions (id,workspace_id,sequence_id,version,status,created_by_user_id) VALUES ($1,$2,$3,1,'active',$4)", [ids.version, ids.workspace, ids.sequence, ids.user]);
    await pool.query("UPDATE sequences SET current_version_id=$2 WHERE id=$1", [ids.sequence, ids.version]);
    await pool.query("INSERT INTO sequence_steps (id,workspace_id,sequence_version_id,step_order,delay_days,subject,body_text) VALUES ($1,$2,$3,1,0,'Hello','Hello')", [ids.step, ids.workspace, ids.version]);
    await pool.query(`INSERT INTO enrollments (id,workspace_id,contact_id,sequence_id,sequence_version_id,email_account_id,status,next_step_order)
      VALUES ($1,$2,$3,$4,$5,$6,'active',1)`, [ids.enrollment, ids.workspace, ids.contact, ids.sequence, ids.version, ids.mailbox]);
    await pool.query(`INSERT INTO messages (id,workspace_id,enrollment_id,sequence_step_id,email_account_id,contact_id,status,idempotency_key,scheduled_at,accepted_at,
      recipient_email,normalized_recipient_email,subject,body_hash,tracking_token,metadata)
      VALUES ($1,$2,$3,$4,$5,$6,'accepted',$7,now()-interval '1 day',now()-interval '1 day','lead@example.com','lead@example.com','Hello','hash',$8,'{}'::jsonb)`,
      [ids.acceptedMessage, ids.workspace, ids.enrollment, ids.step, ids.mailbox, ids.contact, `reply-fallback:${ids.acceptedMessage}`, randomUUID().replaceAll("-", "")]);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM workspaces WHERE id=$1", [ids.workspace]);
    await pool.query("DELETE FROM users WHERE id=$1", [ids.user]);
    await pool.query("DELETE FROM auth_users WHERE id=$1", [ids.user]);
    await pool.end();
  });

  it("writes the missed inbound reply and replied event once, linked to the accepted message", async () => {
    await persistProviderReply(pool, message, reply);
    await persistProviderReply(pool, message, reply);

    const storedReplies = await pool.query("SELECT in_reply_to_message_id,provider_message_id,body_text,source FROM replies WHERE workspace_id=$1", [ids.workspace]);
    expect(storedReplies.rows).toEqual([{
      in_reply_to_message_id: ids.acceptedMessage,
      provider_message_id: reply.providerMessageId,
      body_text: reply.bodyText,
      source: "backfill",
    }]);
    const events = await pool.query("SELECT message_id,event_type,provider_event_id FROM message_events WHERE workspace_id=$1 AND event_type='replied'", [ids.workspace]);
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]).toMatchObject({ message_id: ids.acceptedMessage, event_type: "replied" });
    expect(events.rows[0].provider_event_id).toMatch(/^provider-reply:/);
  });
});
