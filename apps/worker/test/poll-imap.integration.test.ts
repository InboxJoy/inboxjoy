import { ingestInboundEvent, writeMailboxCredentials } from "@inboxjoy/core";
import { createDb, createPgPool } from "@inboxjoy/db";
import { parseImapMessage, type InboxImapClient } from "@inboxjoy/smtp";
import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
beforeEach(() => { vi.mocked(lookup).mockReset().mockResolvedValue([{ address: "8.8.8.8", family: 4 }] as never); });
import { IMAP_POLL_AUTH_ERROR, IMAP_POLL_FAILING_ERROR, pollImap } from "../src/jobs/poll-imap.js";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("IMAP reply and bounce ingestion", () => {
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);
  const key = Buffer.alloc(32, 5);
  const keys = new Map([[1, key]]);
  let fixture: Awaited<ReturnType<typeof seed>>;

  async function seed(sharedContactEmail?: string) {
    const userId = randomUUID();
    const workspaceId = randomUUID();
    const mailboxId = randomUUID();
    const contactId = randomUUID();
    const sequenceId = randomUUID();
    const versionId = randomUUID();
    const firstStepId = randomUUID();
    const followupStepId = randomUUID();
    const enrollmentId = randomUUID();
    const sentMessageId = randomUUID();
    const followupId = randomUUID();
    const mailboxEmail = `sender-${mailboxId}@example.com`;
    const contactEmail = sharedContactEmail ?? `lead-${contactId}@example.com`;
    const ownerEmail = `owner-${userId}@example.com`;
    const acceptedAt = new Date(Date.now() - 60_000);
    await pool.query("INSERT INTO users (id,email,normalized_email,display_name) VALUES ($1,$2,$2,'IMAP owner')", [userId, ownerEmail]);
    await pool.query("INSERT INTO workspaces (id,name,slug,created_by_user_id) VALUES ($1,'IMAP integration',$2,$3)", [workspaceId, `imap-${workspaceId}`, userId]);
    await pool.query("INSERT INTO email_accounts (id,workspace_id,user_id,provider,composio_connected_account_id,email,normalized_email,alias,status) VALUES ($1,$2,$3,'smtp',$4,$5,$5,'imap','active')", [mailboxId, workspaceId, userId, `smtp:${mailboxId}`, mailboxEmail]);
    await writeMailboxCredentials(db, mailboxId, {
      workspaceId,
      smtp: { host: "smtp.example.com", port: 465, secure: true, username: mailboxEmail, password: "smtp-secret" },
      imap: { host: "imap.example.com", port: 993, secure: true, username: mailboxEmail, password: "imap-secret" },
      lastImapUid: 100n, lastImapUidvalidity: 1n,
    }, { key, keyVersion: 1 });
    await pool.query("INSERT INTO contacts (id,workspace_id,email,normalized_email,status) VALUES ($1,$2,$3,$3,'enrolled')", [contactId, workspaceId, contactEmail]);
    await pool.query("INSERT INTO sequences (id,workspace_id,name,status) VALUES ($1,$2,'IMAP sequence','active')", [sequenceId, workspaceId]);
    await pool.query("INSERT INTO sequence_versions (id,workspace_id,sequence_id,version,status) VALUES ($1,$2,$3,1,'active')", [versionId, workspaceId, sequenceId]);
    await pool.query("UPDATE sequences SET current_version_id=$2 WHERE id=$1", [sequenceId, versionId]);
    await pool.query("INSERT INTO sequence_steps (id,workspace_id,sequence_version_id,step_order,subject,body_text) VALUES ($1,$2,$3,1,'Intro','Hello'),($4,$2,$3,2,'Follow-up','Following up')", [firstStepId, workspaceId, versionId, followupStepId]);
    await pool.query("INSERT INTO enrollments (id,workspace_id,contact_id,sequence_id,sequence_version_id,email_account_id,status) VALUES ($1,$2,$3,$4,$5,$6,'active')", [enrollmentId, workspaceId, contactId, sequenceId, versionId, mailboxId]);
    await pool.query("INSERT INTO messages (id,workspace_id,enrollment_id,sequence_step_id,email_account_id,contact_id,status,idempotency_key,scheduled_at,accepted_at,recipient_email,normalized_recipient_email,subject,body_hash,internet_message_id) VALUES ($1,$2,$3,$4,$5,$6,'accepted',$7,$8,$8,$9,$9,'Intro','imap-original',$10)", [sentMessageId, workspaceId, enrollmentId, firstStepId, mailboxId, contactId, `${enrollmentId}:1`, acceptedAt, contactEmail, `<sent-${sentMessageId}@example.com>`]);
    await pool.query("INSERT INTO messages (id,workspace_id,enrollment_id,sequence_step_id,email_account_id,contact_id,status,idempotency_key,scheduled_at,recipient_email,normalized_recipient_email,subject,body_hash) VALUES ($1,$2,$3,$4,$5,$6,'scheduled',$7,$8,$9,$9,'Follow-up','imap-followup')", [followupId, workspaceId, enrollmentId, followupStepId, mailboxId, contactId, `${enrollmentId}:2`, new Date(Date.now() + 60_000), contactEmail]);
    return { userId, workspaceId, mailboxId, mailboxEmail, contactId, contactEmail, enrollmentId, sentMessageId, followupId };
  }

  beforeEach(async () => { fixture = await seed(); });
  afterEach(async () => {
    await pool.query("DELETE FROM workspaces WHERE id=$1", [fixture.workspaceId]);
    await pool.query("DELETE FROM users WHERE id=$1", [fixture.userId]);
  });
  afterAll(async () => { await pool.end(); });

  function replySource(uid = 101, auto = false, text = "Yes, let's talk next week."): Buffer {
    return Buffer.from([
      `From: Lead <${fixture.contactEmail}>`, `To: ${fixture.mailboxEmail}`, "Subject: Re: Intro",
      `Message-ID: <reply-${fixture.mailboxId}-${uid}@example.com>`, `References: <sent-${fixture.sentMessageId}@example.com>`,
      `Date: ${new Date().toUTCString()}`, ...(auto ? ["Auto-Submitted: auto-replied"] : []),
      "Content-Type: text/plain; charset=utf-8", "", auto ? "Thanks, I'll respond when I return." : text,
    ].join("\r\n"));
  }

  function dsnSource(status: string): Buffer {
    return Buffer.from([
      "From: postmaster@example.com", `To: ${fixture.mailboxEmail}`, "Subject: Delivery failure",
      `Message-ID: <dsn-${fixture.mailboxId}@example.com>`, `Date: ${new Date().toUTCString()}`,
      "Content-Type: multipart/report; report-type=delivery-status; boundary=dsn", "", "--dsn", "Content-Type: text/plain", "",
      "Delivery failed. The quoted original contains 550 and unsubscribe.", "--dsn", "Content-Type: message/delivery-status", "",
      "Reporting-MTA: dns; example.com", `Original-Message-ID: <sent-${fixture.sentMessageId}@example.com>`, "",
      `Final-Recipient: rfc822; ${fixture.contactEmail}`, "Action: failed", `Status: ${status}`, "--dsn--", "",
    ].join("\r\n"));
  }

  function setup(messages = new Map([[101, replySource()]])) {
    const imap: InboxImapClient = {
      connect: vi.fn().mockResolvedValue(undefined), mailboxOpen: vi.fn().mockResolvedValue({ uidValidity: 1n, uidNext: Math.max(...messages.keys()) + 1 }),
      search: vi.fn().mockResolvedValue([...messages.keys()].reverse()),
      fetchOne: vi.fn(async (uid) => ({ uid: Number(uid), source: messages.get(Number(uid)) })),
      logout: vi.fn().mockResolvedValue(undefined), close: vi.fn(), on: vi.fn(),
    };
    const imapFactory = vi.fn().mockReturnValue(imap);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const deps = { pool, smtpMailboxesEnabled: true, keys, imapFactory, logger };
    return { imap, imapFactory, logger, deps };
  }

  async function state() {
    const enrollment = (await pool.query<{ status: string; stopReason: string | null }>("SELECT status,stop_reason AS \"stopReason\" FROM enrollments WHERE id=$1", [fixture.enrollmentId])).rows[0];
    const followup = (await pool.query<{ status: string }>("SELECT status FROM messages WHERE id=$1", [fixture.followupId])).rows[0];
    const cursor = (await pool.query<{ last_imap_uid: string; last_imap_uidvalidity: string; last_polled_at: Date | null }>("SELECT last_imap_uid,last_imap_uidvalidity,last_polled_at FROM mailbox_credentials WHERE email_account_id=$1", [fixture.mailboxId])).rows[0];
    const credentials = cursor ? { lastImapUid: BigInt(cursor.last_imap_uid), lastImapUidvalidity: BigInt(cursor.last_imap_uidvalidity), lastPolledAt: cursor.last_polled_at } : undefined;
    const replies = (await pool.query("SELECT email_account_id AS \"emailAccountId\",contact_id AS \"contactId\",in_reply_to_message_id AS \"inReplyToMessageId\",intent,is_auto_reply AS \"isAutoReply\" FROM replies WHERE workspace_id=$1", [fixture.workspaceId])).rows;
    const suppressions = (await pool.query("SELECT normalized_email AS \"normalizedEmail\",reason FROM suppressions WHERE workspace_id=$1", [fixture.workspaceId])).rows;
    const notifications = (await pool.query<{ type: string }>("SELECT type FROM notifications WHERE workspace_id=$1", [fixture.workspaceId])).rows;
    const events = (await pool.query("SELECT id FROM provider_webhook_events WHERE workspace_id=$1 AND provider='imap'", [fixture.workspaceId])).rows;
    return { enrollment, followup, credentials, replies, suppressions, notifications, events };
  }

  it("captures one human reply, stops the enrollment, cancels follow-ups and notifies once", async () => {
    const { deps, imapFactory } = setup();
    await pollImap({}, deps);
    const result = await state();
    expect(result.replies).toHaveLength(1);
    expect(result.replies[0]).toMatchObject({ emailAccountId: fixture.mailboxId, contactId: fixture.contactId, inReplyToMessageId: fixture.sentMessageId, intent: "human", isAutoReply: false });
    expect(result.enrollment).toMatchObject({ status: "replied", stopReason: "reply_detected" });
    expect(result.followup?.status).toBe("cancelled");
    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0]?.type).toBe("reply");
    expect(result.credentials).toMatchObject({ lastImapUid: 101n, lastImapUidvalidity: 1n, lastPolledAt: expect.any(Date) });
    expect(imapFactory).toHaveBeenCalledWith(expect.objectContaining({ auth: { user: fixture.mailboxEmail, pass: "imap-secret" } }));
  });

  it("deduplicates both an unchanged UID cursor and forced event redelivery", async () => {
    const { deps, imap } = setup();
    await pollImap({}, deps);
    await pollImap({}, deps);
    expect(imap.fetchOne).toHaveBeenCalledOnce();
    const source = replySource();
    const { data, bounce } = await parseImapMessage(source);
    const eventId = createHash("sha256").update(`${fixture.mailboxId}|1|101`).digest("hex");
    expect(await ingestInboundEvent(db, {
      provider: "imap", eventId, accountId: fixture.mailboxId,
      payloadHash: createHash("sha256").update(source).digest("hex"), payload: { data, bounce }, data, bounce,
      eventType: "imap_message_received", triggerSlug: "IMAP_NEW_MESSAGE",
    })).toEqual({ received: true, duplicate: true });
    const result = await state();
    expect(result.replies).toHaveLength(1);
    expect(result.events).toHaveLength(1);
    expect(result.notifications).toHaveLength(1);
  });

  it("records an Auto-Submitted reply without stopping or canceling enrollment", async () => {
    const { deps } = setup(new Map([[101, replySource(101, true)]]));
    await pollImap({}, deps);
    const result = await state();
    expect(result.replies).toHaveLength(1);
    expect(result.replies[0]).toMatchObject({ isAutoReply: true, intent: "auto_reply" });
    expect(result.enrollment?.status).toBe("active");
    expect(result.followup?.status).toBe("scheduled");
    expect(result.notifications).toHaveLength(0);
  });

  async function optOutState(target = fixture) {
    const contact = (await pool.query<{ status: string; unsubscribedAt: Date | null }>("SELECT status,unsubscribed_at AS \"unsubscribedAt\" FROM contacts WHERE id=$1", [target.contactId])).rows[0];
    const enrollment = (await pool.query<{ status: string; stopReason: string | null }>("SELECT status,stop_reason AS \"stopReason\" FROM enrollments WHERE id=$1", [target.enrollmentId])).rows[0];
    const followup = (await pool.query<{ status: string; errorClass: string | null }>("SELECT status,error_class AS \"errorClass\" FROM messages WHERE id=$1", [target.followupId])).rows[0];
    const suppressions = (await pool.query("SELECT normalized_email AS \"normalizedEmail\",reason,source FROM suppressions WHERE workspace_id=$1", [target.workspaceId])).rows;
    const messageEvents = (await pool.query<{ eventType: string }>("SELECT event_type AS \"eventType\" FROM message_events WHERE workspace_id=$1", [target.workspaceId])).rows;
    return { contact, enrollment, followup, suppressions, messageEvents };
  }

  it("suppresses an opt-out reply, stops the enrollment and cancels follow-ups, in that workspace only", async () => {
    // A second workspace mailing the same address. Its mailbox has no stored
    // credentials, so the poller never opens it: anything that changes there
    // could only have leaked across the tenant boundary.
    const other = await seed(fixture.contactEmail);
    try {
      await pool.query("DELETE FROM mailbox_credentials WHERE email_account_id=$1", [other.mailboxId]);
      const { deps } = setup(new Map([[101, replySource(101, false, "Please unsubscribe me.")]]));
      await pollImap({}, deps);

      const result = await state();
      const optOut = await optOutState();
      expect(optOut.suppressions).toEqual([{ normalizedEmail: fixture.contactEmail, reason: "unsubscribed", source: "reply_opt_out" }]);
      expect(optOut.contact).toMatchObject({ status: "suppressed", unsubscribedAt: expect.any(Date) });
      expect(optOut.enrollment).toMatchObject({ status: "unsubscribed", stopReason: "unsubscribed" });
      expect(optOut.followup).toMatchObject({ status: "cancelled", errorClass: "recipient_suppressed" });
      expect(optOut.messageEvents).toEqual([{ eventType: "unsubscribed" }]);
      expect(result.replies).toHaveLength(1);
      expect(result.replies[0]).toMatchObject({ contactId: fixture.contactId, intent: "opt_out", isAutoReply: false });
      // The cascade already stopped everything, so no second "reply" stop or notification.
      expect(result.notifications).toHaveLength(0);
      expect(result.credentials).toMatchObject({ lastImapUid: 101n, lastImapUidvalidity: 1n });

      const untouched = await optOutState(other);
      expect(untouched.suppressions).toHaveLength(0);
      expect(untouched.contact).toMatchObject({ status: "enrolled", unsubscribedAt: null });
      expect(untouched.enrollment).toMatchObject({ status: "active", stopReason: null });
      expect(untouched.followup).toMatchObject({ status: "scheduled" });
      expect(untouched.messageEvents).toHaveLength(0);
    } finally {
      await pool.query("DELETE FROM workspaces WHERE id=$1", [other.workspaceId]);
      await pool.query("DELETE FROM users WHERE id=$1", [other.userId]);
    }
  });

  it("still stops the enrollment when suppressing an opt-out reply fails", async () => {
    const source = replySource(101, false, "Please unsubscribe me.");
    const { data, bounce } = await parseImapMessage(source);
    const logger = { error: vi.fn(), info: vi.fn() };
    const applySuppression = vi.fn().mockRejectedValue(new Error("suppression store unavailable"));
    expect(await ingestInboundEvent(db, {
      provider: "imap", eventId: createHash("sha256").update(`${fixture.mailboxId}|1|101`).digest("hex"), accountId: fixture.mailboxId,
      payloadHash: createHash("sha256").update(source).digest("hex"), payload: { data, bounce }, data, bounce,
      eventType: "imap_message_received", triggerSlug: "IMAP_NEW_MESSAGE",
    }, { applySuppression, logger })).toEqual({ received: true, duplicate: false });

    expect(applySuppression).toHaveBeenCalledWith({ workspaceId: fixture.workspaceId, normalizedEmail: fixture.contactEmail, email: fixture.contactEmail, reason: "unsubscribed", source: "reply_opt_out", contactId: fixture.contactId });
    const result = await state();
    const optOut = await optOutState();
    expect(optOut.suppressions).toHaveLength(0);
    expect(optOut.enrollment).toMatchObject({ status: "replied", stopReason: "reply_detected" });
    expect(optOut.followup).toMatchObject({ status: "cancelled", errorClass: "reply_detected" });
    expect(optOut.messageEvents).toEqual([{ eventType: "unsubscribed" }]);
    expect(result.replies).toHaveLength(1);
    expect(result.replies[0]).toMatchObject({ intent: "opt_out" });
    expect(result.notifications.map((notification) => notification.type)).toEqual(["reply"]);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ sender: fixture.contactEmail }), "Failed to suppress reply opt-out");
  });

  it("stores a reply whose subject and body carry NUL characters, and advances the cursor past it", async () => {
    // Postgres rejects U+0000 in text and jsonb. Unsanitized, this one message
    // failed on every poll and held the mailbox cursor behind it forever.
    const source = Buffer.from([
      `From: Lead <${fixture.contactEmail}>`, `To: ${fixture.mailboxEmail}`, "Subject: Re: Intro \0",
      `Message-ID: <reply-${fixture.mailboxId}-101@example.com>`, `Date: ${new Date().toUTCString()}`,
      "Content-Type: text/plain; charset=utf-8", "", "Yes\0, let's talk next week.",
    ].join("\r\n"));
    expect((await parseImapMessage(source)).data).toMatchObject({ subject: expect.stringContaining("\0"), message_text: expect.stringContaining("\0") });
    const { deps, logger } = setup(new Map([[101, source], [102, replySource(102, true)]]));
    await pollImap({}, deps);

    const result = await state();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(result.credentials).toMatchObject({ lastImapUid: 102n });
    // The second message is stored too: nothing queued behind the first is lost.
    expect(result.events).toHaveLength(2);
    // The lead's later out-of-office reaches the Inbox as well, marked automatic.
    expect(result.replies).toHaveLength(2);
    expect(result.replies.filter((reply) => reply.isAutoReply)).toHaveLength(1);
    expect(result.enrollment).toMatchObject({ status: "replied", stopReason: "reply_detected" });
    const stored = (await pool.query<{ subject: string | null; bodyText: string | null }>("SELECT subject,body_text AS \"bodyText\" FROM replies WHERE workspace_id=$1 AND NOT is_auto_reply", [fixture.workspaceId])).rows[0];
    expect(stored?.subject).toBe("Re: Intro");
    expect(stored?.bodyText).toBe("Yes, let's talk next week.");
  });

  it.each(["5.1.1", "5.2.2", "5.7.8"])("suppresses failed DSN %s and stops enrollment", async (status) => {
    const { deps } = setup(new Map([[101, dsnSource(status)]]));
    await pollImap({}, deps);
    const result = await state();
    expect(result.suppressions).toHaveLength(1);
    expect(result.suppressions[0]).toMatchObject({ normalizedEmail: fixture.contactEmail, reason: "bounced" });
    expect(result.enrollment).toMatchObject({ status: "bounced", stopReason: "hard_bounce" });
    expect(result.followup?.status).toBe("cancelled");
    expect(result.replies).toHaveLength(0);
  });

  it("warns for DSN 4.2.2 but never suppresses or stops enrollment", async () => {
    const { deps } = setup(new Map([[101, dsnSource("4.2.2")]]));
    await pollImap({}, deps);
    const result = await state();
    expect(result.suppressions).toHaveLength(0);
    expect(result.enrollment?.status).toBe("active");
    expect(result.followup?.status).toBe("scheduled");
    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0]?.type).toBe("delivery_warning");
    expect(result.replies).toHaveLength(0);
  });

  it("resets changed UIDVALIDITY without any ingestion and logs a warning", async () => {
    const { deps, imap, logger } = setup();
    vi.mocked(imap.mailboxOpen).mockResolvedValue({ uidValidity: 2n, uidNext: 501 });
    await pollImap({}, deps);
    const result = await state();
    expect(result.credentials).toMatchObject({ lastImapUid: 500n, lastImapUidvalidity: 2n, lastPolledAt: expect.any(Date) });
    expect(result.events).toHaveLength(0);
    expect(imap.fetchOne).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("UIDVALIDITY changed"), expect.objectContaining({ emailAccountId: fixture.mailboxId }));
  });

  it("persists only the first two UIDs when the third of five messages fails", async () => {
    const messages = new Map(Array.from({ length: 5 }, (_, index) => [101 + index, replySource(101 + index, true)]));
    const { deps, imap } = setup(messages);
    vi.mocked(imap.fetchOne).mockImplementation(async (uid) => {
      if (uid === "103") throw new Error("third message failed");
      return { uid: Number(uid), source: messages.get(Number(uid)) };
    });
    await pollImap({}, deps);
    const result = await state();
    expect(result.credentials).toMatchObject({ lastImapUid: 102n, lastPolledAt: expect.any(Date) });
    expect(result.events).toHaveLength(2);
    expect(result.replies).toHaveLength(2);
    expect(imap.fetchOne).toHaveBeenCalledTimes(3);
  });

  it("skips a held advisory lock and processes a mailbox only once across concurrent runs", async () => {
    const { deps, imapFactory, imap } = setup();
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`imap-poll:${fixture.mailboxId}`]);
      await Promise.all([pollImap({}, deps), pollImap({}, deps)]);
      expect(imapFactory).not.toHaveBeenCalled();
      expect((await state()).events).toHaveLength(0);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    let releaseConnect!: () => void;
    let signalConnect!: () => void;
    const connecting = new Promise<void>((resolve) => { signalConnect = resolve; });
    vi.mocked(imap.connect).mockImplementation(() => {
      signalConnect();
      return new Promise<void>((resolve) => { releaseConnect = resolve; });
    });
    const first = pollImap({}, deps);
    await connecting;
    try {
      await pollImap({}, deps);
      expect(imapFactory).toHaveBeenCalledOnce();
    } finally {
      releaseConnect();
      await first;
    }
    expect((await state()).replies).toHaveLength(1);
  });

  async function health() {
    return (await pool.query<{ failures: number; backingOff: boolean; retryInSeconds: number | null; stuckUid: string | null; stuckAttempts: number; verifyError: string | null; cursor: string }>(`
      SELECT imap_poll_failures AS failures,COALESCE(imap_poll_retry_at>now(),false) AS "backingOff",
        round(extract(epoch FROM imap_poll_retry_at-now()))::int AS "retryInSeconds",imap_stuck_uid AS "stuckUid",
        imap_stuck_attempts AS "stuckAttempts",last_verify_error AS "verifyError",last_imap_uid AS cursor
      FROM mailbox_credentials WHERE email_account_id=$1`, [fixture.mailboxId])).rows[0]!;
  }
  // Stands in for the clock: the mailbox's backoff has run out.
  const elapseBackoff = () => pool.query("UPDATE mailbox_credentials SET imap_poll_retry_at=now()-interval '1 second' WHERE email_account_id=$1", [fixture.mailboxId]);
  const setHealth = (failures: number, stuckUid: number | null, stuckAttempts: number, verifyError: string | null = null) => pool.query(
    "UPDATE mailbox_credentials SET imap_poll_failures=$2,imap_stuck_uid=$3,imap_stuck_attempts=$4,last_verify_error=$5 WHERE email_account_id=$1",
    [fixture.mailboxId, failures, stuckUid, stuckAttempts, verifyError],
  );
  const reconnectNotifications = async () => (await pool.query<{ title: string; body: string }>("SELECT title,body FROM notifications WHERE workspace_id=$1 AND type='mailbox_reconnect_required'", [fixture.workspaceId])).rows;
  const eventIdFor = (uid: number, uidvalidity = 1) => createHash("sha256").update(`${fixture.mailboxId}|${uidvalidity}|${uid}`).digest("hex");
  const storedEvent = async (uid: number) => (await pool.query<{ status: string; errorClass: string | null; payload: Record<string, unknown>; workspaceId: string | null }>(
    "SELECT status,error_class AS \"errorClass\",payload,workspace_id AS \"workspaceId\" FROM provider_webhook_events WHERE provider='imap' AND event_id=$1", [eventIdFor(uid)],
  )).rows;

  it("counts failed polls, doubles the backoff and leaves the mailbox alone until the retry time", async () => {
    const { deps, imap, imapFactory } = setup();
    vi.mocked(imap.connect).mockRejectedValue(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
    await pollImap({}, deps);
    const first = await health();
    expect(first).toMatchObject({ failures: 1, backingOff: true, cursor: "100", verifyError: null });
    expect(first.retryInSeconds).toBeGreaterThan(110);
    expect(first.retryInSeconds).toBeLessThanOrEqual(120);
    expect((await state()).credentials?.lastPolledAt).toBeInstanceOf(Date);

    await pollImap({}, deps);
    expect(imapFactory).toHaveBeenCalledOnce();
    expect((await health()).failures).toBe(1);

    await elapseBackoff();
    await pollImap({}, deps);
    expect(imapFactory).toHaveBeenCalledTimes(2);
    const second = await health();
    expect(second).toMatchObject({ failures: 2, backingOff: true });
    expect(second.retryInSeconds).toBeGreaterThan(230);
    expect(second.retryInSeconds).toBeLessThanOrEqual(240);
    expect(await reconnectNotifications()).toHaveLength(0);
  });

  it("flags the mailbox and notifies once on the fifth failure, without touching sending", async () => {
    const { deps, imap } = setup();
    vi.mocked(imap.mailboxOpen).mockRejectedValue(Object.assign(new Error("Command failed"), { responseStatus: "NO", responseText: "provider detail" }));
    await setHealth(3, null, 0);
    await pollImap({}, deps);
    expect(await health()).toMatchObject({ failures: 4, verifyError: null });
    expect(await reconnectNotifications()).toHaveLength(0);

    await elapseBackoff();
    await pollImap({}, deps);
    expect(await health()).toMatchObject({ failures: 5, verifyError: IMAP_POLL_FAILING_ERROR });
    expect(await reconnectNotifications()).toEqual([{ title: "Reconnect your sending inbox", body: `Reconnect ${fixture.mailboxEmail} to resume paused campaigns.` }]);

    await elapseBackoff();
    await pollImap({}, deps);
    const sixth = await health();
    expect(sixth.failures).toBe(6);
    expect(sixth.retryInSeconds).toBeGreaterThan(3500);
    expect(await reconnectNotifications()).toHaveLength(1);
    // SMTP may still be fine: the mailbox stays active and its enrollments keep running.
    expect((await pool.query<{ status: string }>("SELECT status FROM email_accounts WHERE id=$1", [fixture.mailboxId])).rows[0]?.status).toBe("active");
    expect((await state()).enrollment?.status).toBe("active");
  });

  it("flags an authentication failure on the first failed poll, with a single notification", async () => {
    const { deps, imap } = setup();
    vi.mocked(imap.connect).mockRejectedValue(Object.assign(new Error("imap-secret rejected"), { authenticationFailed: true }));
    await pollImap({}, deps);
    const first = await health();
    expect(first).toMatchObject({ failures: 1, backingOff: true, verifyError: IMAP_POLL_AUTH_ERROR });
    expect(first.verifyError).not.toContain("imap-secret");
    expect(await reconnectNotifications()).toHaveLength(1);
    await elapseBackoff();
    await pollImap({}, deps);
    expect((await health()).failures).toBe(2);
    expect(await reconnectNotifications()).toHaveLength(1);
    expect((await pool.query<{ status: string }>("SELECT status FROM email_accounts WHERE id=$1", [fixture.mailboxId])).rows[0]?.status).toBe("active");
  });

  it("resets poll failures on success and clears only the verify error it set itself", async () => {
    const { deps } = setup();
    await setHealth(6, null, 0, IMAP_POLL_FAILING_ERROR);
    await elapseBackoff();
    await pollImap({}, deps);
    expect(await health()).toMatchObject({ failures: 0, backingOff: false, retryInSeconds: null, verifyError: null, cursor: "101" });

    const verifyFlowError = "IMAP authentication failed. Check the username and password.";
    await setHealth(2, null, 0, verifyFlowError);
    await pollImap({}, deps);
    expect(await health()).toMatchObject({ failures: 0, verifyError: verifyFlowError });
  });

  it("does not count a poll skipped for a held lock as a failure", async () => {
    const { deps, imapFactory } = setup();
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`imap-poll:${fixture.mailboxId}`]);
      await pollImap({}, deps);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    expect(imapFactory).not.toHaveBeenCalled();
    expect(await health()).toMatchObject({ failures: 0, backingOff: false, retryInSeconds: null, stuckUid: null });
    expect((await state()).credentials?.lastPolledAt).toBeNull();
  });

  it("retries a message that cannot be ingested twice, then records it as skipped and ingests the reply behind it", async () => {
    // UID 101 comes back without a source on every fetch: nothing about it can be parsed or stored.
    const { deps, imap, logger } = setup(new Map([[102, replySource(102)]]));
    vi.mocked(imap.search).mockResolvedValue([101, 102]);
    await pollImap({}, deps);
    expect(await health()).toMatchObject({ cursor: "100", stuckUid: "101", stuckAttempts: 1, failures: 0, backingOff: false });
    await pollImap({}, deps);
    expect(await health()).toMatchObject({ cursor: "100", stuckUid: "101", stuckAttempts: 2, failures: 0, backingOff: false });
    expect(await storedEvent(101)).toHaveLength(0);
    expect((await state()).replies).toHaveLength(0);

    await pollImap({}, deps);
    expect(await storedEvent(101)).toEqual([{ status: "failed", errorClass: "Error", workspaceId: fixture.workspaceId, payload: { skipped: true, reason: "Error", uid: 101, uidvalidity: "1" } }]);
    expect(logger.error).toHaveBeenCalledWith("IMAP message skipped after repeated ingestion failures", { emailAccountId: fixture.mailboxId, uid: 101, attempts: 3, errorClass: "Error" });
    // The real reply behind it is no longer held back.
    const result = await state();
    expect(result.replies).toHaveLength(1);
    expect(result.enrollment).toMatchObject({ status: "replied", stopReason: "reply_detected" });
    expect(await health()).toMatchObject({ cursor: "102", stuckUid: null, stuckAttempts: 0, failures: 0, verifyError: null });
    expect(await reconnectNotifications()).toHaveLength(0);

    // Nothing left to fetch, and the skipped event is not written twice.
    await pollImap({}, deps);
    expect(imap.fetchOne).toHaveBeenCalledTimes(4);
    expect(await storedEvent(101)).toHaveLength(1);
  });

  it("marks an event row that ingestion already stored as skipped, keeping what it holds", async () => {
    const { deps, imap } = setup(new Map([[102, replySource(102, true)]]));
    vi.mocked(imap.search).mockResolvedValue([101, 102]);
    await pool.query("INSERT INTO provider_webhook_events (id,workspace_id,provider,event_id,payload_hash,status,error_class,payload) VALUES ($1,$2,'imap',$3,'earlier-hash','failed','Error',$4::jsonb)", [randomUUID(), fixture.workspaceId, eventIdFor(101), JSON.stringify({ data: { subject: "Re: Intro" } })]);
    await setHealth(0, 101, 2);
    await pollImap({}, deps);
    expect(await storedEvent(101)).toEqual([{ status: "failed", errorClass: "Error", workspaceId: fixture.workspaceId, payload: { data: { subject: "Re: Intro" }, skipped: true, reason: "Error", uid: 101, uidvalidity: "1" } }]);
    expect(await health()).toMatchObject({ cursor: "102", stuckUid: null, stuckAttempts: 0 });
  });

  it("never skips a message, or counts against it, when the database fails transiently", async () => {
    const { deps, imap } = setup();
    await setHealth(0, 101, 2);
    let failing = true;
    // drizzle sends ingestion's first write through pool.query; rejecting it there
    // gives the poller the same wrapped driver error a real deadlock would.
    const flakyPool = new Proxy(pool, {
      get(target, property) {
        if (property === "query") {
          return (...args: unknown[]) => {
            const text = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string } | undefined)?.text ?? "";
            if (failing && /insert into "provider_webhook_events"/i.test(text)) return Promise.reject(Object.assign(new Error("deadlock detected"), { code: "40P01" }));
            return (target.query as (...queryArgs: unknown[]) => unknown)(...args);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? (value as (...functionArgs: unknown[]) => unknown).bind(target) : value;
      },
    });
    await pollImap({}, { ...deps, pool: flakyPool });
    expect(await health()).toMatchObject({ cursor: "100", stuckUid: "101", stuckAttempts: 2, failures: 1, backingOff: true });
    expect(await storedEvent(101)).toHaveLength(0);
    await elapseBackoff();
    await pollImap({}, { ...deps, pool: flakyPool });
    expect(await health()).toMatchObject({ cursor: "100", stuckUid: "101", stuckAttempts: 2, failures: 2 });
    expect(await storedEvent(101)).toHaveLength(0);

    failing = false;
    await elapseBackoff();
    await pollImap({}, { ...deps, pool: flakyPool });
    expect(imap.fetchOne).toHaveBeenCalledTimes(3);
    expect((await state()).replies).toHaveLength(1);
    expect((await storedEvent(101))[0]).toMatchObject({ status: "processed" });
    expect(await health()).toMatchObject({ cursor: "101", stuckUid: null, stuckAttempts: 0, failures: 0, backingOff: false });
  });

  it("keeps the cursor when an empty fetch comes from a closed connection rather than an expunged message", async () => {
    const { deps, imap } = setup();
    vi.mocked(imap.fetchOne).mockResolvedValue(false);
    // What imapflow does after a server BYE: fetchOne and search both resolve false.
    vi.mocked(imap.search).mockImplementation(async (query) => (String(query.uid).includes(":") ? [101] : false));
    await pollImap({}, deps);
    expect(await health()).toMatchObject({ cursor: "100", failures: 1, backingOff: true, stuckUid: null });

    await elapseBackoff();
    vi.mocked(imap.search).mockImplementation(async (query) => (String(query.uid).includes(":") ? [101] : []));
    await pollImap({}, deps);
    expect(await health()).toMatchObject({ cursor: "101", failures: 0, backingOff: false });
    expect((await state()).events).toHaveLength(0);
  });

  it("forgets a stuck message and failed polls when UIDVALIDITY changes", async () => {
    const { deps, imap } = setup();
    await setHealth(3, 101, 2, IMAP_POLL_FAILING_ERROR);
    vi.mocked(imap.mailboxOpen).mockResolvedValue({ uidValidity: 2n, uidNext: 501 });
    await pollImap({}, deps);
    expect(await health()).toMatchObject({ cursor: "500", stuckUid: null, stuckAttempts: 0, failures: 0, backingOff: false, verifyError: null });
  });

  it("exits without connecting when SMTP_MAILBOXES_ENABLED is off", async () => {
    const { deps, imapFactory } = setup();
    await pollImap({}, { ...deps, smtpMailboxesEnabled: false });
    expect(imapFactory).not.toHaveBeenCalled();
    expect((await state()).credentials?.lastPolledAt).toBeNull();
    expect(await health()).toMatchObject({ failures: 0, backingOff: false });
  });
});
