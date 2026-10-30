import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { lookup } from "node:dns/promises";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
beforeEach(() => { vi.mocked(lookup).mockReset().mockResolvedValue([{ address: "8.8.8.8", family: 4 }] as never); });

import type { MailClient, MailboxProvider } from "@inboxjoy/core";
import { createSmtpMailClient, type MailConnectionConfig } from "@inboxjoy/smtp";
import { claimMessage, sendMessage } from "../src/jobs/send-message.js";

const databaseUrl = process.env.DATABASE_URL;
const password = "smtp-regression-password-never-persist";

type RawSendMail = {
  envelope: { from: string; to: string | string[] };
  raw: string;
};

type MessageRow = {
  status: string;
  email_account_id: string;
  provider_message_id: string | null;
  provider_thread_id: string | null;
  scheduled_at: Date;
  accepted_at: Date | null;
  claim_expires_at: Date | null;
  error_class: string | null;
  error_message: string | null;
  metadata: Record<string, unknown>;
};

type AttemptRow = {
  attempt_number: number;
  status: string;
  provider_message_id: string | null;
  provider_status_code: number | null;
  error_class: string | null;
  error_message: string | null;
  finished_at: Date | null;
};

describe.skipIf(!process.env.DATABASE_URL)("SMTP campaign delivery", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const cleanups: Array<{ userId: string; workspaceId: string; mailboxId: string; close(): void }> = [];
  let fixture: Awaited<ReturnType<typeof createFixture>>;

  async function createFixture() {
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
    const sender = `sender-${ids.mailbox}@example.com`;
    const recipient = `lead-${ids.contact}@example.com`;
    const ownerEmail = `smtp-worker-${ids.user}@example.com`;
    const rfcMessageId = `<${ids.message}@messages.inboxjoy.online>`;
    const unsubscribeUrl = `https://api.example.test/v1/unsubscribe?token=${ids.message}`;
    const smtp: MailConnectionConfig = { host: "smtp.example.com", port: 587, secure: false, username: sender, password };
    const imap: MailConnectionConfig = { ...smtp, host: "imap.example.com", port: 993, secure: true };
    const transport = {
      verify: vi.fn().mockResolvedValue(true),
      sendMail: vi.fn(async (mail: { raw: string | AsyncIterable<Buffer | string> }) => {
        if (typeof mail.raw !== "string") {
          const chunks: Buffer[] = [];
          for await (const chunk of mail.raw) chunks.push(Buffer.from(chunk));
          mail.raw = Buffer.concat(chunks).toString("utf8");
        }
        return { accepted: [recipient], rejected: [], messageId: "transport-generated-id", response: "250 Accepted" };
      }),
      close: vi.fn(),
    };
    const imapClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([{ path: "Sent", name: "Sent", delimiter: "/", specialUse: "\\Sent", flags: new Set(["\\Sent"]), listed: true, subscribed: true }]),
      getMailboxLock: vi.fn().mockResolvedValue({ path: "Sent", release: vi.fn() }),
      mailboxOpen: vi.fn().mockResolvedValue({ path: "Sent", uidValidity: 123n, uidNext: 2, exists: 1 }),
      append: vi.fn().mockResolvedValue({ uidValidity: 123n, uid: 1 }),
      search: vi.fn().mockResolvedValue([]),
      logout: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      on: vi.fn(),
    };
    const transportFactory = vi.fn(() => transport);
    const imapFactory = vi.fn(() => imapClient);
    const smtpClient = createSmtpMailClient({ smtp, imap, transportFactory, imapFactory });
    cleanups.push({ userId: ids.user, workspaceId: ids.workspace, mailboxId: ids.mailbox, close: () => smtpClient.close() });
    const mailClientFor = vi.fn<(mailbox: { provider: MailboxProvider; emailAccountId: string }) => Promise<MailClient>>().mockResolvedValue(smtpClient);
    const deps = { pool, apiBaseUrl: "https://api.example.test", authSecret: "smtp-worker-test-secret", edition: "cloud" as const, mailClientFor };
    const payload = { workspaceId: ids.workspace, enrollmentId: ids.enrollment, sequenceStepId: ids.step, idempotencyKey: `${ids.enrollment}:1` };

    await pool.query("INSERT INTO auth_users (id,name,email,email_verified) VALUES ($1,'SMTP Worker',$2,true)", [ids.user, ownerEmail]);
    await pool.query("INSERT INTO users (id,email,normalized_email) VALUES ($1,$2,$2)", [ids.user, ownerEmail]);
    await pool.query("INSERT INTO workspaces (id,name,slug,created_by_user_id,postal_address) VALUES ($1,'SMTP Worker',$2,$3,'123 Main St')", [ids.workspace, `smtp-worker-${ids.workspace}`, ids.user]);
    await pool.query("INSERT INTO memberships (id,workspace_id,user_id,role,status) VALUES ($1,$2,$3,'owner','active')", [randomUUID(), ids.workspace, ids.user]);
    await pool.query("INSERT INTO subscriptions (id,workspace_id,status) VALUES ($1,$2,'active')", [randomUUID(), ids.workspace]);
    await pool.query(`INSERT INTO email_accounts (id,workspace_id,user_id,provider,composio_connected_account_id,email,normalized_email,alias,status,daily_limit,hourly_limit)
      VALUES ($1,$2,$3,'smtp',$4,$5,$5,'smtp-worker','active',40,10)`, [ids.mailbox, ids.workspace, ids.user, `smtp:${ids.mailbox}`, sender]);
    await pool.query("INSERT INTO contacts (id,workspace_id,email,normalized_email,status) VALUES ($1,$2,$3,$3,'enrolled')", [ids.contact, ids.workspace, recipient]);
    await pool.query("INSERT INTO sequences (id,workspace_id,name,status,created_by_user_id) VALUES ($1,$2,'SMTP Worker','active',$3)", [ids.sequence, ids.workspace, ids.user]);
    await pool.query("INSERT INTO sequence_versions (id,workspace_id,sequence_id,version,status,created_by_user_id) VALUES ($1,$2,$3,1,'active',$4)", [ids.version, ids.workspace, ids.sequence, ids.user]);
    await pool.query("UPDATE sequences SET current_version_id=$2 WHERE id=$1", [ids.sequence, ids.version]);
    await pool.query("INSERT INTO sequence_steps (id,workspace_id,sequence_version_id,step_order,delay_days,subject,body_text) VALUES ($1,$2,$3,1,0,'SMTP campaign','Hello from SMTP')", [ids.step, ids.workspace, ids.version]);
    await pool.query(`INSERT INTO enrollments (id,workspace_id,contact_id,sequence_id,sequence_version_id,email_account_id,status,next_step_order)
      VALUES ($1,$2,$3,$4,$5,$6,'active',1)`, [ids.enrollment, ids.workspace, ids.contact, ids.sequence, ids.version, ids.mailbox]);
    await pool.query(`INSERT INTO messages (id,workspace_id,enrollment_id,sequence_step_id,email_account_id,contact_id,status,idempotency_key,scheduled_at,
      recipient_email,normalized_recipient_email,subject,body_hash,tracking_token,metadata)
      VALUES ($1,$2,$3,$4,$5,$6,'scheduled',$7,now()-interval '1 minute',$8,$8,'SMTP campaign','hash',$9,$10::jsonb)`,
    [ids.message, ids.workspace, ids.enrollment, ids.step, ids.mailbox, ids.contact, payload.idempotencyKey, recipient, randomUUID().replaceAll("-", ""), JSON.stringify({ bodyText: "Hello from SMTP", unsubscribeUrl })]);

    return { ids, sender, recipient, rfcMessageId, unsubscribeUrl, smtp, transport, imapClient, transportFactory, imapFactory, mailClientFor, deps, payload };
  }

  beforeEach(async () => {
    fixture = await createFixture();
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup.close();
      await pool.query("DELETE FROM provider_circuit WHERE provider=$1", [`smtp:${cleanup.mailboxId}`]);
      await pool.query("DELETE FROM workspaces WHERE id=$1", [cleanup.workspaceId]);
      await pool.query("DELETE FROM users WHERE id=$1", [cleanup.userId]);
      await pool.query("DELETE FROM auth_users WHERE id=$1", [cleanup.userId]);
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  async function readMessage(): Promise<MessageRow> {
    const result = await pool.query<MessageRow>(`SELECT status,email_account_id,provider_message_id,provider_thread_id,scheduled_at,accepted_at,claim_expires_at,error_class,error_message,metadata
      FROM messages WHERE id=$1`, [fixture.ids.message]);
    expect(result.rows).toHaveLength(1);
    return result.rows[0]!;
  }

  async function readAttempts(): Promise<AttemptRow[]> {
    const result = await pool.query<AttemptRow>(`SELECT attempt_number,status,provider_message_id,provider_status_code,error_class,error_message,finished_at
      FROM send_attempts WHERE message_id=$1 ORDER BY attempt_number`, [fixture.ids.message]);
    return result.rows;
  }

  async function readEnrollment() {
    const result = await pool.query<{ status: string; stop_reason: string | null; email_account_id: string }>("SELECT status,stop_reason,email_account_id FROM enrollments WHERE id=$1", [fixture.ids.enrollment]);
    expect(result.rows).toHaveLength(1);
    return result.rows[0]!;
  }

  async function claimAgain() {
    const client = await pool.connect();
    try {
      return await claimMessage(client, fixture.payload, { edition: "cloud" });
    } finally {
      client.release();
    }
  }

  async function makeDue() {
    await pool.query("UPDATE messages SET scheduled_at=now()-interval '1 minute' WHERE id=$1", [fixture.ids.message]);
  }

  async function expectRedactedFailure() {
    const message = await readMessage();
    const attempts = await readAttempts();
    expect(message.error_message).toEqual(expect.any(String));
    expect(message.error_message).not.toContain(password);
    expect(JSON.stringify(message)).not.toContain(password);
    expect(attempts.length).toBeGreaterThan(0);
    for (const attempt of attempts) {
      expect(attempt.error_message).toEqual(expect.any(String));
      expect(attempt.error_message).not.toContain(password);
      expect(JSON.stringify(attempt)).not.toContain(password);
    }
  }

  function rejectSmtp(options: { code: string; command: string; responseCode?: number }) {
    fixture.transport.sendMail.mockRejectedValue(Object.assign(new Error(`SMTP failure with password=${password}`), {
      ...options,
      response: `${options.responseCode ?? "timeout"} ${password}`,
    }));
  }

  it("sends campaign MIME without Composio and persists the pinned RFC Message-ID", async () => {
    await sendMessage(fixture.payload, fixture.deps);

    expect(fixture.mailClientFor).toHaveBeenCalledWith({ provider: "smtp", emailAccountId: fixture.ids.mailbox });
    expect(fixture.transport.sendMail).toHaveBeenCalledOnce();
    const sentMail = fixture.transport.sendMail.mock.calls[0]![0] as RawSendMail;
    expect(sentMail.envelope.from).toBe(fixture.sender);
    expect([sentMail.envelope.to].flat()).toEqual([fixture.recipient]);
    expect(sentMail.raw).toContain(`Message-ID: ${fixture.rfcMessageId}\r\n`);
    expect(sentMail.raw).toContain(`List-Unsubscribe: <${fixture.unsubscribeUrl}>\r\n`);
    expect(sentMail.raw).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n");
    expect(sentMail.raw).toContain("multipart/alternative");
    const plainPart = sentMail.raw.match(/Content-Type: text\/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n--/);
    expect(plainPart).not.toBeNull();
    expect(Buffer.from(plainPart![1]!, "base64").toString("utf8")).toContain("Hello from SMTP");
    expect(sentMail.raw).not.toContain(password);
    const message = await readMessage();
    expect(message).toMatchObject({ status: "accepted", email_account_id: fixture.ids.mailbox, provider_message_id: fixture.rfcMessageId, provider_thread_id: fixture.rfcMessageId, claim_expires_at: null, error_class: null, error_message: null });
    expect(message.accepted_at).toBeInstanceOf(Date);
    expect(message.metadata.providerRfcMessageId).toBe(fixture.rfcMessageId);
    expect(message.metadata.providerAttemptedAt).toEqual(expect.any(String));
    expect(message.metadata.acceptanceBookkeepingPending).toBeUndefined();
    expect(await readAttempts()).toEqual([expect.objectContaining({ attempt_number: 1, status: "accepted", provider_message_id: fixture.rfcMessageId, error_class: null, finished_at: expect.any(Date) })]);
  });

  it("does not submit twice while sending or when an accepted job is reclaimed", async () => {
    fixture.transport.sendMail.mockImplementationOnce(async () => {
      expect((await readMessage()).status).toBe("sending");
      await sendMessage(fixture.payload, fixture.deps);
      return { accepted: [fixture.recipient], rejected: [], response: "250 Accepted" };
    });

    await sendMessage(fixture.payload, fixture.deps);
    await makeDue();
    expect(await claimAgain()).toEqual({});
    await sendMessage(fixture.payload, fixture.deps);
    await sendMessage(fixture.payload, fixture.deps);

    expect(fixture.transport.sendMail).toHaveBeenCalledOnce();
    expect(await readMessage()).toMatchObject({ status: "accepted", provider_message_id: fixture.rfcMessageId });
    expect(await readAttempts()).toHaveLength(1);
    const usage = await pool.query<{ accepted_count: number }>("SELECT accepted_count FROM mailbox_daily_usage WHERE email_account_id=$1", [fixture.ids.mailbox]);
    expect(usage.rows).toEqual([{ accepted_count: 1 }]);
  });

  it("marks EAUTH unhealthy, pauses enrollment, and notifies once without a retry storm", async () => {
    rejectSmtp({ code: "EAUTH", command: "AUTH PLAIN", responseCode: 535 });
    await sendMessage(fixture.payload, fixture.deps);

    expect(await readMessage()).toMatchObject({ status: "retryable", error_class: "mailbox_authentication" });
    expect(await readEnrollment()).toMatchObject({ status: "paused", stop_reason: "mailbox_auth_expired", email_account_id: fixture.ids.mailbox });
    const health = await pool.query<{ state: string }>("SELECT state FROM mailbox_health WHERE email_account_id=$1", [fixture.ids.mailbox]);
    expect(health.rows).toEqual([{ state: "auth_error" }]);
    const mailbox = await pool.query<{ status: string }>("SELECT status FROM email_accounts WHERE id=$1", [fixture.ids.mailbox]);
    expect(mailbox.rows).toEqual([{ status: "expired" }]);
    for (let retry = 0; retry < 3; retry += 1) {
      await makeDue();
      await sendMessage(fixture.payload, fixture.deps);
    }
    expect(fixture.transport.sendMail).toHaveBeenCalledOnce();
    expect(await readAttempts()).toEqual([expect.objectContaining({ attempt_number: 1, status: "retryable", provider_status_code: 535, error_class: "mailbox_authentication" })]);
    expect(await readEnrollment()).toMatchObject({ status: "paused", stop_reason: "mailbox_auth_expired" });
    const notifications = await pool.query<{ type: string }>("SELECT type FROM notifications WHERE workspace_id=$1", [fixture.ids.workspace]);
    expect(notifications.rows).toEqual([{ type: "mailbox_reconnect_required" }]);
    await expectRedactedFailure();
  });

  it("retries a mail-stage 451 at attempt four and stops at the five-attempt cap", async () => {
    for (let attemptNumber = 1; attemptNumber <= 3; attemptNumber += 1) {
      await pool.query(`INSERT INTO send_attempts (id,workspace_id,message_id,attempt_number,status,error_class,error_message,finished_at)
        VALUES ($1,$2,$3,$4,'retryable','provider_retryable','Prior temporary rejection',now()-interval '1 hour')`, [randomUUID(), fixture.ids.workspace, fixture.ids.message, attemptNumber]);
    }
    rejectSmtp({ code: "EENVELOPE", command: "MAIL FROM", responseCode: 451 });
    await sendMessage(fixture.payload, fixture.deps);
    expect(await readMessage()).toMatchObject({ status: "retryable", error_class: "provider_retryable", claim_expires_at: null });
    expect(await readEnrollment()).toMatchObject({ status: "active", stop_reason: null });
    expect((await readAttempts())[3]).toMatchObject({ attempt_number: 4, status: "retryable", provider_status_code: 451, error_class: "provider_retryable" });
    expect((await readMessage()).scheduled_at.getTime()).toBeGreaterThan(Date.now());
    await sendMessage(fixture.payload, fixture.deps);
    expect(fixture.transport.sendMail).toHaveBeenCalledOnce();

    await makeDue();
    await sendMessage(fixture.payload, fixture.deps);
    expect(await readMessage()).toMatchObject({ status: "failed", error_class: "provider_permanent" });
    expect(await readEnrollment()).toMatchObject({ status: "cancelled", stop_reason: "provider_permanent_failure" });
    expect((await readAttempts())[4]).toMatchObject({ attempt_number: 5, status: "failed", provider_status_code: 451, error_class: "provider_permanent" });
    await sendMessage(fixture.payload, fixture.deps);
    expect(fixture.transport.sendMail).toHaveBeenCalledTimes(2);
    expect(await readAttempts()).toHaveLength(5);
    await expectRedactedFailure();
  });

  it("treats a non-auth mail-stage 550 as permanent without retrying", async () => {
    rejectSmtp({ code: "EENVELOPE", command: "RCPT TO", responseCode: 550 });
    await sendMessage(fixture.payload, fixture.deps);

    expect(await readMessage()).toMatchObject({ status: "failed", error_class: "provider_permanent", accepted_at: null });
    expect(await readEnrollment()).toMatchObject({ status: "cancelled", stop_reason: "provider_permanent_failure" });
    expect(await readAttempts()).toEqual([expect.objectContaining({ attempt_number: 1, status: "failed", provider_status_code: 550, error_class: "provider_permanent" })]);
    await makeDue();
    expect(await claimAgain()).toEqual({});
    await sendMessage(fixture.payload, fixture.deps);
    expect(fixture.transport.sendMail).toHaveBeenCalledOnce();
    await expectRedactedFailure();
  });

  it.each(["ETIMEDOUT", "ESOCKET"])("pauses an ambiguous DATA %s and never resends on a job retry", async (code) => {
    rejectSmtp({ code, command: "DATA" });
    await sendMessage(fixture.payload, fixture.deps);

    const message = await readMessage();
    expect(message).toMatchObject({ status: "failed", error_class: "unknown_provider_result", accepted_at: null, provider_message_id: null, claim_expires_at: null });
    expect(message.metadata.providerRfcMessageId).toBe(fixture.rfcMessageId);
    expect(message.metadata.providerAttemptedAt).toEqual(expect.any(String));
    expect(await readEnrollment()).toMatchObject({ status: "paused", stop_reason: "provider_result_unknown" });
    expect(await readAttempts()).toEqual([expect.objectContaining({ attempt_number: 1, status: "failed", error_class: "unknown_provider_result" })]);
    await makeDue();
    expect(await claimAgain()).toEqual({});
    await sendMessage(fixture.payload, fixture.deps);
    await sendMessage(fixture.payload, fixture.deps);
    expect(fixture.transport.sendMail).toHaveBeenCalledOnce();
    expect(await readAttempts()).toHaveLength(1);
    expect(await readEnrollment()).toMatchObject({ status: "paused", stop_reason: "provider_result_unknown" });
    expect(fixture.imapClient.append).not.toHaveBeenCalled();
    await expectRedactedFailure();
  });

  it("retries a connect-stage timeout without treating it as an ambiguous submission", async () => {
    rejectSmtp({ code: "ETIMEDOUT", command: "CONN" });
    await sendMessage(fixture.payload, fixture.deps);

    expect(await readMessage()).toMatchObject({ status: "retryable", error_class: "provider_retryable" });
    expect(await readEnrollment()).toMatchObject({ status: "active", stop_reason: null });
    expect(await readAttempts()).toEqual([expect.objectContaining({ attempt_number: 1, status: "retryable", error_class: "provider_retryable" })]);
    await expectRedactedFailure();
  });

  it("records failures under smtp:<mailbox id> without affecting another SMTP mailbox", async () => {
    const other = await createFixture();
    const sharedCircuitBefore = await pool.query("SELECT provider,state,failure_count FROM provider_circuit WHERE provider='smtp'");
    rejectSmtp({ code: "EENVELOPE", command: "MAIL FROM", responseCode: 451 });
    await sendMessage(fixture.payload, fixture.deps);
    await sendMessage(other.payload, other.deps);

    const circuits = await pool.query<{ provider: string; state: string; failure_count: number }>("SELECT provider,state,failure_count FROM provider_circuit WHERE provider IN ($1,$2)", [`smtp:${fixture.ids.mailbox}`, `smtp:${other.ids.mailbox}`]);
    expect(circuits.rows).toHaveLength(2);
    expect(circuits.rows).toEqual(expect.arrayContaining([
      { provider: `smtp:${fixture.ids.mailbox}`, state: "closed", failure_count: 1 },
      { provider: `smtp:${other.ids.mailbox}`, state: "closed", failure_count: 0 },
    ]));
    expect(other.transport.sendMail).toHaveBeenCalledOnce();
    const sharedCircuitAfter = await pool.query("SELECT provider,state,failure_count FROM provider_circuit WHERE provider='smtp'");
    expect(sharedCircuitAfter.rows).toEqual(sharedCircuitBefore.rows);
    await expectRedactedFailure();
  });
});
