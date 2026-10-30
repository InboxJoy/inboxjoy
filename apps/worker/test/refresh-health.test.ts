import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { refreshHealth } from "../src/jobs/refresh-health.js";

function ownerRow(email = "owner@example.com", name: string | null = "Owner") {
  return { rows: [{ email, display_name: name }] };
}

describe("refreshHealth mailbox alerts", () => {
  it("emails only mailboxes that transitioned into a non-sending state, not ones already there", async () => {
    const rows = [
      // healthy -> critical: a genuine transition, should alert.
      { id: "mailbox-1", mailbox_email: "one@example.com", workspace_id: "workspace-1", new_state: "critical", previous_state: "healthy" },
      // auth_error -> auth_error: state preserved by refresh-health's own CASE logic
      // (it never re-derives a bad state), so this is not a new transition.
      { id: "mailbox-2", mailbox_email: "two@example.com", workspace_id: "workspace-2", new_state: "auth_error", previous_state: "auth_error" },
      // no prior row (new mailbox) landing healthy: no alert.
      { id: "mailbox-3", mailbox_email: "three@example.com", workspace_id: "workspace-3", new_state: "healthy", previous_state: null },
    ];
    const pool = {
      query: vi.fn(async (text: string) => {
        if (text.includes("existing_health")) return { rowCount: rows.length, rows };
        if (text.includes("FROM memberships m JOIN users u")) return ownerRow();
        return { rowCount: 0, rows: [] };
      }),
    };
    const sendMailboxAlert = vi.fn().mockResolvedValue(undefined);

    await refreshHealth({}, { pool: pool as never, transactionalEmail: { enabled: true, sendMailboxAlert } as never });

    expect(sendMailboxAlert).toHaveBeenCalledTimes(1);
    expect(sendMailboxAlert).toHaveBeenCalledWith(expect.objectContaining({
      mailboxEmail: "one@example.com",
      reasonSentence: "This mailbox is not currently able to send.",
    }));
  });

  it("never touches the database when deps are missing", async () => {
    await expect(refreshHealth({})).resolves.toBeUndefined();
  });
});

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("refreshHealth bounce accounting", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const ids = {
    user: randomUUID(),
    workspace: randomUUID(),
    criticalMailbox: randomUUID(),
    rateMailbox: randomUUID(),
    backlogMailbox: randomUUID(),
    contact: randomUUID(),
    sequence: randomUUID(),
    version: randomUUID(),
    step: randomUUID(),
    enrollment: randomUUID(),
  };

  beforeAll(async () => {
    await pool.query("INSERT INTO users (id,email,normalized_email) VALUES ($1,$2,$2)", [ids.user, `health-${ids.user}@example.com`]);
    await pool.query("INSERT INTO workspaces (id,name,slug,created_by_user_id) VALUES ($1,'Health audit',$2,$3)", [ids.workspace, `health-${ids.workspace}`, ids.user]);
    await pool.query(`INSERT INTO email_accounts (id,workspace_id,user_id,provider,composio_connected_account_id,email,normalized_email,alias,status,daily_limit,hourly_limit) VALUES
      ($1,$3,$4,'gmail',$5,'critical@example.com','critical@example.com','critical','active',40,10),
      ($2,$3,$4,'gmail',$6,'rate@example.com','rate@example.com','rate','active',200,50),
      ($7,$3,$4,'gmail',$8,'backlog@example.com','backlog@example.com','backlog','active',30,5)`, [ids.criticalMailbox, ids.rateMailbox, ids.workspace, ids.user, `health-critical-${ids.criticalMailbox}`, `health-rate-${ids.rateMailbox}`, ids.backlogMailbox, `health-backlog-${ids.backlogMailbox}`]);
    await pool.query("INSERT INTO contacts (id,workspace_id,email,normalized_email) VALUES ($1,$2,'health-lead@example.com','health-lead@example.com')", [ids.contact, ids.workspace]);
    await pool.query("INSERT INTO sequences (id,workspace_id,name,status,created_by_user_id) VALUES ($1,$2,'Health sequence','active',$3)", [ids.sequence, ids.workspace, ids.user]);
    await pool.query("INSERT INTO sequence_versions (id,workspace_id,sequence_id,version,status,created_by_user_id) VALUES ($1,$2,$3,1,'active',$4)", [ids.version, ids.workspace, ids.sequence, ids.user]);
    await pool.query("UPDATE sequences SET current_version_id=$2 WHERE id=$1", [ids.sequence, ids.version]);
    await pool.query("INSERT INTO sequence_steps (id,workspace_id,sequence_version_id,step_order,delay_days,subject,body_text) VALUES ($1,$2,$3,1,0,'Health','Health')", [ids.step, ids.workspace, ids.version]);
    await pool.query("INSERT INTO enrollments (id,workspace_id,contact_id,sequence_id,sequence_version_id,email_account_id,status) VALUES ($1,$2,$3,$4,$5,$6,'active')", [ids.enrollment, ids.workspace, ids.contact, ids.sequence, ids.version, ids.criticalMailbox]);
    await pool.query(`INSERT INTO messages (id,workspace_id,enrollment_id,sequence_step_id,email_account_id,contact_id,status,idempotency_key,scheduled_at,accepted_at,bounced_at,recipient_email,normalized_recipient_email,subject,body_hash,error_class,created_at)
      SELECT gen_random_uuid(),$1,$2,$3,$4,$5,'accepted',concat('health-critical-', $6::text, '-', n),now(),now(),now(),'health-lead@example.com','health-lead@example.com','Health','hash','hard_bounce',now() - interval '2 days'
      FROM generate_series(1,3) n`, [ids.workspace, ids.enrollment, ids.step, ids.criticalMailbox, ids.contact, ids.workspace]);
    await pool.query(`INSERT INTO messages (id,workspace_id,enrollment_id,sequence_step_id,email_account_id,contact_id,status,idempotency_key,scheduled_at,accepted_at,bounced_at,recipient_email,normalized_recipient_email,subject,body_hash,error_class)
      SELECT gen_random_uuid(),$1,$2,$3,$4,$5,'accepted',concat('health-rate-', $6::text, '-', n),now(),now(),CASE WHEN n=1 THEN now() END,'health-lead@example.com','health-lead@example.com','Health','hash',CASE WHEN n=1 THEN 'hard_bounce' END
      FROM generate_series(1,200) n`, [ids.workspace, ids.enrollment, ids.step, ids.rateMailbox, ids.contact, ids.workspace]);
    // Enrolled 10 days ago, sent within the last hour: the backlog case.
    await pool.query(`INSERT INTO messages (id,workspace_id,enrollment_id,sequence_step_id,email_account_id,contact_id,status,idempotency_key,scheduled_at,accepted_at,recipient_email,normalized_recipient_email,subject,body_hash,created_at)
      SELECT gen_random_uuid(),$1,$2,$3,$4,$5,'accepted',concat('health-backlog-', $6::text, '-', n),now(),now() - interval '1 hour','health-lead@example.com','health-lead@example.com','Health','hash',now() - interval '10 days'
      FROM generate_series(1,5) n`, [ids.workspace, ids.enrollment, ids.step, ids.backlogMailbox, ids.contact, ids.workspace]);
    await pool.query(`INSERT INTO message_events (id,workspace_id,message_id,event_type,occurred_at)
      SELECT gen_random_uuid(),workspace_id,id,'hard_bounce',now() FROM messages
      WHERE email_account_id IN ($1,$2) AND bounced_at IS NOT NULL`, [ids.criticalMailbox, ids.rateMailbox]);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM workspaces WHERE id=$1", [ids.workspace]);
    await pool.query("DELETE FROM users WHERE id=$1", [ids.user]);
    await pool.end();
  });

  it("marks three accepted hard bounces critical and calculates one of 200 as 0.5 percent", async () => {
    await refreshHealth({ mailboxId: ids.criticalMailbox }, { pool });
    await refreshHealth({ mailboxId: ids.rateMailbox }, { pool });

    const health = await pool.query<{ email_account_id: string; state: string; perm_failures_24h: number; bounce_rate: string }>(
      "SELECT email_account_id,state,perm_failures_24h,bounce_rate FROM mailbox_health WHERE email_account_id IN ($1,$2)",
      [ids.criticalMailbox, ids.rateMailbox],
    );
    const critical = health.rows.find((row) => row.email_account_id === ids.criticalMailbox);
    const rate = health.rows.find((row) => row.email_account_id === ids.rateMailbox);
    expect(critical).toMatchObject({ state: "critical", perm_failures_24h: 3 });
    expect(Number(rate?.bounce_rate)).toBe(0.5);
  });

  it("records the last send for mail created before the 7-day window but sent inside it", async () => {
    await refreshHealth({ mailboxId: ids.backlogMailbox }, { pool });

    const health = await pool.query<{ last_successful_send_at: Date | null }>(
      "SELECT last_successful_send_at FROM mailbox_health WHERE email_account_id=$1",
      [ids.backlogMailbox],
    );
    expect(health.rows[0]?.last_successful_send_at).toBeInstanceOf(Date);
    expect(Date.now() - health.rows[0]!.last_successful_send_at!.getTime()).toBeLessThan(2 * 60 * 60 * 1000);
  });
});
