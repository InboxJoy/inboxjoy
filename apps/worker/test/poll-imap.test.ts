import { applySuppression, ingestInboundEvent, readMailboxCredentials } from "@inboxjoy/core";
import { queueNames, scheduleRecurringJobs, validateJobPayload } from "@inboxjoy/queue";
import type { InboxImapClient } from "@inboxjoy/smtp";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IMAP_POLL_AUTH_ERROR, IMAP_POLL_FAILING_ERROR, isTransientPollError, pollBackoffSeconds, pollImap } from "../src/jobs/poll-imap.js";

vi.mock("@inboxjoy/core", () => ({ applySuppression: vi.fn(), ingestInboundEvent: vi.fn(), readMailboxCredentials: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: vi.fn().mockResolvedValue([{ address: "8.8.8.8", family: 4 }]) }));

const emailAccountId = "00000000-0000-4000-8000-000000000001";
const workspaceId = "00000000-0000-4000-8000-0000000000aa";
const reconnectBody = "Reconnect sender@example.com to resume paused campaigns.";

type MailboxRow = {
  last_imap_uid: string | null; last_imap_uidvalidity: string | null; imap_poll_failures: number; backing_off: boolean; retry_seconds: number | null;
  imap_stuck_uid: string | null; imap_stuck_attempts: number; last_verify_error: string | null; verified_at: string | null;
};

// The connection mock keeps one mailbox_credentials row and applies the poller's
// own UPDATE statements to it, so consecutive polls see what the previous one
// persisted. `backing_off` stands in for "imap_poll_retry_at is still in the
// future"; a test lets the backoff elapse by clearing it.
function setup(initial: Partial<MailboxRow> = {}) {
  const row: MailboxRow = {
    last_imap_uid: "100", last_imap_uidvalidity: "1", imap_poll_failures: 0, backing_off: false, retry_seconds: null,
    imap_stuck_uid: null, imap_stuck_attempts: 0, last_verify_error: null, verified_at: "2026-10-01 00:00:00+00", ...initial,
  };
  const notifications: { type: string; title: string; body: string; read: boolean }[] = [];
  const skippedEvents: { workspaceId: unknown; eventId: unknown; payloadHash: unknown; errorClass: unknown; payload: Record<string, unknown> }[] = [];
  const connection = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("pg_try_advisory_xact_lock")) return { rows: [{ acquired: true }], rowCount: 1 };
      if (sql.includes("FROM email_accounts WHERE id=$1")) return { rows: [{ workspace_id: workspaceId, email: "sender@example.com" }], rowCount: 1 };
      if (sql.includes("SELECT last_imap_uid")) return { rows: [{ ...row }], rowCount: 1 };
      if (sql.includes("last_imap_uid=$2")) {
        row.last_imap_uid = params[1] as string | null;
        row.last_imap_uidvalidity = params[2] as string | null;
      } else if (sql.includes("imap_poll_failures=0")) {
        Object.assign(row, { imap_poll_failures: 0, backing_off: false, retry_seconds: null, imap_stuck_uid: params[1], imap_stuck_attempts: params[2] });
        if (row.last_verify_error !== null && (params[3] as string[]).includes(row.last_verify_error)) row.last_verify_error = null;
      } else if (sql.includes("imap_poll_failures=$2")) {
        if (row.verified_at !== params[7]) return { rows: [], rowCount: 0 };
        Object.assign(row, { imap_poll_failures: params[1], backing_off: true, retry_seconds: params[2], imap_stuck_uid: params[3], imap_stuck_attempts: params[4] });
        if (params[5] !== null && (row.last_verify_error === null || (params[6] as string[]).includes(row.last_verify_error))) row.last_verify_error = params[5] as string;
      } else if (sql.includes("INSERT INTO notifications")) {
        if (!sql.includes("NOT EXISTS") || !sql.includes("read_at IS NULL")) throw new Error("notification insert lost its unread de-duplication");
        if (notifications.some((notification) => notification.body === params[2] && !notification.read)) return { rows: [], rowCount: 0 };
        notifications.push({ type: /'(mailbox_[a-z_]+)'/.exec(sql)?.[1] ?? "", title: /'(Reconnect[^']+)'/.exec(sql)?.[1] ?? "", body: params[2] as string, read: false });
      }
      return { rows: [], rowCount: 1 };
    }),
    release: vi.fn(),
  };
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("INSERT INTO provider_webhook_events")) {
        skippedEvents.push({ workspaceId: params[1], eventId: params[2], payloadHash: params[3], errorClass: params[4], payload: JSON.parse(params[5] as string) as Record<string, unknown> });
        return { rows: [], rowCount: 1 };
      }
      // The sweep's own WHERE clause keeps a backing-off mailbox out.
      return row.backing_off ? { rows: [], rowCount: 0 } : { rows: [{ email_account_id: emailAccountId }], rowCount: 1 };
    }),
    connect: vi.fn().mockResolvedValue(connection),
  };
  const imap: InboxImapClient = {
    connect: vi.fn().mockResolvedValue(undefined), mailboxOpen: vi.fn().mockResolvedValue({ uidValidity: 1n, uidNext: 106 }),
    search: vi.fn().mockResolvedValue([105, 103, 101, 102, 104, 100]),
    fetchOne: vi.fn(async (uid) => ({ uid: Number(uid), source: Buffer.from(["From: lead@example.com", "To: sender@example.com", `Message-ID: <reply-${uid}@example.com>`, "", "Let's talk."].join("\r\n")) })),
    logout: vi.fn().mockResolvedValue(undefined), close: vi.fn(), on: vi.fn(),
  };
  const imapFactory = vi.fn().mockReturnValue(imap);
  const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  const deps = { pool: pool as never, smtpMailboxesEnabled: true, keys: new Map([[1, Buffer.alloc(32, 1)]]), imapFactory, logger };
  // Reset, not just cleared: a rejection one test leaves on these shared mocks must not reach the next.
  vi.mocked(applySuppression).mockReset();
  vi.mocked(readMailboxCredentials).mockReset().mockResolvedValue({ emailAccountId, lastImapUid: 100n, lastImapUidvalidity: 1n,
    imap: { host: "imap.example.com", port: 993, secure: true, username: "sender@example.com", password: "secret" },
  } as never);
  vi.mocked(ingestInboundEvent).mockReset().mockResolvedValue({ received: true, duplicate: false });
  const elapseBackoff = () => { row.backing_off = false; };
  return { pool, connection, imap, imapFactory, logger, deps, row, notifications, skippedEvents, elapseBackoff };
}

const eventIdFor = (uid: number) => createHash("sha256").update(`${emailAccountId}|1|${uid}`).digest("hex");
const ingestedUids = () => vi.mocked(ingestInboundEvent).mock.calls.map(([, event]) => [101, 102, 103, 104, 105].find((uid) => eventIdFor(uid) === event.eventId));

beforeEach(() => vi.clearAllMocks());

describe("IMAP polling without a database", () => {
  it("schedules a validated empty-payload sweep every two minutes", async () => {
    const schedule = vi.fn();
    await scheduleRecurringJobs({ schedule } as never);
    expect(queueNames.pollImap).toBe("inbox.poll-imap");
    expect(validateJobPayload(queueNames.pollImap, {})).toEqual({});
    expect(schedule).toHaveBeenCalledWith(queueNames.pollImap, "*/2 * * * *", {});
  });

  it("exits without querying or connecting when the flag is off", async () => {
    const { deps, pool, imapFactory, row } = setup({ imap_poll_failures: 2 });
    await pollImap({}, { ...deps, smtpMailboxesEnabled: false });
    expect(pool.query).not.toHaveBeenCalled();
    expect(imapFactory).not.toHaveBeenCalled();
    expect(row.imap_poll_failures).toBe(2);
  });

  it("ingests ascending UIDs and persists the last successful UID after a mid-batch failure", async () => {
    const { deps, connection, imap, logger, row } = setup();
    vi.mocked(imap.fetchOne).mockRejectedValueOnce(new Error("first failure"));
    await pollImap({}, deps);
    expect(connection.query).toHaveBeenCalledWith(expect.stringContaining("UPDATE mailbox_credentials"), [emailAccountId, "100", "1"]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("IMAP message could not be ingested"), expect.objectContaining({ emailAccountId, uid: 101, attempts: 1 }));
    vi.mocked(ingestInboundEvent).mockResolvedValueOnce({ received: true, duplicate: false }).mockResolvedValueOnce({ received: true, duplicate: false }).mockRejectedValueOnce(new Error("message three"));
    await pollImap({}, deps);
    expect(imap.fetchOne).toHaveBeenLastCalledWith("103", { source: true, internalDate: true }, { uid: true });
    expect(connection.query).toHaveBeenCalledWith(expect.stringContaining("UPDATE mailbox_credentials"), [emailAccountId, "102", "1"]);
    expect(connection.query).toHaveBeenCalledWith("COMMIT");
    expect(connection.release).toHaveBeenCalledTimes(2);
    // A different message failing starts its own count, and neither failure backs the mailbox off.
    expect(row).toMatchObject({ imap_stuck_uid: "103", imap_stuck_attempts: 1, imap_poll_failures: 0, backing_off: false });
  });

  it("hands every ingested message the shared suppression path so reply opt-outs are honoured", async () => {
    const { deps } = setup();
    vi.mocked(applySuppression).mockResolvedValue({ id: "suppression" } as never);
    await pollImap({}, deps);
    expect(ingestInboundEvent).toHaveBeenCalledTimes(5);
    const [db, event, options] = vi.mocked(ingestInboundEvent).mock.calls[0]!;
    expect(event).toMatchObject({ provider: "imap", accountId: emailAccountId, triggerSlug: "IMAP_NEW_MESSAGE" });
    expect(options?.applySuppression).toBeTypeOf("function");
    const input = { workspaceId: "workspace", normalizedEmail: "lead@example.com", email: "lead@example.com", reason: "unsubscribed", source: "reply_opt_out", contactId: "contact" };
    await expect(options!.applySuppression!(input)).resolves.toEqual({ id: "suppression" });
    // Same database handle the event itself is written through.
    expect(applySuppression).toHaveBeenCalledWith(db, input);
  });

  it("resets UIDVALIDITY to UIDNEXT minus one without fetching or ingesting, and forgets a stuck UID", async () => {
    const { deps, connection, imap, logger, row } = setup({ imap_stuck_uid: "101", imap_stuck_attempts: 2, imap_poll_failures: 3 });
    vi.mocked(imap.mailboxOpen).mockResolvedValue({ uidValidity: 2n, uidNext: 500 });
    await pollImap({}, deps);
    expect(imap.search).not.toHaveBeenCalled();
    expect(ingestInboundEvent).not.toHaveBeenCalled();
    expect(connection.query).toHaveBeenCalledWith(expect.stringContaining("UPDATE mailbox_credentials"), [emailAccountId, "499", "2"]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("UIDVALIDITY changed"), expect.any(Object));
    expect(row).toMatchObject({ imap_stuck_uid: null, imap_stuck_attempts: 0, imap_poll_failures: 0 });
  });

  it("skips locked mailboxes without connecting or overwriting their polling state", async () => {
    const { deps, connection, imapFactory } = setup();
    connection.query.mockImplementation(async (sql) => ({ rows: sql.includes("pg_try_advisory_xact_lock") ? [{ acquired: false }] : [], rowCount: 1 }) as never);
    await pollImap({}, deps);
    expect(imapFactory).not.toHaveBeenCalled();
    expect(connection.query).toHaveBeenCalledWith("ROLLBACK");
    // Neither the cursor nor the failure counter: a held lock is not a failed poll.
    expect(connection.query).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE mailbox_credentials"), expect.anything());
    expect(connection.query).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO notifications"), expect.anything());
  });

  it("records last_polled_at and preserves the cursor when credential decryption fails", async () => {
    const { deps, connection, imapFactory, row } = setup();
    vi.mocked(readMailboxCredentials).mockRejectedValue(new Error("secret decryption failed"));
    await pollImap({}, deps);
    expect(imapFactory).not.toHaveBeenCalled();
    expect(connection.query).toHaveBeenCalledWith(expect.stringContaining("last_polled_at=now()"), [emailAccountId, "100", "1"]);
    // Nothing reached the mail server, so the mailbox is neither backed off nor flagged.
    expect(row).toMatchObject({ imap_poll_failures: 0, backing_off: false, last_verify_error: null });
  });

  it("caps fetched messages at fifty and skips expunged messages deliberately", async () => {
    const { deps, connection, imap } = setup();
    vi.mocked(imap.mailboxOpen).mockResolvedValue({ uidValidity: 1n, uidNext: 201 });
    // The sweep's range search lists every UID; the per-message search that follows
    // an empty fetch confirms each one is really gone.
    vi.mocked(imap.search).mockImplementation(async (query) => (String(query.uid).includes(":") ? Array.from({ length: 100 }, (_, index) => 101 + index) : []));
    vi.mocked(imap.fetchOne).mockResolvedValue(false);
    await pollImap({}, deps);
    expect(imap.fetchOne).toHaveBeenCalledTimes(50);
    expect(ingestInboundEvent).not.toHaveBeenCalled();
    expect(connection.query).toHaveBeenCalledWith(expect.stringContaining("UPDATE mailbox_credentials"), [emailAccountId, "150", "1"]);
  });
});

describe("IMAP poll failures back off and surface", () => {
  it("doubles the wait from one sweep interval up to an hour", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 40].map(pollBackoffSeconds)).toEqual([120, 240, 480, 960, 1920, 3600, 3600, 3600]);
  });

  it("counts a failed connection, backs off, and stays out of the sweep until the retry time", async () => {
    const { deps, pool, connection, imap, imapFactory, logger, row, notifications, elapseBackoff } = setup();
    vi.mocked(imap.connect).mockRejectedValue(Object.assign(new Error("connect ECONNREFUSED 203.0.113.9:993"), { code: "ECONNREFUSED" }));
    await pollImap({}, deps);
    expect(row).toMatchObject({ imap_poll_failures: 1, backing_off: true, retry_seconds: 120, last_imap_uid: "100", last_verify_error: null });
    expect(logger.warn).toHaveBeenCalledWith("IMAP mailbox polling failed", expect.objectContaining({ emailAccountId, stage: "connect" }));
    expect(notifications).toHaveLength(0);
    // The selection itself filters on the retry time.
    expect(pool.query).toHaveBeenCalledWith(expect.stringMatching(/imap_poll_retry_at IS NULL OR mc\.imap_poll_retry_at<=now\(\)/), expect.anything());

    await pollImap({}, deps);
    expect(imapFactory).toHaveBeenCalledOnce();
    expect(row.imap_poll_failures).toBe(1);

    // A sweep that selected the mailbox just before the failure was recorded still stands down.
    pool.query.mockResolvedValueOnce({ rows: [{ email_account_id: emailAccountId }], rowCount: 1 });
    connection.query.mockClear();
    await pollImap({}, deps);
    expect(imapFactory).toHaveBeenCalledOnce();
    expect(connection.query).toHaveBeenCalledWith("ROLLBACK");
    expect(connection.query).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE mailbox_credentials"), expect.anything());

    elapseBackoff();
    await pollImap({}, deps);
    expect(imapFactory).toHaveBeenCalledTimes(2);
    expect(row).toMatchObject({ imap_poll_failures: 2, backing_off: true, retry_seconds: 240 });
  });

  it("flags the mailbox and notifies exactly once when the fifth consecutive poll fails", async () => {
    const { deps, imap, row, notifications, elapseBackoff } = setup();
    vi.mocked(imap.mailboxOpen).mockRejectedValue(Object.assign(new Error("Command failed"), { responseStatus: "NO", responseText: "Mailbox does not exist: provider detail" }));
    for (let poll = 1; poll <= 4; poll += 1) {
      await pollImap({}, deps);
      elapseBackoff();
    }
    expect(row).toMatchObject({ imap_poll_failures: 4, last_verify_error: null });
    expect(notifications).toHaveLength(0);

    await pollImap({}, deps);
    expect(row).toMatchObject({ imap_poll_failures: 5, retry_seconds: 1920, last_verify_error: IMAP_POLL_FAILING_ERROR });
    expect(row.last_verify_error).not.toContain("provider detail");
    expect(notifications).toEqual([{ type: "mailbox_reconnect_required", title: "Reconnect your sending inbox", body: reconnectBody, read: false }]);

    elapseBackoff();
    await pollImap({}, deps);
    expect(row).toMatchObject({ imap_poll_failures: 6, retry_seconds: 3600 });
    expect(notifications).toHaveLength(1);
    // Read but still broken: the mailbox was already flagged, so the user is not told again every hour.
    notifications[0]!.read = true;
    elapseBackoff();
    await pollImap({}, deps);
    expect(row.imap_poll_failures).toBe(7);
    expect(notifications).toHaveLength(1);
  });

  it("flags an authentication failure on the first poll, with one notification", async () => {
    const { deps, imap, row, notifications, elapseBackoff } = setup();
    vi.mocked(imap.connect).mockRejectedValue(Object.assign(new Error("Command failed"), { authenticationFailed: true, responseText: "secret-app-password rejected" }));
    await pollImap({}, deps);
    expect(row).toMatchObject({ imap_poll_failures: 1, retry_seconds: 120, last_verify_error: IMAP_POLL_AUTH_ERROR });
    expect(row.last_verify_error).not.toContain("secret-app-password");
    expect(notifications).toEqual([{ type: "mailbox_reconnect_required", title: "Reconnect your sending inbox", body: reconnectBody, read: false }]);
    elapseBackoff();
    await pollImap({}, deps);
    expect(row.imap_poll_failures).toBe(2);
    expect(notifications).toHaveLength(1);
  });

  it("does not read a certificate failure, or a later-stage error that mentions authentication, as bad credentials", async () => {
    const tls = setup();
    vi.mocked(tls.imap.connect).mockRejectedValue(Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" }));
    await pollImap({}, tls.deps);
    expect(tls.row).toMatchObject({ imap_poll_failures: 1, last_verify_error: null });
    expect(tls.notifications).toHaveLength(0);

    const database = setup();
    vi.mocked(ingestInboundEvent).mockRejectedValue(Object.assign(new Error("password authentication failed for user \"inboxjoy\""), { code: "28P01" }));
    await pollImap({}, database.deps);
    expect(database.row).toMatchObject({ imap_poll_failures: 1, last_verify_error: null });
    expect(database.notifications).toHaveLength(0);
  });

  it("treats a failed UID search as a failed poll", async () => {
    const { deps, imap, row } = setup();
    vi.mocked(imap.search).mockResolvedValue(false);
    await pollImap({}, deps);
    expect(imap.fetchOne).not.toHaveBeenCalled();
    expect(row).toMatchObject({ imap_poll_failures: 1, backing_off: true, last_imap_uid: "100" });
  });

  it("resets the failure state on a successful poll and clears only its own verify error", async () => {
    const flagged = setup({ imap_poll_failures: 6, last_verify_error: IMAP_POLL_FAILING_ERROR });
    await pollImap({}, flagged.deps);
    expect(flagged.row).toMatchObject({ imap_poll_failures: 0, backing_off: false, retry_seconds: null, last_verify_error: null, last_imap_uid: "105" });

    const verifyFlowError = "IMAP authentication failed. Check the username and password.";
    const verifyFailed = setup({ imap_poll_failures: 2, last_verify_error: verifyFlowError });
    await pollImap({}, verifyFailed.deps);
    expect(verifyFailed.row).toMatchObject({ imap_poll_failures: 0, last_verify_error: verifyFlowError });
  });

  it("keeps a verify-flow error in place when its own polls start failing", async () => {
    const verifyFlowError = "IMAP TLS verification failed. Check the secure setting and server certificate.";
    const { deps, imap, row } = setup({ imap_poll_failures: 4, last_verify_error: verifyFlowError });
    vi.mocked(imap.connect).mockRejectedValue(Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }));
    await pollImap({}, deps);
    expect(row).toMatchObject({ imap_poll_failures: 5, last_verify_error: verifyFlowError });
  });

  it("drops a failure verdict reached on credentials that were re-verified during the poll", async () => {
    const { deps, imap, row, notifications } = setup({ imap_poll_failures: 4 });
    vi.mocked(imap.connect).mockImplementation(async () => {
      // The user saves working credentials while this poll is still connecting with the old ones.
      Object.assign(row, { verified_at: "2026-10-10 12:00:00+00", imap_poll_failures: 0 });
      throw Object.assign(new Error("Command failed"), { authenticationFailed: true });
    });
    await pollImap({}, deps);
    expect(row).toMatchObject({ imap_poll_failures: 0, backing_off: false, last_verify_error: null });
    expect(notifications).toHaveLength(0);
  });
});

describe("IMAP messages that cannot be ingested", () => {
  it("retries a failing message on two polls, then records it as skipped and ingests the reply behind it", async () => {
    const { deps, pool, connection, imap, logger, row, skippedEvents, notifications } = setup();
    vi.mocked(imap.mailboxOpen).mockResolvedValue({ uidValidity: 1n, uidNext: 103 });
    vi.mocked(imap.search).mockResolvedValue([101, 102]);
    class UnstorableMessageError extends Error { override name = "UnstorableMessageError"; }
    vi.mocked(ingestInboundEvent).mockImplementation(async (_db, event) => {
      if (event.eventId === eventIdFor(101)) throw new UnstorableMessageError("value rejected: lead said something private");
      return { received: true, duplicate: false };
    });

    await pollImap({}, deps);
    expect(row).toMatchObject({ last_imap_uid: "100", imap_stuck_uid: "101", imap_stuck_attempts: 1 });
    await pollImap({}, deps);
    expect(row).toMatchObject({ last_imap_uid: "100", imap_stuck_uid: "101", imap_stuck_attempts: 2 });
    // The server answered every time, so none of this is a poll failure and nothing backs off.
    expect(row).toMatchObject({ imap_poll_failures: 0, backing_off: false, last_verify_error: null });
    expect(skippedEvents).toHaveLength(0);
    expect(ingestedUids()).toEqual([101, 101]);
    expect(logger.error).not.toHaveBeenCalled();

    await pollImap({}, deps);
    expect(skippedEvents).toHaveLength(1);
    expect(skippedEvents[0]).toMatchObject({ workspaceId, eventId: eventIdFor(101), errorClass: "UnstorableMessageError" });
    // Only the marker: no subject, body or addresses from the message.
    expect(skippedEvents[0]!.payload).toEqual({ skipped: true, reason: "UnstorableMessageError", uid: 101, uidvalidity: "1" });
    expect(skippedEvents[0]!.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(pool.query).toHaveBeenCalledWith(expect.stringMatching(/'failed'[\s\S]*ON CONFLICT \(provider,event_id\)[\s\S]*NOT IN \('processed','ignored'\)/), expect.anything());
    expect(logger.error).toHaveBeenCalledWith("IMAP message skipped after repeated ingestion failures", { emailAccountId, uid: 101, attempts: 3, errorClass: "UnstorableMessageError" });
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("something private");
    // The reply queued behind it is ingested on that same poll.
    expect(ingestedUids()).toEqual([101, 101, 101, 102]);
    expect(connection.query).toHaveBeenCalledWith(expect.stringContaining("UPDATE mailbox_credentials"), [emailAccountId, "102", "1"]);
    expect(row).toMatchObject({ last_imap_uid: "102", imap_stuck_uid: null, imap_stuck_attempts: 0, imap_poll_failures: 0 });
    expect(notifications).toHaveLength(0);
  });

  it("clears the stuck counter when the message goes through after all", async () => {
    const { deps, row, skippedEvents } = setup({ imap_stuck_uid: "101", imap_stuck_attempts: 2 });
    await pollImap({}, deps);
    expect(row).toMatchObject({ last_imap_uid: "105", imap_stuck_uid: null, imap_stuck_attempts: 0 });
    expect(skippedEvents).toHaveLength(0);
  });

  it("never skips on a transient database error, and never counts it against the message", async () => {
    const { deps, imap, row, skippedEvents, elapseBackoff } = setup({ imap_stuck_uid: "101", imap_stuck_attempts: 2 });
    // drizzle wraps the driver error, so the SQLSTATE sits on the cause.
    vi.mocked(ingestInboundEvent).mockRejectedValue(new Error("Failed query: insert into replies", { cause: Object.assign(new Error("deadlock detected"), { code: "40P01" }) }));
    for (let poll = 1; poll <= 4; poll += 1) {
      await pollImap({}, deps);
      expect(row).toMatchObject({ last_imap_uid: "100", imap_stuck_uid: "101", imap_stuck_attempts: 2, imap_poll_failures: poll, backing_off: true });
      elapseBackoff();
    }
    expect(skippedEvents).toHaveLength(0);
    // One attempt per poll: the batch stops at the first transient error.
    expect(imap.fetchOne).toHaveBeenCalledTimes(4);
  });

  it("keeps the cursor when a fetch fails on a dropped connection", async () => {
    const { deps, imap, row, skippedEvents } = setup();
    vi.mocked(imap.fetchOne).mockImplementation(async (uid) => {
      if (uid === "102") throw Object.assign(new Error("Connection not available"), { code: "NoConnection" });
      return { uid: Number(uid), source: Buffer.from("From: lead@example.com\r\n\r\nHi") };
    });
    await pollImap({}, deps);
    expect(row).toMatchObject({ last_imap_uid: "101", imap_stuck_uid: null, imap_stuck_attempts: 0, imap_poll_failures: 1 });
    expect(skippedEvents).toHaveLength(0);

    // An error with no recognisable code is still the connection's fault when the client reports itself unusable.
    const dropped = setup({ imap_stuck_uid: "101", imap_stuck_attempts: 2 });
    vi.mocked(dropped.imap.fetchOne).mockImplementation(async () => {
      (dropped.imap as { usable?: boolean }).usable = false;
      throw new Error("read failed");
    });
    await pollImap({}, dropped.deps);
    expect(dropped.row).toMatchObject({ last_imap_uid: "100", imap_stuck_uid: "101", imap_stuck_attempts: 2, imap_poll_failures: 1 });
    expect(dropped.skippedEvents).toHaveLength(0);
  });

  it("advances past an empty fetch only when the server confirms the message is gone", async () => {
    // imapflow resolves false after a server BYE too; its search then also resolves false.
    const closed = setup();
    vi.mocked(closed.imap.fetchOne).mockResolvedValue(false);
    vi.mocked(closed.imap.search).mockImplementation(async (query) => (String(query.uid).includes(":") ? [101, 102] : false));
    await pollImap({}, closed.deps);
    expect(closed.row).toMatchObject({ last_imap_uid: "100", imap_poll_failures: 1, backing_off: true, imap_stuck_uid: null });

    // Still listed but not returned (a throttled FETCH): not proof of anything, so it waits.
    const listed = setup();
    vi.mocked(listed.imap.fetchOne).mockResolvedValue(false);
    vi.mocked(listed.imap.search).mockResolvedValue([101, 102]);
    await pollImap({}, listed.deps);
    expect(listed.row).toMatchObject({ last_imap_uid: "100", imap_poll_failures: 1, imap_stuck_uid: null });

    const expunged = setup();
    vi.mocked(expunged.imap.fetchOne).mockImplementation(async (uid) => (uid === "101" ? false : { uid: Number(uid), source: Buffer.from("From: lead@example.com\r\n\r\nHi") }));
    vi.mocked(expunged.imap.search).mockImplementation(async (query) => (String(query.uid).includes(":") ? [101, 102] : []));
    await pollImap({}, expunged.deps);
    expect(expunged.imap.search).toHaveBeenCalledWith({ uid: "101" }, { uid: true });
    expect(expunged.row).toMatchObject({ last_imap_uid: "102", imap_poll_failures: 0 });
    expect(ingestedUids()).toEqual([102]);
  });

  it("does not advance when the skipped-message record cannot be written", async () => {
    const { deps, pool, row, logger, elapseBackoff } = setup({ imap_stuck_uid: "101", imap_stuck_attempts: 2 });
    vi.mocked(ingestInboundEvent).mockRejectedValue(new TypeError("cannot read message"));
    const selection = pool.query.getMockImplementation()!;
    pool.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("INSERT INTO provider_webhook_events")) throw Object.assign(new Error("value too long for type character varying(120)"), { code: "22001" });
      return selection(sql, params);
    });
    await pollImap({}, deps);
    expect(row).toMatchObject({ last_imap_uid: "100", imap_stuck_uid: "101", imap_stuck_attempts: 3, imap_poll_failures: 0 });
    expect(logger.error).not.toHaveBeenCalled();

    // A lost database connection while writing the record is a failed poll, and still no skip.
    pool.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("INSERT INTO provider_webhook_events")) throw new Error("Connection terminated unexpectedly");
      return selection(sql, params);
    });
    await pollImap({}, deps);
    expect(row).toMatchObject({ last_imap_uid: "100", imap_stuck_uid: "101", imap_poll_failures: 1, backing_off: true });
    elapseBackoff();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it.each([
    ["serialization failure", { code: "40001" }, true],
    ["deadlock", { code: "40P01" }, true],
    ["lock timeout", { code: "55P03" }, true],
    ["connection failure", { code: "08006" }, true],
    ["too many connections", { code: "53300" }, true],
    ["admin shutdown", { code: "57P01" }, true],
    ["missing column during a deploy", { code: "42703" }, true],
    ["read-only transaction after failover", { code: "25006" }, true],
    ["socket reset", { code: "ECONNRESET" }, true],
    ["imapflow closed connection", { code: "EConnectionClosed" }, true],
    ["imapflow socket timeout", { code: "ETIMEOUT" }, true],
    ["server says temporarily unavailable", { responseStatus: "NO", response: { attributes: [{ section: [{ value: "UNAVAILABLE" }] }] } }, true],
    ["server throttling", { responseStatus: "BAD", responseText: "Request is throttled" }, true],
    ["server rejects one message", { responseStatus: "NO", responseText: "Internal error occurred" }, false],
    ["invalid text for jsonb", { code: "22P05" }, false],
    ["value too long", { code: "22001" }, false],
    ["unique violation", { code: "23505" }, false],
    ["index row too large", { code: "54000" }, false],
    ["plain error", {}, false],
  ])("classifies %s", (_label, fields, transient) => {
    expect(isTransientPollError(Object.assign(new Error("failure"), fields))).toBe(transient);
    expect(isTransientPollError(new Error("Failed query: insert ... params: timeout,connection terminated", { cause: Object.assign(new Error("failure"), fields) }))).toBe(transient);
  });

  it("recognises node-postgres connection errors that carry no code", () => {
    for (const message of ["Connection terminated unexpectedly", "timeout exceeded when trying to connect", "Client has encountered a connection error and is not queryable", "Query read timeout"]) {
      expect(isTransientPollError(new Error(message))).toBe(true);
    }
    // A data error that merely quotes such text from a message stays message-level.
    expect(isTransientPollError(Object.assign(new Error("invalid input syntax for type json: \"Connection terminated unexpectedly\""), { code: "22P02" }))).toBe(false);
    expect(isTransientPollError(new TypeError("Cannot read properties of undefined (reading 'timeout')"))).toBe(false);
  });
});
