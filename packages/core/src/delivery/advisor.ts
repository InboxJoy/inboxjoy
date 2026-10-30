import { schema, type InboxJoyDb } from "@inboxjoy/db";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";

import { campaignDisplayStatus, campaignDisplayStatuses, type CampaignDisplayStatus, type CampaignStatusReason } from "../campaign-status.js";
import { readSequenceMailboxIds } from "../sequence-mailboxes.js";
import type { Edition } from "../edition.js";
import { FREE_PLAN_MONTHLY_SEND_LIMIT, freePlanMonthlySendsSql, freePlanMonthResetsAt, planAllowsCampaignSends, sendingPlan, warmupDailyLimit, UNHEALTHY_MAILBOX_STATES, type MailboxHealthState } from "./can-send.js";
import { providerCircuitKeySql } from "./circuit.js";

// Read-only projection over existing campaign/mailbox/message state for the
// delivery advisor card (docs/delivery-advisor-plan.md, Phase 1A). This file
// performs no writes, no enqueue, no provider calls and no capacity/probe
// reservation. It mirrors the accounting the worker already performs in
// apps/worker/src/jobs/send-message.ts (accepted + in-flight + unknown-result
// + manual-reply counts) rather than reading mailbox_daily_usage, which only
// reflects accepted sends. It must not be imported by apps/worker.

const PENDING_ENROLLMENT_STATUSES = ["scheduled", "active", "paused"] as const;
const SCHEDULABLE_MESSAGE_STATUSES = ["scheduled", "retryable"] as const;
const STATEMENT_TIMEOUT_MS = 2_000;
const RECORDED_BLOCKER_LIMIT = 5;

export type DeliveryAdvisorFindingSeverity = "info" | "warning" | "danger";
export type DeliveryAdvisorFindingSource = "observed" | "recorded";
// Navigation targets are an allowlist, not a URL: the caller (UI) maps each
// value to an actual route. The server never returns a link.
export type DeliveryAdvisorNavigationTarget = "mailboxes" | "billing" | "sequence";

export type DeliveryAdvisorFinding = {
  code: string;
  severity: DeliveryAdvisorFindingSeverity;
  source: DeliveryAdvisorFindingSource;
  observedAt: string;
  message: string;
  navigationTarget: DeliveryAdvisorNavigationTarget | null;
};

export type DeliveryAdvisorSenderCapacity = {
  dailyLimit: number;
  hourlyLimit: number;
  effectiveDailyLimit: number | null;
  warmupDailyLimit: number | null;
  sentToday: number | null;
  sentLastHour: number | null;
  remainingToday: number | null;
  remainingThisHour: number | null;
};

export type DeliveryAdvisorSender = {
  emailAccountId: string;
  email: string | null;
  status: string;
  healthState: string | null;
  throttledUntil: string | null;
  providerCircuitState: string | null;
  pendingEnrollments: number;
  capacity: DeliveryAdvisorSenderCapacity | null;
};

export type DeliveryAdvisorWorkspaceCapacity = {
  dailySendCap: number;
  sentToday: number | null;
  remainingToday: number | null;
};

export type DeliveryAdvisorSnapshot = {
  campaignId: string;
  asOf: string;
  completeness: "complete" | "partial";
  campaign: {
    name: string;
    status: string;
    displayStatus: CampaignDisplayStatus;
    statusReason: CampaignStatusReason;
  };
  findings: DeliveryAdvisorFinding[];
  senders: DeliveryAdvisorSender[];
  workspaceCapacity: DeliveryAdvisorWorkspaceCapacity | null;
  nextScheduledAt: string | null;
  // A paused campaign/sequence can retain a pending timestamp; this says so
  // beside the reading instead of implying a live, unconditional send.
  nextScheduledNote: "campaign_paused" | "sequence_paused" | null;
};

export type DeliveryAdvisorResult =
  | { found: false }
  | { found: true; status: "ready" | "partial"; snapshot: DeliveryAdvisorSnapshot };

export type ReadDeliveryAdvisorInput = {
  workspaceId: string;
  campaignId: string;
  edition: Edition;
  now?: Date;
};

async function rows<Row>(tx: Pick<InboxJoyDb, "execute">, statement: ReturnType<typeof sql>): Promise<Row[]> {
  return (await tx.execute(statement)).rows as Row[];
}

// Mirrors manualReplyEventSql in apps/worker/src/jobs/send-message.ts: manual
// Inbox replies reserve shared daily/hourly volume the same way a campaign
// send does. workspaceIdSql/emailAccountIdSql are SQL column references
// (e.g. "m.workspace_id"), never raw values, so this stays injection-safe.
function manualReplyCountSql(options: { workspaceIdSql: string; emailAccountIdSql?: string; range: "today" | "last_hour" }): string {
  const mailboxSql = options.emailAccountIdSql ? ` AND mre.metadata->>'emailAccountId' = ${options.emailAccountIdSql}::text` : "";
  const rangeSql = options.range === "today"
    ? " AND mre.occurred_at::date = (now() AT TIME ZONE 'UTC')::date"
    : " AND mre.occurred_at > now() - interval '1 hour'";
  return `(SELECT count(*)::int FROM message_events mre WHERE mre.workspace_id = ${options.workspaceIdSql} AND mre.event_type IN ('manual_reply_pending','manual_reply_sent')${mailboxSql}${rangeSql})`;
}

// Same three conditions send-message.ts claims against: accepted today/hour,
// still-claimed "sending" rows within their lease, and failed rows whose
// provider result was never confirmed (recent, so they still count toward
// capacity the way the worker treats them). This is the one place other than
// the worker that reasons about effective headroom; keep both in sync.
function usageCaseSql(aliasSql: string, range: "today" | "last_hour"): string {
  // CURRENT_DATE, not a computed UTC date: send-message.ts's dm/hm/wm CASE
  // expressions use CURRENT_DATE for these same accepted/failed windows, and
  // this must resolve to the same day boundary the worker already claimed
  // against, not a second independently-computed one.
  const acceptedWindow = range === "today" ? `${aliasSql}.accepted_at::date = CURRENT_DATE` : `${aliasSql}.accepted_at > now() - interval '1 hour'`;
  const failedWindow = range === "today" ? `${aliasSql}.updated_at::date = CURRENT_DATE` : `${aliasSql}.updated_at > now() - interval '1 hour'`;
  return `((${aliasSql}.status = 'accepted' AND ${acceptedWindow}) OR (${aliasSql}.status = 'sending' AND ${aliasSql}.claim_expires_at > now()) OR (${aliasSql}.status = 'failed' AND ${aliasSql}.error_class = 'unknown_provider_result' AND ${failedWindow}))`;
}

type SenderRow = {
  id: string;
  email: string | null;
  status: string;
  daily_limit: number;
  hourly_limit: number;
  ramp_started_on: string | null;
  ramp_paused_days: number;
  health_state: string | null;
  effective_daily_limit: number | null;
  throttled_until: Date | string | null;
  circuit_state: string | null;
  mailbox_today: number | null;
  mailbox_hour: number | null;
};

async function readSenderRows(tx: Pick<InboxJoyDb, "execute">, workspaceId: string, senderIds: string[]): Promise<SenderRow[]> {
  if (!senderIds.length) return [];
  return rows<SenderRow>(tx, sql`
    SELECT a.id, a.email, a.status::text AS status, a.daily_limit, a.hourly_limit, a.ramp_started_on, a.ramp_paused_days,
      mh.state AS health_state, mh.effective_daily_limit, mh.throttled_until,
      pc.state AS circuit_state,
      ((SELECT count(*)::int FROM messages dm WHERE dm.email_account_id = a.id AND ${sql.raw(usageCaseSql("dm", "today"))})
        + ${sql.raw(manualReplyCountSql({ workspaceIdSql: "a.workspace_id", emailAccountIdSql: "a.id", range: "today" }))}) AS mailbox_today,
      ((SELECT count(*)::int FROM messages hm WHERE hm.email_account_id = a.id AND ${sql.raw(usageCaseSql("hm", "last_hour"))})
        + ${sql.raw(manualReplyCountSql({ workspaceIdSql: "a.workspace_id", emailAccountIdSql: "a.id", range: "last_hour" }))}) AS mailbox_hour
    FROM email_accounts a
    LEFT JOIN mailbox_health mh ON mh.email_account_id = a.id
    LEFT JOIN provider_circuit pc ON pc.provider = ${sql.raw(providerCircuitKeySql("a"))}
    WHERE a.workspace_id = ${workspaceId} AND a.id = ANY(ARRAY[${sql.join(senderIds.map((id) => sql`${id}::uuid`), sql`, `)}])
  `);
}

function senderCapacity(row: SenderRow, now: Date): DeliveryAdvisorSenderCapacity {
  const health = row.health_state ? { state: row.health_state, effectiveDailyLimit: row.effective_daily_limit } : null;
  const effectiveDailyLimit = Math.max(0, health?.state === "healthy" ? row.daily_limit : health?.effectiveDailyLimit ?? row.daily_limit);
  const warmup = warmupDailyLimit(effectiveDailyLimit, row.ramp_started_on, now, row.ramp_paused_days ?? 0);
  const sentToday = row.mailbox_today ?? null;
  const sentLastHour = row.mailbox_hour ?? null;
  return {
    dailyLimit: row.daily_limit,
    hourlyLimit: row.hourly_limit,
    effectiveDailyLimit,
    warmupDailyLimit: warmup,
    sentToday,
    sentLastHour,
    remainingToday: sentToday === null ? null : Math.max(0, warmup - sentToday),
    remainingThisHour: sentLastHour === null ? null : Math.max(0, row.hourly_limit - sentLastHour),
  };
}

function senderFindings(row: SenderRow, now: Date): DeliveryAdvisorFinding[] {
  const label = row.email ?? row.id;
  const observedAt = now.toISOString();
  const findings: DeliveryAdvisorFinding[] = [];
  if (row.status !== "active") {
    findings.push({ code: "mailbox_inactive", severity: "danger", source: "observed", observedAt, message: `${label} is disconnected or inactive.`, navigationTarget: "mailboxes" });
  }
  // Mirrors canSend(): a "throttled" mailbox only blocks while throttled_until
  // is still in the future. An expired (or unset) deadline means sending has
  // resumed, so it must not be reported as a blocker.
  const throttleActive = row.health_state === "throttled" && Boolean(row.throttled_until) && new Date(row.throttled_until!) > now;
  const stillUnhealthy = row.health_state !== "throttled" || throttleActive;
  if (row.health_state && UNHEALTHY_MAILBOX_STATES.has(row.health_state as MailboxHealthState) && stillUnhealthy) {
    findings.push({
      code: `mailbox_${row.health_state}`,
      severity: row.health_state === "degraded" ? "warning" : "danger",
      source: "observed",
      observedAt,
      message: throttleActive ? `${label} is throttled until ${new Date(row.throttled_until!).toISOString()}.` : `${label} is currently ${row.health_state.replace(/_/g, " ")}.`,
      navigationTarget: "mailboxes",
    });
  }
  if (row.circuit_state === "open" || row.circuit_state === "half_open") {
    findings.push({ code: "provider_circuit_open", severity: "warning", source: "observed", observedAt, message: `The provider connection for ${label} is temporarily paused after repeated failures.`, navigationTarget: "mailboxes" });
  }
  return findings;
}

type RecordedBlockerRow = { blocked_reason: string; updated_at: Date | string; email: string | null };

async function readRecordedBlockers(tx: Pick<InboxJoyDb, "execute">, workspaceId: string, campaignId: string): Promise<RecordedBlockerRow[]> {
  return rows<RecordedBlockerRow>(tx, sql`
    SELECT m.blocked_reason, m.updated_at, a.email
    FROM messages m
    JOIN enrollments e ON e.id = m.enrollment_id
    LEFT JOIN email_accounts a ON a.id = m.email_account_id
    WHERE e.workspace_id = ${workspaceId} AND e.campaign_id = ${campaignId}
      AND m.status = 'cancelled' AND m.blocked_reason IS NOT NULL
    ORDER BY m.updated_at DESC
    LIMIT ${RECORDED_BLOCKER_LIMIT}
  `);
}

export async function readDeliveryAdvisor(db: InboxJoyDb, input: ReadDeliveryAdvisorInput): Promise<DeliveryAdvisorResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    // Read-only, bounded, no locks: this projection must never contend with
    // or slow down a real send.
    await tx.execute(sql`SET LOCAL statement_timeout = ${sql.raw(String(STATEMENT_TIMEOUT_MS))}`);
    await tx.execute(sql`SET TRANSACTION READ ONLY`);

    const [campaign] = await tx.select({
      id: schema.campaigns.id,
      name: schema.campaigns.name,
      status: schema.campaigns.status,
      sequenceId: schema.campaigns.sequenceId,
      emailAccountId: schema.campaigns.emailAccountId,
    }).from(schema.campaigns).where(and(eq(schema.campaigns.id, input.campaignId), eq(schema.campaigns.workspaceId, input.workspaceId)));
    if (!campaign) return { found: false };

    const [sequenceRow] = await tx.select({ status: schema.sequences.status }).from(schema.sequences)
      .where(and(eq(schema.sequences.id, campaign.sequenceId), eq(schema.sequences.workspaceId, input.workspaceId)));

    let partial = false;
    const findings: DeliveryAdvisorFinding[] = [];
    const observedAt = now.toISOString();

    // --- Workspace/owner/billing observed conditions (shared canonical helper). ---
    const [workspaceRow] = await tx.select({
      status: schema.workspaces.status,
      killSwitchEnabled: schema.workspaces.killSwitchEnabled,
      dailySendCap: schema.workspaces.dailySendCap,
      legacyFreeUntil: schema.workspaces.legacyFreeUntil,
    }).from(schema.workspaces).where(eq(schema.workspaces.id, input.workspaceId));
    const [subscriptionRow] = await tx.select({
      status: schema.subscriptions.status,
      trialEnd: schema.subscriptions.trialEnd,
      updatedAt: schema.subscriptions.updatedAt,
    }).from(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, input.workspaceId));
    const [ownerRow] = await rows<{ email_verified: boolean }>(tx, sql`
      SELECT COALESCE((SELECT au.email_verified FROM memberships mem
        JOIN auth_users au ON au.id = mem.user_id
        WHERE mem.workspace_id = ${input.workspaceId} AND mem.role = 'owner' AND mem.status = 'active'
        ORDER BY mem.created_at LIMIT 1), false) AS email_verified
    `);

    if (workspaceRow) {
      if (!ownerRow?.email_verified) {
        findings.push({ code: "email_unverified", severity: "danger", source: "observed", observedAt, message: "The workspace owner hasn't verified their email yet. Sending is blocked until they do.", navigationTarget: null });
      }
      if (workspaceRow.killSwitchEnabled) {
        findings.push({ code: "kill_switch", severity: "danger", source: "observed", observedAt, message: "This workspace's sending is turned off.", navigationTarget: null });
      }
      if (workspaceRow.status !== "active") {
        findings.push({ code: "workspace_inactive", severity: "danger", source: "observed", observedAt, message: "This workspace is paused.", navigationTarget: null });
      }
      // The same sendingPlan() canSend() reads (self-host is always entitled).
      const plan = sendingPlan({
        edition: input.edition,
        subscription: subscriptionRow
          ? { status: subscriptionRow.status, trialEnd: subscriptionRow.trialEnd, onHoldGraceEndsAt: new Date(subscriptionRow.updatedAt.getTime() + 7 * 86_400_000) }
          : null,
        legacyFreeUntil: workspaceRow.legacyFreeUntil,
      }, now);
      if (plan === "unlicensed") {
        findings.push({ code: "payment_required", severity: "danger", source: "observed", observedAt, message: "Campaign sending needs the $79 lifetime license. Emails wait and go out once you get it.", navigationTarget: "billing" });
      } else if (plan === "legacy_free" && workspaceRow.legacyFreeUntil) {
        const [usage] = await rows<{ sends: string }>(tx, sql`
          SELECT ${sql.raw(freePlanMonthlySendsSql({ workspaceIdSql: "w.id" }))}::text AS sends FROM workspaces w WHERE w.id = ${input.workspaceId}
        `);
        const day = (date: Date) => date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
        const limit = FREE_PLAN_MONTHLY_SEND_LIMIT.toLocaleString("en-US");
        const endsOn = day(workspaceRow.legacyFreeUntil);
        const resetsAt = freePlanMonthResetsAt(now);
        if (!planAllowsCampaignSends(plan, Number(usage?.sends ?? 0))) {
          const message = resetsAt < workspaceRow.legacyFreeUntil
            ? `The free plan's ${limit} monthly sends are used up. Sending resumes ${day(resetsAt)} until the free plan ends ${endsOn}, or get the $79 lifetime license to keep going.`
            : `The free plan's ${limit} monthly sends are used up and the free plan ends ${endsOn}. Get the $79 lifetime license to keep sending.`;
          findings.push({ code: "free_monthly_cap", severity: "danger", source: "observed", observedAt, message, navigationTarget: "billing" });
        } else {
          findings.push({ code: "legacy_free_ending", severity: "info", source: "observed", observedAt, message: `The free plan sends up to ${limit} emails a month until ${endsOn}. After that, campaign sending needs the $79 lifetime license.`, navigationTarget: "billing" });
        }
      }
    } else {
      partial = true;
    }

    if (sequenceRow?.status === "paused") {
      findings.push({ code: "sequence_paused", severity: "warning", source: "observed", observedAt, message: "The sequence behind this campaign is paused.", navigationTarget: "sequence" });
    } else if (sequenceRow?.status === "archived") {
      findings.push({ code: "sequence_archived", severity: "info", source: "observed", observedAt, message: "The sequence behind this campaign is archived and can't send again.", navigationTarget: "sequence" });
    } else if (!sequenceRow) {
      partial = true;
    }

    if (campaign.status === "paused") {
      findings.push({ code: "campaign_paused", severity: "warning", source: "observed", observedAt, message: "This campaign is paused.", navigationTarget: null });
    } else if (campaign.status === "draft") {
      findings.push({ code: "campaign_draft", severity: "info", source: "observed", observedAt, message: "This campaign hasn't launched yet.", navigationTarget: null });
    } else if (campaign.status === "archived") {
      findings.push({ code: "campaign_archived", severity: "info", source: "observed", observedAt, message: "This campaign is archived.", navigationTarget: null });
    } else if (campaign.status === "completed") {
      findings.push({ code: "campaign_finished", severity: "info", source: "observed", observedAt, message: "This campaign has finished sending to its enrolled leads.", navigationTarget: null });
    }

    // --- Senders: distinct mailboxes actually pinned to pending enrollments,
    // falling back to the campaign's own selected sender when nothing is
    // pending yet. Each mailbox is reported on its own so an unrelated
    // healthy mailbox can never mask a selected failed one. ---
    const pendingSenderRows = await tx.select({
      emailAccountId: schema.enrollments.emailAccountId,
      pendingCount: sql<number>`count(*)`.mapWith(Number),
    }).from(schema.enrollments).where(and(
      eq(schema.enrollments.workspaceId, input.workspaceId),
      eq(schema.enrollments.campaignId, campaign.id),
      inArray(schema.enrollments.status, [...PENDING_ENROLLMENT_STATUSES]),
      isNotNull(schema.enrollments.emailAccountId),
    )).groupBy(schema.enrollments.emailAccountId);

    const pendingByMailbox = new Map(pendingSenderRows.map((row) => [row.emailAccountId as string, row.pendingCount]));
    let senderIds: string[];
    if (pendingByMailbox.size) {
      senderIds = [...pendingByMailbox.keys()];
    } else {
      // Nothing has reached a mailbox yet (e.g. a draft campaign): show the
      // campaign's configured sender plus any explicit saved sequence
      // rotation, so a failed rotation mailbox is never hidden just because
      // no enrollment has been pinned to it yet.
      let savedMailboxIds: string[] = [];
      try {
        savedMailboxIds = await readSequenceMailboxIds(tx, input.workspaceId, campaign.sequenceId);
      } catch {
        partial = true;
      }
      senderIds = [...new Set([campaign.emailAccountId, ...savedMailboxIds])];
    }

    let senderRows: SenderRow[] = [];
    try {
      senderRows = await readSenderRows(tx, input.workspaceId, senderIds);
    } catch {
      partial = true;
    }
    const foundSenderIds = new Set(senderRows.map((row) => row.id));
    for (const missingId of senderIds) if (!foundSenderIds.has(missingId)) partial = true;

    const senders: DeliveryAdvisorSender[] = senderRows
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((row) => {
        findings.push(...senderFindings(row, now));
        let capacity: DeliveryAdvisorSenderCapacity | null = null;
        try {
          capacity = senderCapacity(row, now);
        } catch {
          partial = true;
        }
        return {
          emailAccountId: row.id,
          email: row.email,
          status: row.status,
          healthState: row.health_state,
          throttledUntil: row.throttled_until ? new Date(row.throttled_until).toISOString() : null,
          providerCircuitState: row.circuit_state,
          pendingEnrollments: pendingByMailbox.get(row.id) ?? 0,
          capacity,
        };
      });

    // --- Workspace-level shared capacity (all campaigns + manual replies). ---
    let workspaceCapacity: DeliveryAdvisorWorkspaceCapacity | null = null;
    if (workspaceRow) {
      try {
        const [usageRow] = await rows<{ workspace_today: number }>(tx, sql`
          SELECT (
            (SELECT count(*)::int FROM messages wm WHERE wm.workspace_id = ${input.workspaceId} AND ${sql.raw(usageCaseSql("wm", "today"))})
            + (SELECT count(*)::int FROM message_events mre WHERE mre.workspace_id = ${input.workspaceId}
                AND mre.event_type IN ('manual_reply_pending','manual_reply_sent')
                AND mre.occurred_at::date = (now() AT TIME ZONE 'UTC')::date)
          ) AS workspace_today
        `);
        const sentToday = usageRow?.workspace_today ?? null;
        workspaceCapacity = {
          dailySendCap: workspaceRow.dailySendCap,
          sentToday,
          remainingToday: sentToday === null ? null : Math.max(0, workspaceRow.dailySendCap - sentToday),
        };
      } catch {
        partial = true;
      }
    }

    // --- Historical blocked reasons: recorded, timestamped, never presented
    // as a freshly observed condition. ---
    try {
      const blockers = await readRecordedBlockers(tx, input.workspaceId, campaign.id);
      for (const blocker of blockers) {
        const label = blocker.email ?? "a sender";
        findings.push({
          code: `recorded_${blocker.blocked_reason}`,
          severity: "info",
          source: "recorded",
          observedAt: new Date(blocker.updated_at).toISOString(),
          message: `A message for ${label} was previously blocked: ${blocker.blocked_reason}.`,
          navigationTarget: null,
        });
      }
    } catch {
      partial = true;
    }

    // --- Next recorded scheduled message. Draft campaigns have no forecast;
    // a finished/archived campaign cannot imply a legitimate upcoming send. ---
    let nextScheduledAt: string | null = null;
    if (campaign.status === "active" || campaign.status === "paused") {
      try {
        const [nextRow] = await tx.select({ nextScheduledAt: sql<Date | null>`min(${schema.messages.scheduledAt})` })
          .from(schema.messages)
          .innerJoin(schema.enrollments, eq(schema.messages.enrollmentId, schema.enrollments.id))
          .where(and(
            eq(schema.enrollments.workspaceId, input.workspaceId),
            eq(schema.enrollments.campaignId, campaign.id),
            inArray(schema.messages.status, [...SCHEDULABLE_MESSAGE_STATUSES]),
          ));
        nextScheduledAt = nextRow?.nextScheduledAt ? new Date(nextRow.nextScheduledAt).toISOString() : null;
      } catch {
        partial = true;
      }
    }
    const nextScheduledNote: "campaign_paused" | "sequence_paused" | null = !nextScheduledAt
      ? null
      : campaign.status === "paused"
        ? "campaign_paused"
        : sequenceRow?.status === "paused"
          ? "sequence_paused"
          : null;

    const display = (await campaignDisplayStatuses(tx, input.workspaceId, [{ id: campaign.id, status: campaign.status, sequenceId: campaign.sequenceId }], input.edition)).get(campaign.id)
      ?? campaignDisplayStatus({ status: campaign.status, sendingEnabled: false, sequenceStatus: sequenceRow?.status ?? null, inProgress: 0, mailboxPaused: 0, failurePaused: 0 });

    const snapshot: DeliveryAdvisorSnapshot = {
      campaignId: campaign.id,
      asOf: observedAt,
      completeness: partial ? "partial" : "complete",
      campaign: { name: campaign.name, status: campaign.status, displayStatus: display.displayStatus, statusReason: display.statusReason },
      findings,
      senders,
      workspaceCapacity,
      nextScheduledAt,
      nextScheduledNote,
    };
    return { found: true, status: partial ? "partial" : "ready", snapshot };
  });
}
