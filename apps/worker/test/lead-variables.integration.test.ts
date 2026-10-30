import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { completeAcceptedBookkeeping, render, type ClaimedMessage } from "../src/jobs/send-message.js";

const databaseUrl = process.env.DATABASE_URL;
const deps = (pool: Pool) => ({ pool, apiBaseUrl: "https://api.example.test", authSecret: "lead-variables-follow-up-secret" });

describe("worker template rendering adapter", () => {
  it("maps snake_case rows, campaign variables and custom fields", () => {
    expect(render("Hi {{firstName}} {{icebreaker}} {{topic}}", { first_name: "Ada", campaign_variables: { icebreaker: "Nice talk." }, custom_fields: { topic: "ops" } })).toBe("Hi Ada Nice talk. ops");
  });
});

describe.skipIf(!databaseUrl)("follow-ups with per-lead variables", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const user = randomUUID();
  const workspace = randomUUID();
  const mailbox = randomUUID();

  beforeAll(async () => {
    await pool.query("INSERT INTO users (id,email,normalized_email) VALUES ($1,$2,$2)", [user, `lv-worker-${user}@example.com`]);
    await pool.query("INSERT INTO workspaces (id,name,slug,created_by_user_id,postal_address) VALUES ($1,'LV Worker',$2,$3,'123 Main St')", [workspace, `lv-worker-${workspace}`, user]);
    await pool.query(`INSERT INTO email_accounts (id,workspace_id,user_id,provider,composio_connected_account_id,email,normalized_email,alias,status,daily_limit,hourly_limit)
      VALUES ($1,$2,$3,'gmail',$4,'lv-sender@example.com','lv-sender@example.com','lv-sender','active',40,10)`, [mailbox, workspace, user, `lv-${mailbox}`]);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM workspaces WHERE id=$1", [workspace]);
    await pool.query("DELETE FROM users WHERE id=$1", [user]);
    await pool.end();
  });

  // Builds a contact enrolled in a sequence whose first step was just accepted.
  async function enrollAccepted(input: { contactId: string; email: string; followUpBody: string; steps?: 2 | 1; campaignValue?: string; customField?: string; enforced?: boolean }) {
    const sequence = randomUUID();
    const version = randomUUID();
    const first = randomUUID();
    const second = randomUUID();
    const enrollment = randomUUID();
    const messageId = randomUUID();
    await pool.query("INSERT INTO sequences (id,workspace_id,name,status,created_by_user_id) VALUES ($1,$2,'LV sequence','active',$3)", [sequence, workspace, user]);
    await pool.query("INSERT INTO sequence_versions (id,workspace_id,sequence_id,version,status,created_by_user_id) VALUES ($1,$2,$3,1,'active',$4)", [version, workspace, sequence, user]);
    await pool.query("UPDATE sequences SET current_version_id=$2 WHERE id=$1", [sequence, version]);
    if (input.enforced === false) await pool.query("UPDATE sequence_versions SET custom_variables_enforced=false WHERE id=$1", [version]);
    await pool.query("INSERT INTO sequence_steps (id,workspace_id,sequence_version_id,step_order,delay_days,subject,body_text) VALUES ($1,$2,$3,1,0,'First','Hello')", [first, workspace, version]);
    if ((input.steps ?? 2) === 2) await pool.query("INSERT INTO sequence_steps (id,workspace_id,sequence_version_id,step_order,delay_days,subject,body_text) VALUES ($1,$2,$3,2,1,'Second',$4)", [second, workspace, version, input.followUpBody]);
    await pool.query("INSERT INTO enrollments (id,workspace_id,contact_id,sequence_id,sequence_version_id,email_account_id,status,next_step_order) VALUES ($1,$2,$3,$4,$5,$6,'active',1)", [enrollment, workspace, input.contactId, sequence, version, mailbox]);
    await pool.query(`INSERT INTO messages (id,workspace_id,enrollment_id,sequence_step_id,email_account_id,contact_id,status,idempotency_key,scheduled_at,accepted_at,
      recipient_email,normalized_recipient_email,subject,body_hash,metadata) VALUES ($1,$2,$3,$4,$5,$6,'accepted',$7,now(),now(),$8,$8,'First','hash',$9::jsonb)`,
    [messageId, workspace, enrollment, first, mailbox, input.contactId, `lv:${messageId}`, input.email, JSON.stringify({ acceptanceBookkeepingPending: true })]);
    if (input.campaignValue !== undefined) await pool.query("INSERT INTO campaign_lead_variables (sequence_id,contact_id,workspace_id,\"values\") VALUES ($1,$2,$3,$4::jsonb)", [sequence, input.contactId, workspace, JSON.stringify({ icebreaker: input.campaignValue })]);
    const claimed: ClaimedMessage = {
      id: messageId, workspace_id: workspace, enrollment_id: enrollment, sequence_step_id: first, email_account_id: mailbox, contact_id: input.contactId,
      recipient_email: input.email, normalized_recipient_email: input.email, subject: "First", metadata: { acceptanceBookkeepingPending: true },
      provider: "gmail", composio_connected_account_id: `lv-${mailbox}`, daily_limit: 40, hourly_limit: 10, ramp_started_on: null, ramp_paused_days: 0,
      workspace_daily_cap: 200, postal_address: "123 Main St", mailbox_email: "lv-sender@example.com",
    };
    return { claimed, enrollment, second, sequence };
  }

  async function createContact(status = "enrolled", customFields: Record<string, string> = {}) {
    const id = randomUUID();
    const email = `lv-${id}@example.com`;
    await pool.query("INSERT INTO contacts (id,workspace_id,email,normalized_email,first_name,status,custom_fields) VALUES ($1,$2,$3,$3,'Ada',$4,$5::jsonb)", [id, workspace, email, status, JSON.stringify(customFields)]);
    return { id, email };
  }

  async function complete(claimed: ClaimedMessage) {
    const client = await pool.connect();
    try {
      return await completeAcceptedBookkeeping(client, claimed, deps(pool));
    } finally {
      client.release();
    }
  }

  it("renders the follow-up with the campaign value", async () => {
    const contact = await createContact();
    const fixture = await enrollAccepted({ contactId: contact.id, email: contact.email, followUpBody: "Hi {{firstName}}, {{icebreaker}}", campaignValue: "Loved your launch." });
    await expect(complete(fixture.claimed)).resolves.toBe(true);
    const followUp = await pool.query<{ metadata: { bodyText: string } }>("SELECT metadata FROM messages WHERE enrollment_id=$1 AND sequence_step_id=$2", [fixture.enrollment, fixture.second]);
    expect(followUp.rows).toHaveLength(1);
    expect(followUp.rows[0]!.metadata.bodyText).toContain("Hi Ada, Loved your launch.");
  });

  it("falls back to the lead custom field", async () => {
    const contact = await createContact("enrolled", { icebreaker: "From the import." });
    const fixture = await enrollAccepted({ contactId: contact.id, email: contact.email, followUpBody: "{{icebreaker}}" });
    await expect(complete(fixture.claimed)).resolves.toBe(true);
    const followUp = await pool.query<{ metadata: { bodyText: string } }>("SELECT metadata FROM messages WHERE enrollment_id=$1 AND sequence_step_id=$2", [fixture.enrollment, fixture.second]);
    expect(followUp.rows[0]!.metadata.bodyText).toContain("From the import.");
  });

  it("stops the enrollment without a blank follow-up when the value was removed", async () => {
    const contact = await createContact();
    const fixture = await enrollAccepted({ contactId: contact.id, email: contact.email, followUpBody: "Hi {{firstName}}, {{icebreaker}}" });
    await expect(complete(fixture.claimed)).resolves.toBe(true);
    const messages = await pool.query("SELECT id FROM messages WHERE enrollment_id=$1 AND sequence_step_id=$2", [fixture.enrollment, fixture.second]);
    expect(messages.rowCount).toBe(0);
    const enrollment = await pool.query("SELECT status,stop_reason,next_due_at FROM enrollments WHERE id=$1", [fixture.enrollment]);
    expect(enrollment.rows[0]).toMatchObject({ status: "cancelled", stop_reason: "missing_variables", next_due_at: null });
    const status = await pool.query("SELECT status FROM contacts WHERE id=$1", [contact.id]);
    expect(status.rows[0]).toMatchObject({ status: "active" });
    // Bookkeeping already completed: running it again changes nothing and creates nothing.
    await expect(complete(fixture.claimed)).resolves.toBe(false);
    expect((await pool.query("SELECT id FROM messages WHERE enrollment_id=$1", [fixture.enrollment])).rowCount).toBe(1);
  });

  it("stages a directly enrolled lead it stops so the follow-up resumes once the value returns", async () => {
    const contact = await createContact();
    const fixture = await enrollAccepted({ contactId: contact.id, email: contact.email, followUpBody: "{{icebreaker}}" });
    await expect(complete(fixture.claimed)).resolves.toBe(true);
    expect((await pool.query("SELECT status,stop_reason FROM enrollments WHERE id=$1", [fixture.enrollment])).rows[0]).toMatchObject({ status: "cancelled", stop_reason: "missing_variables" });
    const staged = await pool.query("SELECT workspace_id,lead_id,campaign_id,inbox_ids FROM staged_enrollments WHERE sequence_id=$1", [fixture.sequence]);
    expect(staged.rows).toEqual([{ workspace_id: workspace, lead_id: contact.id, campaign_id: null, inbox_ids: [mailbox] }]);
  });

  it("sends a grandfathered version's follow-up with the custom token as literal text instead of stopping", async () => {
    const contact = await createContact();
    const fixture = await enrollAccepted({ contactId: contact.id, email: contact.email, followUpBody: "Hi {{first_name}}, {{icebreaker}}", enforced: false });
    await expect(complete(fixture.claimed)).resolves.toBe(true);
    const followUp = await pool.query<{ metadata: { bodyText: string } }>("SELECT metadata FROM messages WHERE enrollment_id=$1 AND sequence_step_id=$2", [fixture.enrollment, fixture.second]);
    expect(followUp.rows).toHaveLength(1);
    expect(followUp.rows[0]!.metadata.bodyText).toContain("Hi Ada, {{icebreaker}}");
    expect((await pool.query("SELECT status,stop_reason FROM enrollments WHERE id=$1", [fixture.enrollment])).rows[0]).toMatchObject({ status: "active", stop_reason: null });
  });

  it("keeps the lead enrolled while another sequence is still running", async () => {
    const contact = await createContact();
    const finishing = await enrollAccepted({ contactId: contact.id, email: contact.email, followUpBody: "unused", steps: 1 });
    const other = await enrollAccepted({ contactId: contact.id, email: contact.email, followUpBody: "Second" });
    await expect(complete(finishing.claimed)).resolves.toBe(true);
    expect((await pool.query("SELECT status FROM enrollments WHERE id=$1", [finishing.enrollment])).rows[0]).toMatchObject({ status: "completed" });
    expect((await pool.query("SELECT status FROM contacts WHERE id=$1", [contact.id])).rows[0]).toMatchObject({ status: "enrolled" });
    await pool.query("UPDATE enrollments SET status='completed' WHERE id=$1", [other.enrollment]);
    const lastOne = await enrollAccepted({ contactId: contact.id, email: contact.email, followUpBody: "unused", steps: 1 });
    await pool.query("UPDATE enrollments SET status='completed' WHERE id=$1", [other.enrollment]);
    await expect(complete(lastOne.claimed)).resolves.toBe(true);
    expect((await pool.query("SELECT status FROM contacts WHERE id=$1", [contact.id])).rows[0]).toMatchObject({ status: "active" });
  });
});
