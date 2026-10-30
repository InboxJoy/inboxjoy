import { applySuppression, ingestInboundEvent, readMailboxCredentials } from "@inboxjoy/core";
import { createDb } from "@inboxjoy/db";
import type { PollImapJob } from "@inboxjoy/queue";
import { createInboxImapClient, parseImapMessage, type InboxImapClient, type InboxImapFactory } from "@inboxjoy/smtp";
import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { logger } from "../logger.js";

export const POLL_IMAP_MAILBOX_LIMIT = 20;
export const POLL_IMAP_MESSAGE_LIMIT = 50;
// The sweep runs every two minutes (scheduleRecurringJobs in packages/queue). A
// mailbox whose poll fails waits one interval, then twice as long after each
// further failure, up to an hour: a dead mailbox costs the provider one login an
// hour instead of thirty, which is what gets accounts locked out.
export const POLL_IMAP_INTERVAL_SECONDS = 120;
export const POLL_IMAP_MAX_BACKOFF_SECONDS = 3600;
export const POLL_IMAP_FAILURE_THRESHOLD = 5;
export const POLL_IMAP_STUCK_MESSAGE_ATTEMPTS = 3;
// Stored in mailbox_credentials.last_verify_error. Only these two strings are ever
// written or cleared here, so an error left by the verify flow is never wiped by a
// later successful poll.
export const IMAP_POLL_AUTH_ERROR = "Inbox sync stopped: IMAP authentication failed. Check the username and password.";
export const IMAP_POLL_FAILING_ERROR = "Inbox sync keeps failing. Check the IMAP host, port and INBOX access.";
const IMAP_POLL_ERRORS = [IMAP_POLL_AUTH_ERROR, IMAP_POLL_FAILING_ERROR];

type Dependencies = {
  pool: Pool;
  smtpMailboxesEnabled: boolean;
  allowPrivateHosts?: boolean;
  keys: Map<number, Buffer>;
  imapFactory?: InboxImapFactory;
  logger?: typeof logger;
};

type PollStage = "prepare" | "connect" | "mailbox" | "search" | "messages";

// Raised when the server gave no usable answer for a message, as opposed to an
// answer we could not process. It always stops the batch without moving the cursor.
class ImapPollTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImapPollTransientError";
  }
}

export function pollBackoffSeconds(failures: number): number {
  return Math.min(POLL_IMAP_MAX_BACKOFF_SECONDS, POLL_IMAP_INTERVAL_SECONDS * 2 ** Math.min(Math.max(failures, 1) - 1, 10));
}

function errorChain(error: unknown): Record<string, unknown>[] {
  const chain: Record<string, unknown>[] = [];
  for (let current = error; current && typeof current === "object" && chain.length < 5; current = (current as { cause?: unknown }).cause) chain.push(current as Record<string, unknown>);
  return chain;
}

// Network and IMAP-session failures: Node socket/DNS/TLS codes plus the codes
// imapflow puts on a dropped, timed-out, throttled or garbled connection.
const CONNECTION_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "EHOSTDOWN",
  "ENETUNREACH", "ENETDOWN", "EADDRNOTAVAIL", "EPROTO", "ESOCKET", "ECONNECTION", "ETLS", "ETIMEOUT", "ETHROTTLE",
  "NoConnection", "EConnectionClosed", "StateLogout", "InvalidResponse", "ENotFinished",
  "CONNECT_TIMEOUT", "GREETING_TIMEOUT", "UPGRADE_TIMEOUT", "ClosedAfterConnectTLS", "ClosedAfterConnectText",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
]);
// Five characters and never a leading E, which is what tells a SQLSTATE from an errno.
const SQLSTATE = /^[0-9A-DF-Z][0-9A-Z]{4}$/;
// Postgres failures that say nothing about the message being stored: connection
// (08), serialization/deadlock (40), resources (53), operator intervention (57) and
// lock timeout (55P03), plus the classes a broken deploy or failover produces --
// transaction state (25), authorization (28), missing catalog/schema/table/column
// (3D, 3F, 42), system and internal errors (58, F0, XX). Data errors (22, 23, 54)
// are deliberately absent: those belong to the one message.
const TRANSIENT_SQLSTATE = /^(?:(?:08|25|28|3D|3F|40|42|53|57|58|F0|XX)[0-9A-Z]{3}|55P03)$/;
// node-postgres raises these without a code when it loses or cannot get a
// connection. Anchored, so text quoted from a message can never match.
const TRANSIENT_MESSAGE = /^(?:connection terminated|timeout exceeded when trying to connect|client (?:has encountered a connection error|was closed) and is not queryable|query read timeout|cannot use a pool after calling end)/i;
// A tagged NO/BAD that means "not now" rather than "not this message": the RFC 5530
// response codes for it, and the wording servers use when they throttle.
const TEMPORARY_IMAP_CODES = new Set(["UNAVAILABLE", "INUSE", "LIMIT", "THROTTLED"]);
const TEMPORARY_IMAP_TEXT = /throttl|temporar|try again|too many|rate limit/i;

function imapResponseCode(link: Record<string, unknown>): string {
  if (typeof link.serverResponseCode === "string") return link.serverResponseCode.toUpperCase();
  const response = link.response && typeof link.response === "object" ? link.response as { attributes?: { section?: { value?: unknown }[] }[] } : undefined;
  const value = Array.isArray(response?.attributes) && Array.isArray(response.attributes[0]?.section) ? response.attributes[0].section[0]?.value : undefined;
  return typeof value === "string" ? value.toUpperCase().trim() : "";
}

// Transient means "retry the same message later": never count it against the
// message, never skip past it. Checked through `cause` because drizzle wraps the
// driver error.
export function isTransientPollError(error: unknown): boolean {
  return errorChain(error).some((link) => {
    if (link instanceof ImapPollTransientError || link.authenticationFailed === true) return true;
    const code = typeof link.code === "string" ? link.code : "";
    // Judged by SQLSTATE alone: a Postgres message can quote the value it rejected.
    if (SQLSTATE.test(code)) return TRANSIENT_SQLSTATE.test(code);
    if (CONNECTION_CODES.has(code) || /^(?:ERR_(?:SOCKET|STREAM|TLS|SSL)_|CERT_)/.test(code)) return true;
    if (typeof link.responseStatus === "string") return TEMPORARY_IMAP_CODES.has(imapResponseCode(link)) || (typeof link.responseText === "string" && TEMPORARY_IMAP_TEXT.test(link.responseText));
    return typeof link.message === "string" && TRANSIENT_MESSAGE.test(link.message);
  });
}

// Same signals as failureField in packages/smtp/src/verify.ts, so the poller and the
// verify flow agree on what counts as bad credentials (a TLS failure is not one).
function isImapAuthFailure(error: unknown): boolean {
  const details = error && typeof error === "object" ? error as { code?: unknown; command?: unknown; authenticationFailed?: unknown; message?: unknown } : {};
  const code = typeof details.code === "string" ? details.code : "";
  const message = typeof details.message === "string" ? details.message : "";
  if (/TLS|SSL|CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code) || /certificate|STARTTLS|TLS|SSL/i.test(message)) return false;
  return details.authenticationFailed === true || code === "EAUTH" || /AUTH|LOGIN/i.test(String(details.command ?? "")) || /authentication|invalid credentials|login failed/i.test(message);
}

// A class name only, never the message: provider and driver text can carry
// addresses or content. A wrapped Postgres error reports its SQLSTATE, since the
// wrapper itself is just "Error".
function errorClassName(error: unknown): string {
  const database = errorChain(error).find((link) => typeof link.code === "string" && SQLSTATE.test(link.code));
  if (database) return `PostgresError_${String(database.code)}`;
  return (error instanceof Error ? error.name : "ImapPollError").slice(0, 120);
}

export async function pollImap(_payload: PollImapJob, deps: Dependencies): Promise<void> {
  if (!deps.smtpMailboxesEnabled) return;
  const log = deps.logger ?? logger;
  const db = createDb(deps.pool);
  // Mailboxes still backing off stay out of the sweep, so they neither get polled
  // early nor take one of the limited slots from a healthy mailbox.
  const mailboxes = await deps.pool.query<{ email_account_id: string }>(`
    SELECT ea.id AS email_account_id
    FROM email_accounts ea
    JOIN mailbox_credentials mc ON mc.email_account_id=ea.id AND mc.workspace_id=ea.workspace_id
    WHERE ea.provider='smtp' AND ea.status='active'
      AND (mc.imap_poll_retry_at IS NULL OR mc.imap_poll_retry_at<=now())
    ORDER BY mc.last_polled_at ASC NULLS FIRST,ea.id
    LIMIT $1
  `, [POLL_IMAP_MAILBOX_LIMIT]);

  for (const { email_account_id: emailAccountId } of mailboxes.rows) {
    const connection = await deps.pool.connect();
    let client: InboxImapClient | undefined;
    let locked = false;
    let cursor: bigint | null = null;
    let uidvalidity: bigint | null = null;
    let workspaceId: string | null = null;
    let mailboxEmail: string | null = null;
    let verifiedAt: string | null = null;
    let pollFailures = 0;
    let flagged = false;
    let stuckUid: bigint | null = null;
    let stuckAttempts = 0;
    let stage: PollStage = "prepare";
    // "untouched" leaves poll health exactly as it was: a held lock, an inactive or
    // backing-off mailbox, or a failure before any connection was attempted.
    let outcome: "untouched" | "healthy" | "failed" = "untouched";
    let failure: unknown;
    try {
      await connection.query("BEGIN");
      const lock = await connection.query<{ acquired: boolean }>("SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired", [`imap-poll:${emailAccountId}`]);
      if (!lock.rows[0]?.acquired) continue;
      const active = await connection.query<{ workspace_id: string; email: string | null }>("SELECT workspace_id,email FROM email_accounts WHERE id=$1 AND provider='smtp' AND status='active'", [emailAccountId]);
      const account = active.rows[0];
      if (!account) continue;
      const snapshot = await connection.query<{
        last_imap_uid: string | null; last_imap_uidvalidity: string | null; imap_poll_failures: number; backing_off: boolean;
        imap_stuck_uid: string | null; imap_stuck_attempts: number; last_verify_error: string | null; verified_at: string | null;
      }>(`SELECT last_imap_uid,last_imap_uidvalidity,imap_poll_failures,COALESCE(imap_poll_retry_at>now(),false) AS backing_off,
        imap_stuck_uid,imap_stuck_attempts,last_verify_error,verified_at::text AS verified_at
        FROM mailbox_credentials WHERE email_account_id=$1`, [emailAccountId]);
      const state = snapshot.rows[0];
      // Selection already filters on the retry time. This catches the sweep that
      // picked the mailbox just before an overlapping one recorded a failure for it.
      if (!state || state.backing_off) continue;
      locked = true;
      workspaceId = account.workspace_id;
      mailboxEmail = account.email;
      cursor = state.last_imap_uid === null ? null : BigInt(state.last_imap_uid);
      uidvalidity = state.last_imap_uidvalidity === null ? null : BigInt(state.last_imap_uidvalidity);
      pollFailures = state.imap_poll_failures;
      flagged = state.last_verify_error !== null && IMAP_POLL_ERRORS.includes(state.last_verify_error);
      stuckUid = state.imap_stuck_uid === null ? null : BigInt(state.imap_stuck_uid);
      stuckAttempts = state.imap_stuck_attempts;
      verifiedAt = state.verified_at;
      const credentials = await readMailboxCredentials(db, emailAccountId, { includeSecrets: true, keys: deps.keys });
      if (!credentials) continue;
      stage = "connect";
      client = await createInboxImapClient({ ...credentials.imap, allowPrivateHosts: deps.allowPrivateHosts }, deps.imapFactory);
      client.on("error", () => {});
      await client.connect();
      stage = "mailbox";
      const mailbox = await client.mailboxOpen("INBOX");
      if (uidvalidity !== mailbox.uidValidity) {
        cursor = BigInt(Math.max(0, mailbox.uidNext - 1));
        uidvalidity = mailbox.uidValidity;
        // UIDs are only meaningful within one UIDVALIDITY, so a stuck one is forgotten with the cursor.
        stuckUid = null;
        stuckAttempts = 0;
        outcome = "healthy";
        log.warn("IMAP UIDVALIDITY changed; resetting cursor without ingestion", { emailAccountId, uidvalidity: String(uidvalidity), cursor: String(cursor) });
        continue;
      }
      stage = "search";
      const matches = await client.search({ uid: `${(cursor ?? 0n) + 1n}:*` }, { uid: true });
      if (matches === false) throw new Error("IMAP UID search failed.");
      outcome = "healthy";
      stage = "messages";
      const uids = [...new Set(matches)].filter((uid) => Number.isSafeInteger(uid) && BigInt(uid) > (cursor ?? 0n) && uid < mailbox.uidNext).sort((left, right) => left - right).slice(0, POLL_IMAP_MESSAGE_LIMIT);
      for (const uid of uids) {
        const eventId = createHash("sha256").update(`${emailAccountId}|${uidvalidity}|${uid}`).digest("hex");
        let source: Buffer | undefined;
        let fetched = false;
        try {
          const message = await client.fetchOne(String(uid), { source: true, internalDate: true }, { uid: true });
          fetched = true;
          if (message) {
            if (!message.source || message.uid !== uid) throw new Error("IMAP message source or UID is unavailable.");
            source = message.source;
            const { data, bounce } = await parseImapMessage(message.source, message.internalDate instanceof Date ? message.internalDate : new Date());
            const payload = { data, bounce };
            await ingestInboundEvent(db, {
              provider: "imap",
              eventId,
              payloadHash: createHash("sha256").update(message.source).digest("hex"),
              accountId: emailAccountId,
              eventType: "imap_message_received",
              triggerSlug: "IMAP_NEW_MESSAGE",
              payload,
              data,
              bounce,
            }, {
              // Same suppression path the Gmail/Outlook webhook uses, so a lead who
              // replies "unsubscribe" to an SMTP mailbox is suppressed workspace-wide
              // and every live enrollment for them stops.
              applySuppression: (input) => applySuppression(db, input),
              logger: {
                error: (context, message) => log.error(message, context),
                info: (context, message) => log.info(message, context),
              },
            });
          } else {
            // imapflow resolves false for a message expunged since the search, but
            // also when the server has already said BYE (the socket is still open
            // and nothing is selected) or kept throttling the FETCH. Only a search
            // that still works and no longer lists the UID proves it is gone;
            // anything else must not move the cursor past a message we never read.
            const remaining = await client.search({ uid: String(uid) }, { uid: true }).catch(() => false as const);
            if (remaining === false || remaining.includes(uid)) throw new ImapPollTransientError("IMAP message fetch returned nothing.");
          }
        } catch (error) {
          // The connection or the database let us down, not the message: stop here,
          // leave the cursor and the stuck counter alone, and let the mailbox back off.
          if (isTransientPollError(error) || (!fetched && (client as { usable?: unknown }).usable === false)) throw error;
          const attempts = stuckUid === BigInt(uid) ? stuckAttempts + 1 : 1;
          const errorClass = errorClassName(error);
          stuckUid = BigInt(uid);
          stuckAttempts = attempts;
          if (attempts < POLL_IMAP_STUCK_MESSAGE_ATTEMPTS) {
            log.warn("IMAP message could not be ingested; it will be retried on the next poll", { emailAccountId, uid, attempts, errorClass });
            break;
          }
          // Three polls in a row could not get past this message. Leave a failed event
          // row as the record of what was skipped, then move on so the replies and
          // bounces queued behind it are seen again. The row goes through the pool,
          // like ingestion does, so it is committed before the cursor moves.
          const skipped = { skipped: true, reason: errorClass, uid, uidvalidity: String(uidvalidity) };
          try {
            await deps.pool.query(`INSERT INTO provider_webhook_events (id,workspace_id,provider,event_id,payload_hash,status,error_class,payload)
              VALUES ($1,$2,'imap',$3,$4,'failed',$5,$6::jsonb)
              ON CONFLICT (provider,event_id) WHERE event_id IS NOT NULL DO UPDATE
                SET status='failed',error_class=EXCLUDED.error_class,payload=provider_webhook_events.payload || EXCLUDED.payload
                WHERE provider_webhook_events.status NOT IN ('processed','ignored')`, [
              randomUUID(), workspaceId, eventId, createHash("sha256").update(source ?? JSON.stringify(skipped)).digest("hex"), errorClass, JSON.stringify(skipped),
            ]);
          } catch (recordError) {
            // No record, no skip: the cursor stays and the next poll tries again.
            if (isTransientPollError(recordError)) throw recordError;
            log.warn("IMAP skipped-message record could not be written; the message stays queued", { emailAccountId, uid, errorClass: errorClassName(recordError) });
            break;
          }
          log.error("IMAP message skipped after repeated ingestion failures", { emailAccountId, uid, attempts, errorClass });
        }
        cursor = BigInt(uid);
        stuckUid = null;
        stuckAttempts = 0;
      }
    } catch (error) {
      failure = error;
      // Unreadable stored credentials are ours to fix, not the mailbox's: nothing
      // was attempted against the server, so poll health is left alone.
      outcome = stage === "prepare" ? "untouched" : "failed";
      log.warn("IMAP mailbox polling failed", { emailAccountId, stage, errorClass: errorClassName(error) });
    } finally {
      if (client) {
        try { await client.logout(); } catch {}
        try { client.close(); } catch {}
      }
      try {
        if (locked) {
          await connection.query("UPDATE mailbox_credentials SET last_imap_uid=$2,last_imap_uidvalidity=$3,last_polled_at=now(),updated_at=now() WHERE email_account_id=$1", [emailAccountId, cursor?.toString() ?? null, uidvalidity?.toString() ?? null]);
          if (outcome === "healthy") {
            await connection.query(`UPDATE mailbox_credentials SET imap_poll_failures=0,imap_poll_retry_at=NULL,imap_stuck_uid=$2,imap_stuck_attempts=$3,
              last_verify_error=CASE WHEN last_verify_error=ANY($4::text[]) THEN NULL ELSE last_verify_error END
              WHERE email_account_id=$1`, [emailAccountId, stuckUid?.toString() ?? null, stuckAttempts, IMAP_POLL_ERRORS]);
          } else if (outcome === "failed") {
            const failures = pollFailures + 1;
            // Only a failed login is read as bad credentials; the same words in a
            // later-stage error (a database message, say) are not.
            const authFailure = stage === "connect" && isImapAuthFailure(failure);
            const flag = authFailure || failures >= POLL_IMAP_FAILURE_THRESHOLD;
            // The verified_at guard drops this verdict when the mailbox was saved or
            // re-verified while the poll was running on the old credentials.
            const recorded = await connection.query(`UPDATE mailbox_credentials SET imap_poll_failures=$2,imap_poll_retry_at=now()+($3::int * interval '1 second'),
              imap_stuck_uid=$4,imap_stuck_attempts=$5,
              last_verify_error=CASE WHEN $6::text IS NOT NULL AND (last_verify_error IS NULL OR last_verify_error=ANY($7::text[])) THEN $6::text ELSE last_verify_error END
              WHERE email_account_id=$1 AND verified_at IS NOT DISTINCT FROM $8::timestamptz`, [
              emailAccountId, failures, pollBackoffSeconds(failures), stuckUid?.toString() ?? null, stuckAttempts,
              flag ? (authFailure ? IMAP_POLL_AUTH_ERROR : IMAP_POLL_FAILING_ERROR) : null, IMAP_POLL_ERRORS, verifiedAt,
            ]);
            // Told once per outage, when the mailbox is first flagged. Sending is left
            // alone: SMTP may still work, and the pre-send reply check pauses the
            // mailbox itself if IMAP auth fails when a follow-up is due. Same title,
            // body and unread de-duplication as recordFailure in send-message.ts.
            if (flag && !flagged && workspaceId && recorded.rowCount === 1) {
              const notificationBody = `Reconnect ${mailboxEmail ?? "the sending inbox"} to resume paused campaigns.`;
              await connection.query(`INSERT INTO notifications (id,workspace_id,type,title,body)
                SELECT $1,$2,'mailbox_reconnect_required','Reconnect your sending inbox',$3
                WHERE NOT EXISTS (SELECT 1 FROM notifications WHERE workspace_id=$2 AND type='mailbox_reconnect_required' AND body=$3 AND read_at IS NULL)`, [randomUUID(), workspaceId, notificationBody]);
            }
          }
          await connection.query("COMMIT");
        } else {
          await connection.query("ROLLBACK");
        }
      } catch (error) {
        await connection.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        connection.release();
      }
    }
  }
}
