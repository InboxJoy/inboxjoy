import { schema, type InboxJoyDb } from "@inboxjoy/db";
export { encryptSecret, decryptSecret, secretKeyVersion, buildSecretKeyMap } from "./crypto/secret-box.js";
export { MailboxCredentialsError, readMailboxCredentials, writeMailboxCredentials, type MailboxCredentials, type MailboxCredentialsWithSecrets, type MailboxConnection, type MailboxConnectionWithSecret } from "./mailbox-credentials.js";
import { appendUnsubscribeFooter, createUnsubscribeToken, type TransactionalEmailService } from "@inboxjoy/email";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { FREE_PLAN_CONTACT_LIMIT, FREE_PLAN_MONTHLY_SEND_LIMIT, freePlanMonthlySendsSql, freePlanMonthResetsAt, hasSendingEntitlement, planAllowsCampaignSends, sendingPlan, warmupDailyLimit, warmupFullOn } from "./delivery/can-send.js";
import { isCloudEdition, type Edition } from "./edition.js";
import { createSequenceDraftClient, refineStepInputSchema, refineStepOutputSchema, resolveAIProvider, sequenceDraftInputSchema, sequenceDraftOutputSchema, validateRefinedStep, type SequenceDraftClient } from "./ai.js";
import { createMcpOperations, type ReplySender } from "./mcp-ops.js";
import { reassignWaitingEnrollments } from "./mailbox-removal.js";
import type { MailboxProvider } from "./mailbox-provider.js";
import { createSendingAnalyticsOperations } from "./sending-analytics.js";
import { isSendableSequenceMailbox, sequenceMailboxIdsSchema } from "./sequence-mailboxes.js";
import { emptySkippedLeadIds, findEligibleEnrollmentAudience } from "./enrollment-eligibility.js";
import { campaignDisplayStatuses, deriveSequenceDisplay, reconcileCampaignStatus } from "./campaign-status.js";
import { enrollNewListLeads } from "./enroll-new-list-leads.js";
import { retryTransaction } from "./transaction-retry.js";
import { renderTemplate, type LeadVariableSource, type RenderOptions } from "./template-variables.js";
import { refreshPendingOnResume } from "./resume-pending.js";
import { isCustomVariablesEnforced, loadLeadVariables } from "./lead-variables.js";
import { assertLaunchAudienceComplete, loadContactCustomFields, renderTemplateWithPlaceholders } from "./launch-gate.js";
export * from "./template-variables.js";
export * from "./lead-variables.js";
export * from "./lead-variables-view.js";
export { assertAudienceHasVariables, assertLaunchAudienceComplete, EMPTY_MISSING_VARIABLES, launchAudienceContactIds, loadContactCustomFields, missingVariablesMessage, renderTemplateWithPlaceholders, summarizeMissingVariables, type MissingVariablesSummary } from "./launch-gate.js";
import { AFFILIATE_HOLD_DAYS, ensureAffiliateCode } from "./affiliate.js";
import { findWorkspaceLifetimePayment, grantLifetimeLicense, isLifetimeSubscriptionRow } from "./billing-lifetime.js";
import { releasePlanBlockedSends } from "./billing-release.js";
import { findInvitationByToken, invitationTokenWorkspaceId } from "./invitation-token.js";
export {
  AFFILIATE_COOKIE_DAYS,
  AFFILIATE_COOKIE_NAME,
  AFFILIATE_DEFAULT_COMMISSION_MONTHS,
  AFFILIATE_DEFAULT_COMMISSION_PERCENT,
  AFFILIATE_HOLD_DAYS,
  affiliateCodePattern,
  attributeReferral,
  ensureAffiliateCode,
  listAffiliatePayoutsDue,
  markAffiliateCommissionsPaid,
  normalizeAffiliateCode,
  recordAffiliateClick,
  recordAffiliateCommission,
  reverseAffiliateCommission,
  setAffiliateCommission,
} from "./affiliate.js";
export type { AffiliateCodeInfo, AffiliateDb, AffiliatePayoutDue } from "./affiliate.js";
export { describeWorkspaceSubscription, expireCompSubscriptions, grantCompSubscription } from "./billing-comp.js";
export type { CompDb, GrantCompSubscriptionInput, GrantCompSubscriptionResult, WorkspaceSubscriptionDescription } from "./billing-comp.js";
export { findWorkspaceLifetimePayment, grantLifetimeLicense, isLifetimePayment, isLifetimeSubscriptionRow, lifetimePaymentWorkspaceId, revokeLifetimeLicense } from "./billing-lifetime.js";
export { retryTransaction } from "./transaction-retry.js";
export { findInvitationByToken, invitationTokenWorkspaceId, type InvitationRow } from "./invitation-token.js";
export { isCloudEdition, type Edition } from "./edition.js";
export {
  bounceClassifications,
  classifyBounceWebhook,
  classifyReplyIntent,
  extractMailboxCandidateEmails,
  extractReplyContent,
  extractSenderEmail,
  extractSuppressibleRecipientEmails,
  isAutoReply,
  isBounceWebhook,
  isComplaintWebhook,
  isPermanentBounce,
  stripQuotedReply,
} from "./inbound/classify.js";
export type { BounceClassification, ExtractedReplyContent, ReplyIntent } from "./inbound/classify.js";
export { ingestInboundEvent } from "./inbound/ingest-inbound-event.js";
export type { InboundEvent, IngestOptions } from "./inbound/ingest-inbound-event.js";
export { writeInboundReply, writeWebhookSuppressions } from "./inbound/write-reply.js";
export { applySuppression, type ApplySuppressionInput } from "./suppression.js";
export { MAILBOX_PROVIDERS, assertComposioProvider, isComposioProvider } from "./mailbox-provider.js";
export type { MailboxProvider, ComposioProvider } from "./mailbox-provider.js";
export { providerCircuitKey, providerCircuitKeySql } from "./delivery/circuit.js";
export type { MailClient, FetchedReply } from "./delivery/mail-client.js";
export { readDeliveryAdvisor } from "./delivery/advisor.js";
export type {
  DeliveryAdvisorResult,
  DeliveryAdvisorSnapshot,
  DeliveryAdvisorFinding,
  DeliveryAdvisorFindingSeverity,
  DeliveryAdvisorFindingSource,
  DeliveryAdvisorNavigationTarget,
  DeliveryAdvisorSender,
  DeliveryAdvisorSenderCapacity,
  DeliveryAdvisorWorkspaceCapacity,
} from "./delivery/advisor.js";
export { MACHINE_FORBIDDEN_FIELDS, MCP_ADMIN_OPERATIONS, machineForbiddenField, operationAvailableInEdition } from "./mcp-admin-operations.js";
export { removeMailbox } from "./mailbox-removal.js";
export type { ReplySender } from "./mcp-ops.js";
export { enrollNewListLeads } from "./enroll-new-list-leads.js";
export type { CampaignUpdate, CampaignEnrollmentBlockedReason } from "./enroll-new-list-leads.js";
export { reconcileCampaignStatus, campaignDisplayStatuses } from "./campaign-status.js";
export type { CampaignStatusChange, CampaignStatusExecutor, CampaignStatusResult, CampaignDisplayStatus, CampaignStatusReason } from "./campaign-status.js";
export { dailySeries } from "./sending-analytics.js";
export { AzureOpenAIClient, createAzureOpenAIClient, createOpenAICompatibleClient, createSequenceDraftClient, DEFAULT_AI_BASE_URL, OpenAICompatibleClient, refineStepActionSchema, refineStepInputSchema, refineStepOutputSchema, resolveAIProvider, sequenceDraftInputSchema, sequenceDraftOutputSchema, sequenceEmailContentSchema, sequenceEmailWordCount, validateRefinedStep } from "./ai.js";
export type { AIProvider, AIProviderSettings, RefineStepAction, RefineStepInput, RefineStepOutput, SequenceDraft, SequenceDraftClient, SequenceDraftInput } from "./ai.js";
export { canSend, entitlingSubscriptionSql, FREE_PLAN_CONTACT_LIMIT, FREE_PLAN_MONTHLY_SEND_LIMIT, freePlanMonthlySendsSql, freePlanMonthResetsAt, hasSendingEntitlement, PAYMENT_REQUIRED_RETRY_MS, planAllowsCampaignSends, sendingPlan, UNHEALTHY_MAILBOX_STATES, unlicensedWorkspaceSql, warmupDailyLimit, warmupFullOn } from "./delivery/can-send.js";
export type { CanSendContext, CanSendInput, CanSendResult, DenyReason, MailboxHealthState, ProviderCircuitState, SendingPlan } from "./delivery/can-send.js";
export { CLOUD_MESSAGE_ID_DOMAIN, messageIdDomain, rfcMessageId } from "./delivery/message-id.js";
export { PLAN_BLOCKED_REASONS, releasePlanBlockedSends } from "./billing-release.js";
export { mailboxHealthAfterFailure, mailboxHealthAfterSuccess, PROVIDER_CIRCUIT_FAILURE_THRESHOLD } from "./delivery/health.js";
export type { MailboxFailureKind, MailboxHealthSnapshot } from "./delivery/health.js";
export { ZodError } from "zod";

export type OperationContext = {
  db: InboxJoyDb;
  workspaceId: string;
  userId: string;
  env: {
    // Which product this deployment is.
    // Required so no construction site can silently fall back to either one.
    edition: Edition;
    authSecret: string;
    apiBaseUrl: string;
    webBaseUrl?: string;
    dodoPaymentsApiKey?: string;
    dodoProductLifetime?: string;
    azureOpenAIEndpoint?: string;
    azureOpenAIDeployment?: string;
    // OpenAI-compatible AI (AI_API_KEY / AI_MODEL / AI_BASE_URL); wins over Azure when set.
    aiApiKey?: string;
    aiModel?: string;
    aiBaseUrl?: string;
  };
  billing?: BillingClient;
  ai?: SequenceDraftClient;
  transactionalEmail?: TransactionalEmailService;
  composio?: ReplySender;
  mailClientFor?: (mailbox: { provider: MailboxProvider; emailAccountId: string }) => ReplySender | Promise<ReplySender>;
  logger?: {
    info: (details: unknown, message?: string) => void;
    warn?: (details: unknown, message?: string) => void;
  };
};

export type EnrollSequenceInput = {
  id: string;
  leadIds?: string[];
  listIds?: string[];
  listId?: string;
  listName?: string;
  inboxId?: string;
  inboxIds?: string[];
  campaignId?: string;
  // Internal: staged-queue conversion already re-queues leads that skip for missing values.
  skipMissingVariablesQueue?: boolean;
  // Internal: staged-queue conversion. Only leads whose queue row still exists at commit time
  // enroll, and that row is removed in the same transaction as the enrollment it becomes.
  fromStagedQueue?: boolean;
};

async function resolveEnrollmentContactRows(ctx: OperationContext, input: EnrollSequenceInput) {
  const ids = input.leadIds ?? [];
  if (input.listIds !== undefined && input.listId !== undefined) throw new OpError("BAD_INPUT", "Provide either listIds or the legacy listId, not both.");
  const selectedListIds = input.listIds !== undefined ? input.listIds : input.listId ? [input.listId] : [];
  if (selectedListIds.length) {
    const lists = await ctx.db.select({ id: schema.contactLists.id }).from(schema.contactLists).where(and(
      eq(schema.contactLists.workspaceId, ctx.workspaceId),
      inArray(schema.contactLists.id, selectedListIds),
    ));
    if (lists.length !== selectedListIds.length) throw new OpError("NOT_FOUND", "One or more contact lists were not found in this workspace.");
  }
  const listName = input.listName?.trim() ?? "";
  const contactRows = selectedListIds.length
    ? await ctx.db.selectDistinct({ id: schema.contacts.id, email: schema.contacts.email, normalizedEmail: schema.contacts.normalizedEmail, firstName: schema.contacts.firstName, lastName: schema.contacts.lastName, company: schema.contacts.company, title: schema.contacts.title, status: schema.contacts.status }).from(schema.contactListMembers).innerJoin(schema.contacts, eq(schema.contactListMembers.contactId, schema.contacts.id)).where(and(eq(schema.contactListMembers.workspaceId, ctx.workspaceId), inArray(schema.contactListMembers.contactListId, selectedListIds), eq(schema.contacts.workspaceId, ctx.workspaceId)))
    : ids.length
      ? await ctx.db.select().from(schema.contacts).where(and(eq(schema.contacts.workspaceId, ctx.workspaceId), inArray(schema.contacts.id, ids)))
      : listName ? (await readLeads(ctx)).filter((lead) => lead.listName === listName).map((lead) => ({ ...lead, status: lead.status === "Suppressed" ? "suppressed" : lead.status === "Replied" ? "replied" : lead.status === "Enrolled" ? "enrolled" : lead.status === "Bounced" ? "bounced" : lead.status === "Unsubscribed" ? "unsubscribed" : "active" })) : [];
  return { contactRows, selectedListIds, ids };
}

// Postgres has a 65,535 bound-parameter limit per statement; chunk bulk
// inserts so a very large list/import staged at once can't exceed it.
const STAGED_INSERT_CHUNK_SIZE = 1000;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

// A draft sequence has no frozen version to pin messages/analytics to, so
// enrollment is queued instead of scheduled. `sequences.publish` converts
// queued rows into real enrollments through this same function, reusing its
// eligibility, suppression, caps and warm-up handling rather than a parallel
// enrollment path. Unpublishing (archiving) or deleting the draft discards
// the queue; see sequences.archive and sequences.delete.
//
// Each staged row also records which campaign (if any) and which explicit
// sender mailboxes the request was for, resolved here the same way direct
// enrollment resolves them, so conversion can attribute and send exactly as
// the caller asked instead of silently falling back to campaign-less,
// rotation-only enrollment. A draft sequence's campaigns are always
// themselves still draft (a campaign cannot go active before its sequence is
// published), so unlike direct enrollment this does not exclude draft
// campaigns from auto-attach — there is nothing else a drafted campaign's
// queue could be for.
async function stageSequenceEnrollment(ctx: OperationContext, input: EnrollSequenceInput, sequence: Awaited<ReturnType<typeof sequenceFor>>) {
  const { contactRows } = await resolveEnrollmentContactRows(ctx, input);
  if (!contactRows.length) return { sequence, enrolled: 0, leadIds: [], skipped: {}, skippedLeadIds: emptySkippedLeadIds(), restarted: false, queued: 0, message: "No eligible leads were found." };

  let campaignId: string | undefined = input.campaignId;
  if (campaignId) {
    const [campaign] = await ctx.db.select({ id: schema.campaigns.id, sequenceId: schema.campaigns.sequenceId, status: schema.campaigns.status }).from(schema.campaigns).where(and(eq(schema.campaigns.id, campaignId), eq(schema.campaigns.workspaceId, ctx.workspaceId)));
    if (!campaign) throw new OpError("NOT_FOUND", "Campaign not found.");
    if (campaign.sequenceId !== sequence.id) throw new OpError("BAD_INPUT", "Campaign does not belong to this sequence.");
    if (campaign.status === "archived") throw new OpError("CONFLICT", "Archived campaigns cannot enroll leads.");
  } else {
    const candidates = await ctx.db.select({ id: schema.campaigns.id }).from(schema.campaigns).where(and(eq(schema.campaigns.workspaceId, ctx.workspaceId), eq(schema.campaigns.sequenceId, sequence.id), ne(schema.campaigns.status, "archived"))).limit(2);
    if (candidates.length === 1) campaignId = candidates[0]!.id;
  }

  const requestedInboxIds = input.inboxIds !== undefined ? [...new Set(input.inboxIds)] : input.inboxId ? [input.inboxId] : undefined;
  if (requestedInboxIds?.length) {
    const mailboxes = await ctx.db.select({ id: schema.emailAccounts.id }).from(schema.emailAccounts).where(and(eq(schema.emailAccounts.workspaceId, ctx.workspaceId), inArray(schema.emailAccounts.id, requestedInboxIds)));
    if (mailboxes.length !== requestedInboxIds.length) throw new OpError("BAD_INPUT", "One or more inboxes do not belong to this workspace.");
  }

  const now = new Date();
  const rows = contactRows.map((lead) => ({ id: randomUUID(), workspaceId: ctx.workspaceId, sequenceId: sequence.id, leadId: lead.id, campaignId: campaignId ?? null, inboxIds: requestedInboxIds?.length ? requestedInboxIds : null, createdAt: now }));
  for (const batch of chunk(rows, STAGED_INSERT_CHUNK_SIZE)) await ctx.db.insert(schema.stagedEnrollments).values(batch).onConflictDoNothing();
  const queuedCountRows = await ctx.db.select({ count: sql<number>`count(*)`.mapWith(Number) }).from(schema.stagedEnrollments).where(and(eq(schema.stagedEnrollments.workspaceId, ctx.workspaceId), eq(schema.stagedEnrollments.sequenceId, sequence.id)));
  const queuedCount = queuedCountRows[0]?.count ?? 0;
  return {
    sequence: { ...sequence, queuedCount },
    enrolled: 0,
    leadIds: [],
    skipped: {},
    skippedLeadIds: emptySkippedLeadIds(),
    restarted: false,
    queued: queuedCount,
    message: `Queued: ${queuedCount}. They'll start sending once you publish this sequence.`,
  };
}

type StagedClaim = { leadId: string; campaignId: string | null; inboxIds: string[] | null };
export type StagedGroup = { campaignId: string | null; inboxIds: string[] | null; leadIds: string[] };

function groupStagedClaims(claims: StagedClaim[]): StagedGroup[] {
  const groups = new Map<string, StagedGroup>();
  for (const claim of claims) {
    const inboxKey = claim.inboxIds ? [...claim.inboxIds].sort().join(",") : "";
    const key = `${claim.campaignId ?? ""}|${inboxKey}`;
    const group = groups.get(key) ?? { campaignId: claim.campaignId, inboxIds: claim.inboxIds, leadIds: [] };
    group.leadIds.push(claim.leadId);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export type ConversionAttemptResult = {
  enrolled: number;
  leadIds: string[];
  skipped: Record<string, number>;
  skippedLeadIds?: Partial<Record<string, string[]>>;
  restarted: boolean;
};

export type ConversionGroupResult = {
  enrolled: number;
  leadIds: string[];
  skipped: Partial<Record<string, number>>;
  restarted: boolean;
  blocked?: boolean;
  error?: { code: string; message: string; details?: unknown };
};

export type StagedConversionDeps = {
  attempt: (group: StagedGroup) => Promise<ConversionAttemptResult>;
  // Removes queue rows for leads that will not convert from this queue (e.g. suppressed).
  drop: (group: StagedGroup, leadIds: string[]) => Promise<void>;
  activate: (group: StagedGroup, result: ConversionAttemptResult) => Promise<void>;
};

// Skip reasons that can resolve on their own: those leads stay queued for a later attempt.
const TRANSIENT_STAGED_SKIP_REASONS = ["already_enrolled", "replied", "missing_variables"] as const;

// The control flow for converting a list of staged groups, independent of the concrete
// enroll/drop/activate implementations so it can be unit tested without a database.
//
// Queue rows are never removed before their lead is enrolled: an enrolled lead's row is
// deleted inside the same transaction that writes its enrollment (see fromStagedQueue in
// enrollSequence). So a crash or unexpected error at any point leaves every not-yet-enrolled
// lead queued for the next publish, and nothing ever has to be written back. An OpError
// blocks only its own group (its rows simply stay); an unexpected error stops the loop and is
// rethrown with the remaining groups still queued. After a successful attempt, rows for leads
// that were neither enrolled nor skipped for a transient reason are dropped.
export async function runStagedConversionGroups(groups: StagedGroup[], deps: StagedConversionDeps): Promise<ConversionGroupResult[]> {
  const results: ConversionGroupResult[] = [];
  for (const group of groups) {
    let result: ConversionAttemptResult;
    try {
      result = await deps.attempt(group);
    } catch (error) {
      if (error instanceof OpError) {
        results.push({ enrolled: 0, leadIds: [], skipped: {}, restarted: false, blocked: true, error: { code: error.code, message: error.message, details: error.details } });
        continue;
      }
      throw error;
    }
    const skippedLeadIds = result.skippedLeadIds ?? {};
    const stillQueued = new Set<string>(result.leadIds);
    for (const reason of TRANSIENT_STAGED_SKIP_REASONS) for (const leadId of skippedLeadIds[reason] ?? []) stillQueued.add(leadId);
    await deps.activate(group, result);
    const dropped = group.leadIds.filter((leadId) => !stillQueued.has(leadId));
    if (dropped.length) await deps.drop(group, dropped);
    results.push(result);
  }
  return results;
}

function mergeConversionResults(results: ConversionGroupResult[]) {
  const merged: { enrolled: number; leadIds: string[]; skipped: Record<string, number>; restarted: boolean; blocked: boolean; errors: Array<{ code: string; message: string; details?: unknown }> } = { enrolled: 0, leadIds: [], skipped: {}, restarted: false, blocked: false, errors: [] };
  for (const result of results) {
    merged.enrolled += result.enrolled;
    merged.leadIds.push(...result.leadIds);
    for (const [reason, count] of Object.entries(result.skipped)) merged.skipped[reason] = (merged.skipped[reason] ?? 0) + (count ?? 0);
    if (result.restarted) merged.restarted = true;
    if (result.blocked) {
      merged.blocked = true;
      const error = result.error;
      if (error && !merged.errors.some((existing) => existing.code === error.code && existing.message === error.message)) merged.errors.push(error);
    }
  }
  return merged;
}

// Leads per conversion attempt: keeps every statement inside enrollSequence well under
// Postgres' 65,535 bound-parameter limit however large the queue is.
const STAGED_CONVERSION_BATCH_SIZE = 5000;

// Converts a sequence's queued contacts into real enrollments by calling enrollSequence
// itself (eligibility, suppression, caps, warm-up and campaign attribution all apply exactly
// as a normal enroll).
//
// Queue rows stay stored until their lead is enrolled: the conversion reads the queue, and
// enrollSequence (fromStagedQueue) locks each lead's row, enrolls it and deletes the row in
// one transaction. A restart mid-conversion therefore loses nothing, and a later publish (or
// convertQueuedLeads) converts whatever is left; a lead whose row is gone is never enrolled
// again, so retries cannot double-enroll. A blocked group (no sendable mailbox, unverified
// owner, paused workspace, plan limit, archived campaign) keeps its rows untouched, so there
// is no bulk restore to fail. Concurrent conversions serialize on enrollSequence's sequence
// row lock, and the second finds the first's rows already gone. enrollSequence keeps its own
// transaction; this intentionally does not wrap it in an outer one (nesting two
// independently-managed transactions while both lock the sequence row risks self-deadlock).
async function convertStagedEnrollments(ctx: OperationContext, sequenceId: string, onlyLeadIds?: string[]) {
  if (onlyLeadIds && !onlyLeadIds.length) return null;
  const queued: StagedClaim[] = [];
  for (const batch of onlyLeadIds ? chunk(onlyLeadIds, STAGED_INSERT_CHUNK_SIZE) : [undefined]) {
    queued.push(...await ctx.db.select({ leadId: schema.stagedEnrollments.leadId, campaignId: schema.stagedEnrollments.campaignId, inboxIds: schema.stagedEnrollments.inboxIds }).from(schema.stagedEnrollments).where(and(
      eq(schema.stagedEnrollments.workspaceId, ctx.workspaceId),
      eq(schema.stagedEnrollments.sequenceId, sequenceId),
      batch ? inArray(schema.stagedEnrollments.leadId, batch) : undefined,
    )).orderBy(schema.stagedEnrollments.createdAt, schema.stagedEnrollments.leadId));
  }
  if (!queued.length) return null;

  const now = new Date();
  const groups = groupStagedClaims(queued).flatMap((group) => chunk(group.leadIds, STAGED_CONVERSION_BATCH_SIZE).map((leadIds) => ({ ...group, leadIds })));
  const results = await runStagedConversionGroups(groups, {
    attempt: async (group) => {
      // No explicit sender was requested at staging time: default to the
      // attributed campaign's own chosen mailbox, the same sender precedence
      // campaigns.launch itself uses, rather than falling back to plain rotation.
      let inboxId: string | undefined;
      if (group.campaignId && !group.inboxIds?.length) {
        const [campaignRow] = await ctx.db.select({ emailAccountId: schema.campaigns.emailAccountId }).from(schema.campaigns).where(and(eq(schema.campaigns.id, group.campaignId), eq(schema.campaigns.workspaceId, ctx.workspaceId)));
        inboxId = campaignRow?.emailAccountId;
      }
      return enrollSequence(ctx, { id: sequenceId, leadIds: group.leadIds, campaignId: group.campaignId ?? undefined, inboxId, inboxIds: group.inboxIds ?? undefined, skipMissingVariablesQueue: true, fromStagedQueue: true });
    },
    drop: async (_group, leadIds) => {
      for (const batch of chunk(leadIds, STAGED_INSERT_CHUNK_SIZE)) {
        await ctx.db.delete(schema.stagedEnrollments).where(and(
          eq(schema.stagedEnrollments.workspaceId, ctx.workspaceId),
          eq(schema.stagedEnrollments.sequenceId, sequenceId),
          inArray(schema.stagedEnrollments.leadId, batch),
        ));
      }
    },
    activate: async (group, result) => {
      if (!group.campaignId || result.enrolled <= 0) return;
      await ctx.db.transaction(async (tx) => {
        const activated = await tx.update(schema.campaigns).set({ status: "active", launchedAt: now, updatedAt: now }).where(and(
          eq(schema.campaigns.id, group.campaignId!),
          eq(schema.campaigns.workspaceId, ctx.workspaceId),
          eq(schema.campaigns.status, "draft"),
        )).returning({ id: schema.campaigns.id });
        if (activated.length) await reconcileCampaignStatus(tx, { workspaceId: ctx.workspaceId, campaignId: group.campaignId!, now });
      });
    },
  });
  return mergeConversionResults(results);
}

// Converts queued leads of an already-published sequence once their variable values
// arrive (they were re-queued by a missing_variables skip). Leads still missing values
// are re-queued by the conversion itself, so this is safe to call speculatively.
export async function convertQueuedLeads(ctx: OperationContext, sequenceId: string, leadIds: string[]) {
  const [sequence] = await ctx.db.select({ status: schema.sequences.status }).from(schema.sequences).where(and(eq(schema.sequences.id, sequenceId), eq(schema.sequences.workspaceId, ctx.workspaceId)));
  if (sequence?.status !== "active") return null;
  return convertStagedEnrollments(ctx, sequenceId, [...new Set(leadIds)]);
}

export async function enrollSequence(ctx: OperationContext, input: EnrollSequenceInput) {
  await requireWorkspaceManager(ctx);
  await requireVerifiedWorkspaceOwner(ctx);
  if (!ctx.env.authSecret) throw new OpError("UNAVAILABLE", "Unsubscribe protection is unavailable. Sending remains disabled.");
  const sequence = await sequenceFor(ctx, input.id);
  if (sequence.status === "draft") return await stageSequenceEnrollment(ctx, input, sequence);
  if (sequence.status !== "published") throw new OpError("CONFLICT", "Publish the sequence before enrolling leads.", { blockedReason: "sequence_inactive" });
  const [workspace] = await ctx.db.select().from(schema.workspaces).where(eq(schema.workspaces.id, ctx.workspaceId));
  if (!workspace || workspace.status !== "active" || workspace.killSwitchEnabled) throw new OpError("CONFLICT", "Sending is paused for this workspace.");
  // Optional by owner decision (2026-09-15): rendered in the unsubscribe
  // footer when present, never a blocker.
  const postalAddress = workspace.postalAddress?.trim() || null;
  const { contactRows, selectedListIds, ids } = await resolveEnrollmentContactRows(ctx, input);
  const usingSavedMailboxes = input.inboxIds === undefined && input.inboxId === undefined && sequence.mailboxIds.length > 0;
  if (!contactRows.length && !usingSavedMailboxes) return { sequence, enrolled: 0, leadIds: [], skipped: { no_candidates: 0 }, skippedLeadIds: emptySkippedLeadIds(), restarted: false, message: "No eligible leads were found." };
  const now = new Date();
  const usageDate = now.toISOString().slice(0, 10);
  const requestedInboxIds = input.inboxIds !== undefined ? [...new Set(input.inboxIds)] : input.inboxId ? [input.inboxId] : usingSavedMailboxes ? sequence.mailboxIds : undefined;
  const mailboxRows = await ctx.db.select({
    id: schema.emailAccounts.id,
    email: schema.emailAccounts.email,
    status: schema.emailAccounts.status,
    dailyLimit: schema.emailAccounts.dailyLimit,
    rampStartedOn: schema.emailAccounts.rampStartedOn,
    rampPausedDays: schema.emailAccounts.rampPausedDays,
    healthState: schema.mailboxHealth.state,
    sentToday: sql<number>`coalesce(${schema.mailboxDailyUsage.acceptedCount}, 0)`.mapWith(Number),
  }).from(schema.emailAccounts)
    .leftJoin(schema.mailboxHealth, eq(schema.mailboxHealth.emailAccountId, schema.emailAccounts.id))
    .leftJoin(schema.mailboxDailyUsage, and(eq(schema.mailboxDailyUsage.emailAccountId, schema.emailAccounts.id), eq(schema.mailboxDailyUsage.usageDate, usageDate)))
    // Deleted ('removed') mailboxes are included on purpose: a campaign's saved sender
    // list keeps them, and isSendableSequenceMailbox below never sends from them.
    .where(eq(schema.emailAccounts.workspaceId, ctx.workspaceId));
  if (requestedInboxIds) {
    const workspaceMailboxIds = new Set(mailboxRows.map((mailbox) => mailbox.id));
    if (requestedInboxIds.some((inboxId) => !workspaceMailboxIds.has(inboxId))) throw new OpError("BAD_INPUT", "One or more inboxes do not belong to this workspace.");
  }
  const requestedInboxIdSet = requestedInboxIds ? new Set(requestedInboxIds) : null;
  const mailboxes = mailboxRows
    .filter((mailbox) => (!requestedInboxIdSet || requestedInboxIdSet.has(mailbox.id)) && isSendableSequenceMailbox(mailbox))
    .map((mailbox) => ({ ...mailbox, remainingToday: Math.max(0, warmupDailyLimit(mailbox.dailyLimit, mailbox.rampStartedOn, now, mailbox.rampPausedDays) - mailbox.sentToday) }))
    .sort((left, right) => right.remainingToday - left.remainingToday || left.id.localeCompare(right.id));
  if (!mailboxes.length) throw new OpError("CONFLICT", usingSavedMailboxes
? "None of the mailboxes selected for this campaign can send right now. Reconnect one or choose other mailboxes."
: "Connect an active Gmail or Outlook inbox before enrolling leads.", { blockedReason: "no_sender" });
  if (!contactRows.length) return { sequence, enrolled: 0, leadIds: [], skipped: { no_candidates: 0 }, skippedLeadIds: emptySkippedLeadIds(), restarted: false, message: "No eligible leads were found." };
  const remainingByMailbox = new Map(mailboxes.map((mailbox) => [mailbox.id, mailbox.remainingToday]));
  let mailboxCursor = 0;
  const nextMailbox = () => {
    if (mailboxes.some((mailbox) => (remainingByMailbox.get(mailbox.id) ?? 0) > 0)) {
      for (let offset = 0; offset < mailboxes.length; offset += 1) {
        const index = (mailboxCursor + offset) % mailboxes.length;
        const mailbox = mailboxes[index]!;
        const remaining = remainingByMailbox.get(mailbox.id) ?? 0;
        if (remaining > 0) {
          remainingByMailbox.set(mailbox.id, remaining - 1);
          mailboxCursor = (index + 1) % mailboxes.length;
          return mailbox;
        }
      }
    }
    const mailbox = mailboxes[mailboxCursor]!;
    mailboxCursor = (mailboxCursor + 1) % mailboxes.length;
    return mailbox;
  };
  const [storedSequence] = await ctx.db.select().from(schema.sequences).where(and(eq(schema.sequences.id, sequence.id), eq(schema.sequences.workspaceId, ctx.workspaceId)));
  if (!storedSequence?.currentVersionId) throw new OpError("CONFLICT", "This sequence has no published version.");
  if (!input.campaignId) {
    const campaigns = await ctx.db.select({ id: schema.campaigns.id, status: schema.campaigns.status }).from(schema.campaigns).where(and(eq(schema.campaigns.workspaceId, ctx.workspaceId), eq(schema.campaigns.sequenceId, storedSequence.id), ne(schema.campaigns.status, "archived"))).limit(2);
    // A draft campaign has not launched: attaching would hold these sends until
    // launch and then release them with stale copy, so they stay campaign-less.
    if (campaigns.length === 1 && campaigns[0]!.status !== "draft") input = { ...input, campaignId: campaigns[0]!.id };
  }
  if (input.campaignId) {
    const [campaign] = await ctx.db.select({ id: schema.campaigns.id, sequenceId: schema.campaigns.sequenceId, status: schema.campaigns.status }).from(schema.campaigns).where(and(eq(schema.campaigns.id, input.campaignId), eq(schema.campaigns.workspaceId, ctx.workspaceId)));
    if (!campaign) throw new OpError("NOT_FOUND", "Campaign not found.");
    if (campaign.sequenceId !== storedSequence.id) throw new OpError("BAD_INPUT", "Campaign does not belong to this sequence.");
    if (campaign.status === "archived") throw new OpError("CONFLICT", "Archived campaigns cannot enroll leads.");
    if (campaign.status === "paused") throw new OpError("CONFLICT", "Resume the campaign before enrolling more leads.", { blockedReason: "campaign_paused" });
  }
  const versionSteps = await ctx.db.select().from(schema.sequenceSteps).where(eq(schema.sequenceSteps.sequenceVersionId, storedSequence.currentVersionId)).orderBy(schema.sequenceSteps.stepOrder);
  const firstStep = versionSteps[0];
  if (!firstStep) throw new OpError("CONFLICT", "Add at least one sequence step before enrolling leads.");
  // Versions published before custom variables shipped render like they always did and gate nothing.
  const [currentVersion] = await ctx.db.select({ enforced: schema.sequenceVersions.customVariablesEnforced }).from(schema.sequenceVersions).where(and(eq(schema.sequenceVersions.id, storedSequence.currentVersionId), eq(schema.sequenceVersions.workspaceId, ctx.workspaceId)));
  const renderOptions = { enforceCustom: currentVersion?.enforced === true };
  const audience = await findEligibleEnrollmentAudience({ db: ctx.db, workspaceId: ctx.workspaceId, sequenceId: storedSequence.id, campaignId: input.campaignId, sequenceVersionId: storedSequence.currentVersionId, listIds: selectedListIds.length ? selectedListIds : undefined, leadIds: selectedListIds.length ? undefined : contactRows.map((lead) => lead.id) });
  const skipped = audience.skipped;
  const skippedLeadIds = audience.skippedLeadIds;
  const eligible = audience.eligible.map((lead) => ({ ...lead, firstName: lead.firstName ?? "", lastName: lead.lastName ?? "", company: lead.company ?? "", title: lead.title ?? "" }));
  const plan = await getWorkspacePlan(ctx);
  // The contact cap belongs to the legacy Free plan only (tier "free"); licensed,
  // comped, self-hosted and unlicensed workspaces enroll without it.
  if (plan.freePlan && eligible.length) {
    const enrolledContacts = await ctx.db.selectDistinct({ contactId: schema.enrollments.contactId }).from(schema.enrollments).where(eq(schema.enrollments.workspaceId, ctx.workspaceId));
    const enrolledContactIds = new Set(enrolledContacts.map((row) => row.contactId));
    const addedContacts = eligible.filter((lead) => !enrolledContactIds.has(lead.id)).length;
    if (enrolledContactIds.size + addedContacts > FREE_PLAN_CONTACT_LIMIT) {
      throw new OpError("plan_limit", `The free plan supports up to ${FREE_PLAN_CONTACT_LIMIT.toLocaleString("en-US")} enrolled contacts. Get the $79 lifetime license to enroll more.`, { limit: FREE_PLAN_CONTACT_LIMIT, current: enrolledContactIds.size, requested: addedContacts });
    }
  }
  const enrolledIds: string[] = [];
  let newEnrollmentCount = 0;
  let restarted = false;
  await ctx.db.transaction(async (tx) => {
    if (input.campaignId) {
      const [lockedCampaign] = await tx.select({ status: schema.campaigns.status }).from(schema.campaigns).where(and(
        eq(schema.campaigns.id, input.campaignId),
        eq(schema.campaigns.workspaceId, ctx.workspaceId),
      )).for("update");
      if (!lockedCampaign) throw new OpError("NOT_FOUND", "Campaign not found.");
      if (lockedCampaign.status === "archived") throw new OpError("CONFLICT", "Archived campaigns cannot enroll leads.");
      if (lockedCampaign.status === "paused") throw new OpError("CONFLICT", "Resume the campaign before enrolling more leads.", { blockedReason: "campaign_paused" });
    }
    const [lockedSequence] = await tx.select({ status: schema.sequences.status, currentVersionId: schema.sequences.currentVersionId }).from(schema.sequences).where(and(eq(schema.sequences.id, storedSequence.id), eq(schema.sequences.workspaceId, ctx.workspaceId))).for("update");
    if (lockedSequence?.status !== "active" || lockedSequence.currentVersionId !== storedSequence.currentVersionId) throw new OpError("CONFLICT", "The sequence changed before enrollment. Try again.", { blockedReason: "sequence_inactive" });
const currentAudience = await findEligibleEnrollmentAudience({ db: tx, workspaceId: ctx.workspaceId, sequenceId: storedSequence.id, campaignId: input.campaignId, sequenceVersionId: storedSequence.currentVersionId, leadIds: eligible.map((lead) => lead.id) });
for (const reason of Object.keys(skipped) as Array<keyof typeof skipped>) {
  skipped[reason] += currentAudience.skipped[reason];
  skippedLeadIds[reason].push(...currentAudience.skippedLeadIds[reason]);
}
    // Staged conversion: lock the queue rows being converted so a concurrent sequences.dequeue
    // either removes a row first (that lead is not enrolled) or waits until this commits. The
    // rows are deleted below in this same transaction, so enrollment and dequeue are atomic.
    if (input.fromStagedQueue && currentAudience.eligible.length) {
      const stillQueued = new Set<string>();
      for (const batch of chunk(currentAudience.eligible.map((contact) => contact.id), STAGED_INSERT_CHUNK_SIZE)) {
        const rows = await tx.select({ leadId: schema.stagedEnrollments.leadId }).from(schema.stagedEnrollments).where(and(
          eq(schema.stagedEnrollments.workspaceId, ctx.workspaceId),
          eq(schema.stagedEnrollments.sequenceId, storedSequence.id),
          inArray(schema.stagedEnrollments.leadId, batch),
        )).orderBy(schema.stagedEnrollments.leadId).for("update");
        for (const row of rows) stillQueued.add(row.leadId);
      }
      currentAudience.eligible = currentAudience.eligible.filter((contact) => stillQueued.has(contact.id));
    }
    // Custom {{variables}}: campaign-scoped values first, then the lead's own custom fields.
    const eligibleIds = currentAudience.eligible.map((contact) => contact.id);
    const variablesByContact = eligibleIds.length ? await loadLeadVariables(tx, ctx.workspaceId, storedSequence.id, eligibleIds) : new Map<string, Record<string, string>>();
    const customFieldsByContact = eligibleIds.length ? await loadContactCustomFields(tx, ctx.workspaceId, eligibleIds) : new Map<string, Record<string, unknown>>();
    // Leads stopped because a variable value was cleared (stop_reason missing_variables) are
    // revived instead of getting a second enrollment, on any version of this sequence: the send
    // history lives on that enrollment, so an edit (new version) made while the lead was stopped
    // never restarts it at step one. A lead that already received mail resumes on its pinned
    // version at the first step it has not received (a cancelled never-sent message is replaced);
    // one that received nothing moves to the current version.
    const revivable = eligibleIds.length ? await tx.select().from(schema.enrollments).where(and(
      eq(schema.enrollments.workspaceId, ctx.workspaceId),
      eq(schema.enrollments.sequenceId, storedSequence.id),
      inArray(schema.enrollments.contactId, eligibleIds),
      eq(schema.enrollments.status, "cancelled"),
      eq(schema.enrollments.stopReason, "missing_variables"),
    )) : [];
    const progressByEnrollment = new Map<string, { sentThrough: number; dueAt: Date | null }>();
    if (revivable.length) {
      const history = await tx.select({ enrollmentId: schema.messages.enrollmentId, stepOrder: schema.sequenceSteps.stepOrder, status: schema.messages.status, blockedReason: schema.messages.blockedReason, scheduledAt: schema.messages.scheduledAt }).from(schema.messages)
        .innerJoin(schema.sequenceSteps, eq(schema.messages.sequenceStepId, schema.sequenceSteps.id))
        .where(and(eq(schema.messages.workspaceId, ctx.workspaceId), inArray(schema.messages.enrollmentId, revivable.map((row) => row.id))));
      for (const row of history) {
        const progress = progressByEnrollment.get(row.enrollmentId) ?? { sentThrough: 0, dueAt: null };
        if (row.status === "cancelled") { if (row.blockedReason === "missing_variables" && row.scheduledAt && (!progress.dueAt || row.scheduledAt > progress.dueAt)) progress.dueAt = row.scheduledAt; }
        else progress.sentThrough = Math.max(progress.sentThrough, row.stepOrder);
        progressByEnrollment.set(row.enrollmentId, progress);
      }
    }
    // One enrollment per contact is revived: one with mail sent first, then one on the current
    // version, then the most recently stopped.
    const revivalRank = (row: typeof revivable[number]) => (progressByEnrollment.get(row.id)?.sentThrough ?? 0) > 0 ? 2 : row.sequenceVersionId === storedSequence.currentVersionId ? 1 : 0;
    const revivableByContact = new Map<string, typeof revivable[number]>();
    for (const row of revivable) {
      const existing = revivableByContact.get(row.contactId);
      if (!existing || (revivalRank(row) - revivalRank(existing) || (row.stoppedAt?.getTime() ?? 0) - (existing.stoppedAt?.getTime() ?? 0)) > 0) revivableByContact.set(row.contactId, row);
    }
    const resumesPinnedVersion = (row: typeof revivable[number] | undefined) => Boolean(row && (progressByEnrollment.get(row.id)?.sentThrough ?? 0) > 0);
    const stepsByVersion = new Map<string, typeof versionSteps>([[storedSequence.currentVersionId!, versionSteps]]);
    const enforcedByVersion = new Map<string, boolean>([[storedSequence.currentVersionId!, renderOptions.enforceCustom]]);
    const pinnedVersionIds = [...new Set([...revivableByContact.values()].filter(resumesPinnedVersion).map((row) => row.sequenceVersionId))].filter((versionId) => !stepsByVersion.has(versionId));
    if (pinnedVersionIds.length) {
      const pinnedSteps = await tx.select().from(schema.sequenceSteps).where(and(eq(schema.sequenceSteps.workspaceId, ctx.workspaceId), inArray(schema.sequenceSteps.sequenceVersionId, pinnedVersionIds))).orderBy(schema.sequenceSteps.stepOrder);
      for (const pinnedStep of pinnedSteps) stepsByVersion.set(pinnedStep.sequenceVersionId, [...(stepsByVersion.get(pinnedStep.sequenceVersionId) ?? []), pinnedStep]);
      const pinnedVersions = await tx.select({ id: schema.sequenceVersions.id, enforced: schema.sequenceVersions.customVariablesEnforced }).from(schema.sequenceVersions).where(and(eq(schema.sequenceVersions.workspaceId, ctx.workspaceId), eq(schema.sequenceVersions.sequenceId, storedSequence.id), inArray(schema.sequenceVersions.id, pinnedVersionIds)));
      for (const pinnedVersion of pinnedVersions) enforcedByVersion.set(pinnedVersion.id, pinnedVersion.enforced === true);
    }
    let revived = 0;
    for (const contact of currentAudience.eligible) {
      const lead = { ...contact, firstName: contact.firstName ?? "", lastName: contact.lastName ?? "", company: contact.company ?? "", title: contact.title ?? "" };
      const variableSource: LeadVariableSource = { ...lead, customFields: customFieldsByContact.get(lead.id) ?? {}, campaignVariables: variablesByContact.get(lead.id) ?? {} };
      const revivedEnrollment = revivableByContact.get(lead.id);
      const progress = revivedEnrollment ? progressByEnrollment.get(revivedEnrollment.id) : undefined;
      // A lead that already received mail stays on the version that sent it.
      const enrollmentVersionId = resumesPinnedVersion(revivedEnrollment) ? revivedEnrollment!.sequenceVersionId : storedSequence.currentVersionId!;
      const enrollmentSteps = stepsByVersion.get(enrollmentVersionId) ?? [];
      const enrollmentRenderOptions = { enforceCustom: enforcedByVersion.get(enrollmentVersionId) === true };
      const step = revivedEnrollment ? enrollmentSteps.find((candidate) => candidate.stepOrder > (progress?.sentThrough ?? 0)) : firstStep;
      if (!step) continue;
      const renderedSubject = renderTemplate(step.subject, variableSource, enrollmentRenderOptions);
      const renderedBody = renderTemplate(step.bodyText, variableSource, enrollmentRenderOptions);
      // A lead that still lacks a variable is left out instead of receiving a blank line.
      if (renderedSubject.missing.length || renderedBody.missing.length) {
        const skippedCounts = skipped as Record<string, number>;
        const skippedIds = skippedLeadIds as unknown as Record<string, string[]>;
        skippedCounts.missing_variables = (skippedCounts.missing_variables ?? 0) + 1;
        (skippedIds.missing_variables ??= []).push(lead.id);
        continue;
      }
      const resumed = Boolean(revivedEnrollment && (progress?.sentThrough ?? 0) > 0);
      // Follow-ups stay on the mailbox that sent the earlier steps.
      const mailbox = resumed && revivedEnrollment?.emailAccountId ? { id: revivedEnrollment.emailAccountId } : nextMailbox();
      const enrollmentId = revivedEnrollment?.id ?? randomUUID();
      const computedAt = resumed ? new Date(Date.now() + followUpSendJitterMs(`${enrollmentId}:${step.stepOrder}`)) : new Date(Date.now() + step.delayDays * 86_400_000 + initialSendJitterMs(enrollmentId));
      const scheduledAt = progress?.dueAt && progress.dueAt.getTime() > Date.now() ? progress.dueAt : progress?.dueAt ? new Date() : computedAt;
      let enrollment: typeof schema.enrollments.$inferSelect | undefined;
      if (revivedEnrollment) {
        [enrollment] = await tx.update(schema.enrollments).set({ status: resumed ? "active" : "scheduled", sequenceVersionId: enrollmentVersionId, emailAccountId: mailbox.id, campaignId: input.campaignId ?? revivedEnrollment.campaignId, nextStepOrder: step.stepOrder, nextDueAt: scheduledAt, stoppedAt: null, stopReason: null, statusBeforePause: null, pausedAt: null, updatedAt: new Date() }).where(and(
          eq(schema.enrollments.id, revivedEnrollment.id),
          eq(schema.enrollments.workspaceId, ctx.workspaceId),
          eq(schema.enrollments.status, "cancelled"),
          eq(schema.enrollments.stopReason, "missing_variables"),
        )).returning();
        if (enrollment) revived += 1;
      } else {
        [enrollment] = await tx.insert(schema.enrollments).values({ id: enrollmentId, workspaceId: ctx.workspaceId, contactId: lead.id, sequenceId: storedSequence.id, sequenceVersionId: storedSequence.currentVersionId!, campaignId: input.campaignId, emailAccountId: mailbox.id, status: "scheduled", nextStepOrder: step.stepOrder, nextDueAt: scheduledAt, startedAt: new Date(), metadata: { source: ids.length ? "selected_leads" : selectedListIds.length > 1 ? "contact_list_ids" : selectedListIds.length === 1 ? "contact_list_id" : "contact_list" } }).onConflictDoNothing().returning();
      }
      if (!enrollment) continue;
      const subject = renderedSubject.text;
      const token = createUnsubscribeToken({ workspaceId: ctx.workspaceId, contactId: lead.id, normalizedEmail: lead.normalizedEmail }, ctx.env.authSecret);
      const unsubscribeUrl = `${ctx.env.apiBaseUrl}/v1/unsubscribe?token=${encodeURIComponent(token)}`;
      const body = appendUnsubscribeFooter(renderedBody.text, unsubscribeUrl, postalAddress);
      await tx.insert(schema.messages).values({ id: randomUUID(), workspaceId: ctx.workspaceId, enrollmentId: enrollment.id, sequenceStepId: step.id, emailAccountId: mailbox.id, contactId: lead.id, status: "scheduled", idempotencyKey: `${enrollment.id}:${step.stepOrder}`, scheduledAt, recipientEmail: lead.email, normalizedRecipientEmail: lead.normalizedEmail, subject, bodyHash: createHash("sha256").update(body).digest("hex"), metadata: { bodyText: body, sequenceStepOrder: step.stepOrder, unsubscribeUrl } });
      await tx.update(schema.contacts).set({ status: "enrolled", updatedAt: new Date() }).where(eq(schema.contacts.id, lead.id));
      enrolledIds.push(lead.id);
    }
    // An enrolled lead no longer waits in the queue (it may have been parked there for missing values).
    for (const batch of chunk(enrolledIds, STAGED_INSERT_CHUNK_SIZE)) await tx.delete(schema.stagedEnrollments).where(and(eq(schema.stagedEnrollments.workspaceId, ctx.workspaceId), eq(schema.stagedEnrollments.sequenceId, storedSequence.id), inArray(schema.stagedEnrollments.leadId, batch)));
    newEnrollmentCount = enrolledIds.length - revived;
    const [version] = await tx.select().from(schema.sequenceVersions).where(and(eq(schema.sequenceVersions.id, storedSequence.currentVersionId!), eq(schema.sequenceVersions.workspaceId, ctx.workspaceId)));
if (version) await tx.update(schema.sequenceVersions).set({ snapshot: { ...(version.snapshot as Record<string, unknown>), description: sequence.description, enrolledCount: sequence.enrolledCount + newEnrollmentCount }, updatedAt: new Date() }).where(eq(schema.sequenceVersions.id, version.id));
if (input.campaignId && enrolledIds.length) restarted = (await reconcileCampaignStatus(tx, { workspaceId: ctx.workspaceId, campaignId: input.campaignId, allowRestart: true }))?.change === "restarted";
  });
  // Explicitly named leads that are still missing custom variables wait in the staged queue, so
  // they enroll on their own once their values arrive (campaign variables, lead fields or CSV).
  const waitingForValues = [...new Set((skippedLeadIds as unknown as Record<string, string[]>).missing_variables ?? [])];
  if (ids.length && waitingForValues.length && !input.skipMissingVariablesQueue) {
    const waitingInboxIds = input.inboxIds !== undefined ? [...new Set(input.inboxIds)] : input.inboxId ? [input.inboxId] : null;
    const queuedAt = new Date();
    for (const batch of chunk(waitingForValues, STAGED_INSERT_CHUNK_SIZE)) {
      await ctx.db.insert(schema.stagedEnrollments).values(batch.map((leadId) => ({ id: randomUUID(), workspaceId: ctx.workspaceId, sequenceId: storedSequence.id, leadId, campaignId: input.campaignId ?? null, inboxIds: waitingInboxIds?.length ? waitingInboxIds : null, createdAt: queuedAt }))).onConflictDoNothing();
    }
  }
  return { sequence: { ...sequence, enrolledCount: sequence.enrolledCount + newEnrollmentCount }, enrolled: enrolledIds.length, leadIds: enrolledIds, skipped, skippedLeadIds, restarted, message: "Eligible leads were scheduled with delivery safeguards enabled." };
}

export type BillingClient = {
  createCheckoutSession: (input: {
    product_cart: Array<{ product_id: string; quantity: number }>;
    customer: { customer_id: string } | { email: string; name?: string };
    return_url: string;
    cancel_url: string;
    subscription_data?: { trial_period_days: number };
    metadata: { workspaceId: string; piqo_visitor_id?: string };
    confirm: false;
  }, options?: { idempotencyKey?: string }) => Promise<unknown>;
  createCustomerPortal: (customerId: string) => Promise<unknown>;
  retrieveSubscription: (subscriptionId: string) => Promise<unknown>;
  listSubscriptions: (input: { customerId?: string; customerEmail?: string }) => Promise<unknown[]>;
  // One-time payments, for the lifetime license. Optional so older fakes keep working.
  listPayments?: (input: { customerId?: string; customerEmail?: string; productId: string }) => Promise<unknown[]>;
  retrievePayment?: (paymentId: string) => Promise<unknown>;
  updateSubscription: (subscriptionId: string, input: { cancel_at_next_billing_date: true } | { status: "cancelled"; cancel_reason: "cancelled_by_customer" }) => Promise<unknown>;
  unwrapWebhook?: (rawBody: string, headers: Record<string, string>) => unknown;
};

export class OpError extends Error {
  constructor(
    // not_available: the operation does not exist in this edition (billing in self-host).
    public readonly code: "BAD_INPUT" | "NOT_FOUND" | "CONFLICT" | "UNAVAILABLE" | "FORBIDDEN" | "billing_unconfigured" | "ai_unconfigured" | "plan_limit" | "draft_quota_exceeded" | "test_send_quota_exceeded" | "not_available",
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "OpError";
  }
}

const emailVerificationRequiredMessage = "Verify your email address before sending. Check your inbox for the verification link.";
// Checkout intents must not outlive the provider's checkout session.
const BILLING_CHECKOUT_INTENT_TTL_MS = 30 * 60 * 1000;
// Value of the first-party `piqo_visitor` analytics cookie: 16 lowercase hex characters.
const PIQO_VISITOR_ID = /^[0-9a-f]{16}$/;

export async function requireVerifiedWorkspaceOwner(ctx: OperationContext): Promise<void> {
  const [owner] = await ctx.db.select({ emailVerified: schema.authUsers.emailVerified })
    .from(schema.memberships)
    .innerJoin(schema.authUsers, eq(schema.authUsers.id, schema.memberships.userId))
    .where(and(
      eq(schema.memberships.workspaceId, ctx.workspaceId),
      eq(schema.memberships.role, "owner"),
      eq(schema.memberships.status, "active"),
    ))
    .orderBy(schema.memberships.createdAt)
    .limit(1);
  if (!owner?.emailVerified) {
    throw new OpError("FORBIDDEN", emailVerificationRequiredMessage, { code: "email_unverified" });
  }
}

export type Operation<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> = {
  name: string;
  description: string;
  access: "read" | "write";
  inputSchema: I;
  outputSchema: O;
  handler: (ctx: OperationContext, input: z.infer<I>) => Promise<z.infer<O>>;
};

const anyOutput = z.any();
const id = z.string().uuid();
const listIds = z.preprocess((value) => Array.isArray(value) ? [...new Set(value)] : value, z.array(id).max(20));
const percent = (value: number, total: number) => total ? Number(((value / total) * 100).toFixed(1)) : 0;
const sequenceAnalyticsInput = z.object({
  id,
  version: z.union([z.literal("current"), z.literal("all"), z.coerce.number().int().positive()]).default("current"),
});
const stepSchema = z.object({
  id: z.string().uuid().optional(),
  delayDays: z.number().int().min(0),
  subject: z.string().min(1),
  body: z.string().min(1),
});
const sequenceInput = z.object({
  name: z.string().trim().min(1),
  description: z.string().optional().default(""),
  steps: z.array(stepSchema).min(1),
});

export type WorkspacePlan = {
  // Cloud: "lifetime" (the $79 license, the only plan on sale) and "comp"
  // (founder-granted, ./billing-comp.ts) are entitled; "free" is the legacy Free
  // plan until legacyFreeEndsAt; "none" needs the license. Self-host reports
  // "selfhost" and is always entitled.
  tier: "none" | "free" | "lifetime" | "comp" | "selfhost";
  edition: Edition;
  status: string;
  nextBillingDate: string | null;
  trialEnd: string | null;
  cancelAtPeriodEnd: boolean;
  // Same answer canSend() gives for campaign sends at workspace level (it reads
  // the same sendingPlan): entitled, or legacy Free with sends left this month.
  sendingEnabled: boolean;
  // Cloud workspace on tier "none" or "free": the lifetime license is the way on.
  needsLicense: boolean;
  // Cloud only, while needsLicense: when legacy Free ends (or ended). ISO.
  legacyFreeEndsAt: string | null;
  // Legacy Free usage. monthlySendLimit is null unless tier "free".
  freePlan: boolean;
  monthlySendLimit: number | null;
  sendsThisMonth: number;
  monthlyResetsAt: string;
};

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function billingString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function billingDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function dodoSubscriptionStatus(eventType: string, payloadStatus: string | undefined): string | undefined {
  if (eventType === "subscription.unpaused" || eventType === "subscription.active" || eventType === "subscription.renewed") return "active";
  if (eventType === "subscription.on_hold") return "on_hold";
  if (eventType === "subscription.paused") return "paused";
  if (eventType === "subscription.cancelled") return "cancelled";
  if (eventType === "subscription.expired") return "expired";
  if (eventType === "subscription.failed") return "failed";
  return payloadStatus;
}

function providerSubscriptionTime(subscription: Record<string, unknown>): Date | null {
  const status = billingString(subscription.status);
  return billingDate(subscription.updated_at)
    ?? billingDate(subscription.modified_at)
    ?? (status === "cancelled" ? billingDate(subscription.cancelled_at) : null)
    ?? (["paused", "on_hold"].includes(status ?? "") ? billingDate(subscription.paused_at) : null)
    ?? billingDate(subscription.previous_billing_date)
    ?? billingDate(subscription.created_at);
}

function providerTrialEnd(subscription: Record<string, unknown>): Date | null {
  const explicit = billingDate(subscription.trial_end) ?? billingDate(subscription.trial_end_date);
  if (explicit) return explicit;
  const createdAt = billingDate(subscription.created_at);
  const days = typeof subscription.trial_period_days === "number" ? subscription.trial_period_days : 0;
  return createdAt && days > 0 ? new Date(createdAt.getTime() + days * 86_400_000) : null;
}

function providerWorkspaceId(subscription: Record<string, unknown>): string | undefined {
  const metadata = objectValue(subscription.metadata);
  return billingString(metadata.workspaceId) ?? billingString(metadata.workspace_id);
}

function providerSubscriptionIsLive(subscription: Record<string, unknown>): boolean {
  return ["active", "trialing", "on_hold", "paused"].includes(billingString(subscription.status) ?? "");
}

// The last clause keeps an active lifetime license (./billing-lifetime.ts)
// final: no Dodo subscription event replaces it.
export function dodoSubscriptionUpsertWhere(): SQL {
  return sql`
    (${schema.subscriptions.providerUpdatedAt} IS NULL OR excluded.provider_updated_at >= ${schema.subscriptions.providerUpdatedAt})
    AND (
      ${schema.subscriptions.dodoSubscriptionId} = excluded.dodo_subscription_id
      OR ${schema.subscriptions.status} NOT IN ('active', 'trialing', 'on_hold', 'paused')
      OR excluded.status IN ('active', 'trialing', 'on_hold', 'paused')
    )
    AND (${schema.subscriptions.status} <> 'active' OR (${schema.subscriptions.metadata}->>'lifetime') IS DISTINCT FROM 'true')`;
}

// Writes a Dodo subscription event or provider read onto the workspace's row.
// When the stored row ends up entitling (an old plan recovering to active, a
// trial, on_hold inside its grace), campaign email the plan gate parked goes
// out now, like a lifetime or comp grant. Pass a transaction so the row and the
// release commit together.
export async function upsertDodoSubscription(
  db: Pick<InboxJoyDb, "insert" | "execute">,
  workspaceId: string,
  rawSubscription: unknown,
  options: { eventType?: string; providerUpdatedAt?: Date } = {},
) {
  const subscription = objectValue(rawSubscription);
  const dodoSubscriptionId = billingString(subscription.subscription_id);
  const providerUpdatedAt = options.providerUpdatedAt ?? providerSubscriptionTime(subscription);
  if (!dodoSubscriptionId || !providerUpdatedAt) {
    throw new OpError("UNAVAILABLE", "Dodo Payments returned an incomplete subscription.");
  }

  const customer = objectValue(subscription.customer);
  const status = dodoSubscriptionStatus(options.eventType ?? "subscription.updated", billingString(subscription.status)) ?? "pending";
  const values = {
    id: randomUUID(),
    workspaceId,
    dodoCustomerId: billingString(customer.customer_id) ?? null,
    dodoSubscriptionId,
    productId: billingString(subscription.product_id) ?? null,
    status,
    nextBillingDate: billingDate(subscription.next_billing_date),
    trialEnd: providerTrialEnd(subscription),
    cancelAtPeriodEnd: subscription.cancel_at_next_billing_date === true,
    metadata: subscription,
    providerUpdatedAt,
    updatedAt: new Date(),
  };
  const persisted = await db.insert(schema.subscriptions).values(values).onConflictDoUpdate({
    target: schema.subscriptions.workspaceId,
    set: {
      dodoCustomerId: values.dodoCustomerId,
      dodoSubscriptionId: values.dodoSubscriptionId,
      productId: sql`COALESCE(excluded.product_id, ${schema.subscriptions.productId})`,
      status: values.status,
      nextBillingDate: sql`COALESCE(excluded.next_billing_date, ${schema.subscriptions.nextBillingDate})`,
      trialEnd: sql`COALESCE(excluded.trial_end, ${schema.subscriptions.trialEnd})`,
      cancelAtPeriodEnd: values.cancelAtPeriodEnd,
      metadata: values.metadata,
      providerUpdatedAt: values.providerUpdatedAt,
      updatedAt: sql`CASE
        WHEN ${schema.subscriptions.status} = 'on_hold' AND excluded.status = 'on_hold'
          THEN ${schema.subscriptions.updatedAt}
        ELSE excluded.updated_at
      END`,
    },
    where: dodoSubscriptionUpsertWhere(),
  }).returning({ id: schema.subscriptions.id, status: schema.subscriptions.status, trialEnd: schema.subscriptions.trialEnd, updatedAt: schema.subscriptions.updatedAt });
  const [stored] = persisted;
  // Dodo is cloud-only. The grace window matches the worker SQL (updated_at + 7 days).
  if (stored && hasSendingEntitlement({
    status: stored.status,
    trialEnd: stored.trialEnd,
    onHoldGraceEndsAt: new Date(stored.updatedAt.getTime() + 7 * 86_400_000),
  }, new Date(), "cloud")) {
    await releasePlanBlockedSends(db, workspaceId);
  }
  return { ...values, persisted: persisted.length > 0 };
}

// Self-hosted installs have no billing: every workspace is entitled and there
// is nothing to buy, manage or cancel.
function requireCloudBilling(ctx: OperationContext): void {
  if (!isCloudEdition(ctx.env.edition)) throw new OpError("not_available", "Billing is not part of the self-hosted edition.");
}

function billingClient(ctx: OperationContext): BillingClient {
  if (!ctx.env.dodoPaymentsApiKey || !ctx.billing) {
    throw new OpError("billing_unconfigured", "Billing is not configured.");
  }
  return ctx.billing;
}

function portalResponseShape(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(objectValue(value)).map(([key, item]) => [key, Array.isArray(item) ? "array" : item === null ? "null" : typeof item]));
}

async function workspaceRole(ctx: OperationContext): Promise<"owner" | "admin" | "member"> {
  const [membership] = await ctx.db.select({ role: schema.memberships.role }).from(schema.memberships).where(and(
    eq(schema.memberships.workspaceId, ctx.workspaceId),
    eq(schema.memberships.userId, ctx.userId),
    eq(schema.memberships.status, "active"),
  )).limit(1);
  if (!membership) throw new OpError("FORBIDDEN", "You do not have access to this workspace.");
  return membership.role;
}

export async function requireWorkspaceManager(ctx: OperationContext): Promise<void> {
  if (await workspaceRole(ctx) === "member") throw new OpError("FORBIDDEN", "Only workspace owners and admins can update workspace settings.");
}

async function requireWorkspaceOwner(ctx: OperationContext): Promise<void> {
  if (await workspaceRole(ctx) !== "owner") throw new OpError("FORBIDDEN", "Only workspace owners can complete this action.");
}

const invitationVerificationRequiredMessage = "Verify your email address before accepting this invitation. Check your inbox for the verification link.";
const inviterVerificationRequiredMessage = "Verify your email address before inviting teammates. Check your inbox for the verification link.";

// An invitation's link admits a new account on an invite-only server (and, on
// self-host, starts it verified), so only an owner who has proven their own
// address may create one. A missing auth row counts as unverified.
async function requireVerifiedInviter(ctx: OperationContext): Promise<void> {
  const [inviter] = await ctx.db.select({ emailVerified: schema.authUsers.emailVerified })
    .from(schema.authUsers).where(eq(schema.authUsers.id, ctx.userId)).limit(1);
  if (!inviter?.emailVerified) {
    throw new OpError("FORBIDDEN", inviterVerificationRequiredMessage, { code: "email_unverified" });
  }
}

// The signed-in user as invitation checks see them: profile email plus whether
// the auth account has proven ownership of it. A missing auth row counts as
// unverified, never as verified.
async function invitationUser(ctx: OperationContext): Promise<{ email: string; normalizedEmail: string; emailVerified: boolean } | undefined> {
  const [user] = await ctx.db.select({
    email: schema.users.email,
    normalizedEmail: schema.users.normalizedEmail,
    emailVerified: sql<boolean>`coalesce(${schema.authUsers.emailVerified}, false)`,
  }).from(schema.users)
    .leftJoin(schema.authUsers, eq(schema.authUsers.id, schema.users.id))
    .where(eq(schema.users.id, ctx.userId)).limit(1);
  return user;
}

function validTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

const billingStateSchema = z.object({
  tier: z.enum(["none", "free", "lifetime", "comp", "selfhost"]),
  edition: z.enum(["cloud", "selfhost"]),
  status: z.string(),
  nextBillingDate: z.string().nullable(),
  trialEnd: z.string().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  configured: z.boolean(),
  hasCustomer: z.boolean(),
  sendingEnabled: z.boolean(),
  canManage: z.boolean(),
  needsLicense: z.boolean(),
  legacyFreeEndsAt: z.string().nullable(),
  freePlan: z.boolean(),
  monthlySendLimit: z.number().int().nullable(),
  sendsThisMonth: z.number().int(),
  monthlyResetsAt: z.string(),
});

export async function getWorkspacePlan(ctx: OperationContext): Promise<WorkspacePlan> {
  const now = new Date();
  const edition = ctx.env.edition;
  const { sendsThisMonth, legacyFreeUntil } = await workspacePlanUsage(ctx, now);
  const monthlyResetsAt = freePlanMonthResetsAt(now).toISOString();
  if (!isCloudEdition(edition)) {
    return {
      tier: "selfhost", edition, status: "selfhost", nextBillingDate: null, trialEnd: null, cancelAtPeriodEnd: false,
      sendingEnabled: true, needsLicense: false, legacyFreeEndsAt: null,
      freePlan: false, monthlySendLimit: null, sendsThisMonth, monthlyResetsAt,
    };
  }

  const [subscription] = await ctx.db.select().from(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, ctx.workspaceId)).limit(1);
  // Grace window matches the worker SQL: updated_at + interval '7 days'.
  const onHoldGraceEndsAt = subscription ? new Date(subscription.updatedAt.getTime() + 7 * 86_400_000) : null;
  // The same sendingPlan() canSend() reads, so this can never disagree with the worker.
  const plan = sendingPlan({
    edition,
    subscription: subscription ? { status: subscription.status, trialEnd: subscription.trialEnd, onHoldGraceEndsAt } : null,
    legacyFreeUntil,
  }, now);

  let tier: WorkspacePlan["tier"] = plan === "legacy_free" ? "free" : "none";
  if (plan === "entitled") {
    // Anything entitled that is not the lifetime license (a comp, an old
    // Monthly/Yearly subscription or trial) reports as comp.
    tier = subscription && isLifetimeSubscriptionRow(subscription) ? "lifetime" : "comp";
    if (tier === "comp" && subscription?.metadata?.comp !== true) {
      ctx.logger?.warn?.({ productId: subscription?.productId }, "Paid access without a lifetime license or comp; reporting it as comp");
    }
  }
  const needsLicense = tier === "none" || tier === "free";

  return {
    tier,
    edition,
    status: subscription?.status ?? (tier === "free" ? "free" : "none"),
    nextBillingDate: subscription?.nextBillingDate?.toISOString() ?? null,
    trialEnd: subscription?.trialEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
    sendingEnabled: planAllowsCampaignSends(plan, sendsThisMonth),
    needsLicense,
    legacyFreeEndsAt: needsLicense ? legacyFreeUntil?.toISOString() ?? null : null,
    freePlan: tier === "free",
    monthlySendLimit: tier === "free" ? FREE_PLAN_MONTHLY_SEND_LIMIT : null,
    sendsThisMonth,
    monthlyResetsAt,
  };
}

// Same month count the worker gates on (freePlanMonthlySendsSql), so the usage
// meter and the send gate can never disagree, plus the legacy Free window.
async function workspacePlanUsage(ctx: OperationContext, now: Date): Promise<{ sendsThisMonth: number; legacyFreeUntil: Date | null }> {
  const result = await ctx.db.execute<{ sends: string; legacy_free_until: Date | string | null }>(sql`
    SELECT ${sql.raw(freePlanMonthlySendsSql({ workspaceIdSql: "w.id", nowSql: "gate.now_at" }))}::text AS sends, w.legacy_free_until
    FROM workspaces w CROSS JOIN (SELECT ${now.toISOString()}::timestamptz AS now_at) gate
    WHERE w.id = ${ctx.workspaceId}
  `);
  const row = result.rows[0];
  return {
    sendsThisMonth: Number(row?.sends ?? 0),
    legacyFreeUntil: row?.legacy_free_until ? new Date(row.legacy_free_until) : null,
  };
}

async function consumeDailyDraftQuota(ctx: OperationContext): Promise<void> {
  const periodStart = new Date();
  periodStart.setUTCHours(0, 0, 0, 0);
  const periodEnd = new Date(periodStart.getTime() + 86_400_000);
  const counterKey = "sequence_drafts";
  const result = await ctx.db.execute<{ value: number }>(sql`
    INSERT INTO usage_counters (id, workspace_id, counter_key, period_start, period_end, value, updated_at)
    VALUES (${randomUUID()}, ${ctx.workspaceId}, ${counterKey}, ${periodStart}, ${periodEnd}, 1, now())
    ON CONFLICT (workspace_id, counter_key, period_start)
    DO UPDATE SET value = usage_counters.value + 1, updated_at = now()
    WHERE usage_counters.value < 20
    RETURNING value
  `);
  if (!result.rows.length) {
    throw new OpError("draft_quota_exceeded", "Daily AI draft quota exceeded. Try again tomorrow.", { limit: 20, resetsAt: periodEnd.toISOString() });
  }
}

export function renderPersonalized(value: string, lead: LeadVariableSource, options: RenderOptions = {}): string {
  return renderTemplate(value, lead, options).text;
}

export function initialSendJitterMs(key: string, windowMs = 90 * 60_000): number {
  if (windowMs <= 0) return 0;
  return createHash("sha256").update(key).digest().readUInt32BE(0) % (windowMs + 1);
}

export function followUpSendJitterMs(key: string, windowMs = 90 * 60_000): number {
  return initialSendJitterMs(`follow-up:${key}`, windowMs);
}

async function readSequences(ctx: OperationContext) {
  const rows = await ctx.db.select().from(schema.sequences)
    .where(eq(schema.sequences.workspaceId, ctx.workspaceId))
    .orderBy(desc(schema.sequences.createdAt));
  const campaigns = await ctx.db.select().from(schema.campaigns)
    .where(eq(schema.campaigns.workspaceId, ctx.workspaceId)).orderBy(desc(schema.campaigns.createdAt));
  const campaignBySequence = new Map<string, typeof schema.campaigns.$inferSelect>();
  for (const campaign of campaigns) {
    if (!campaignBySequence.has(campaign.sequenceId)) campaignBySequence.set(campaign.sequenceId, campaign);
  }
  const displayStatuses = await campaignDisplayStatuses(ctx.db, ctx.workspaceId, [
    ...rows.map((sequence) => ({ id: sequence.id, sequenceId: sequence.id, status: sequence.status })), ...campaigns,
  ], ctx.env.edition);
  const mailboxRows = await ctx.db.select().from(schema.sequenceEmailAccounts)
    .where(eq(schema.sequenceEmailAccounts.workspaceId, ctx.workspaceId))
    .orderBy(schema.sequenceEmailAccounts.emailAccountId);
  const mailboxIdsBySequence = new Map<string, string[]>();
  for (const mailbox of mailboxRows) {
    const mailboxIds = mailboxIdsBySequence.get(mailbox.sequenceId) ?? [];
    mailboxIds.push(mailbox.emailAccountId);
    mailboxIdsBySequence.set(mailbox.sequenceId, mailboxIds);
  }
  const enrollmentRows = await ctx.db.select({ sequenceId: schema.enrollments.sequenceId, status: schema.enrollments.status, stoppedAt: schema.enrollments.stoppedAt }).from(schema.enrollments)
    .where(eq(schema.enrollments.workspaceId, ctx.workspaceId));
  const counts = enrollmentRows.reduce((result, row) => result.set(row.sequenceId, (result.get(row.sequenceId) ?? 0) + 1), new Map<string, number>());
  const stagedRows = await ctx.db.select({ sequenceId: schema.stagedEnrollments.sequenceId }).from(schema.stagedEnrollments)
    .where(eq(schema.stagedEnrollments.workspaceId, ctx.workspaceId));
  const queuedCounts = stagedRows.reduce((result, row) => result.set(row.sequenceId, (result.get(row.sequenceId) ?? 0) + 1), new Map<string, number>());
  const sentRows = await ctx.db.select({ sequenceId: schema.enrollments.sequenceId }).from(schema.messages)
    .innerJoin(schema.enrollments, eq(schema.messages.enrollmentId, schema.enrollments.id))
    .where(and(eq(schema.messages.workspaceId, ctx.workspaceId), eq(schema.messages.status, "accepted")));
  const sentCounts = sentRows.reduce((result, row) => result.set(row.sequenceId, (result.get(row.sequenceId) ?? 0) + 1), new Map<string, number>());
  const replyCounts = enrollmentRows.filter((row) => row.status === "replied").reduce((result, row) => result.set(row.sequenceId, (result.get(row.sequenceId) ?? 0) + 1), new Map<string, number>());
  const unsubscribeCounts = enrollmentRows.filter((row) => row.status === "unsubscribed").reduce((result, row) => result.set(row.sequenceId, (result.get(row.sequenceId) ?? 0) + 1), new Map<string, number>());
  const activeCounts = enrollmentRows.filter((row) => row.status === "scheduled" || row.status === "active").reduce((result, row) => result.set(row.sequenceId, (result.get(row.sequenceId) ?? 0) + 1), new Map<string, number>());
  const finishedCounts = enrollmentRows.filter((row) => row.status === "completed").reduce((result, row) => result.set(row.sequenceId, (result.get(row.sequenceId) ?? 0) + 1), new Map<string, number>());
  const inProgressCounts = enrollmentRows.filter((row) => row.status === "scheduled" || row.status === "active" || row.status === "paused").reduce((result, row) => result.set(row.sequenceId, (result.get(row.sequenceId) ?? 0) + 1), new Map<string, number>());
  const lastStoppedAt = new Map<string, Date>();
  for (const row of enrollmentRows) {
    if (row.stoppedAt && row.stoppedAt > (lastStoppedAt.get(row.sequenceId) ?? new Date(0))) lastStoppedAt.set(row.sequenceId, row.stoppedAt);
  }
  const openEventRows = await ctx.db.select({ sequenceId: schema.enrollments.sequenceId, messageId: schema.messageEvents.messageId, metadata: schema.messageEvents.metadata })
    .from(schema.messageEvents)
    .innerJoin(schema.messages, eq(schema.messageEvents.messageId, schema.messages.id))
    .innerJoin(schema.enrollments, eq(schema.messages.enrollmentId, schema.enrollments.id))
    .where(and(eq(schema.messageEvents.workspaceId, ctx.workspaceId), eq(schema.messageEvents.eventType, "opened")));
  const openedCounts = new Map<string, number>();
  const seenOpenedMessageIds = new Set<string>();
  for (const openEvent of openEventRows) {
    if (!openEvent.messageId || openEvent.metadata.bot === true) continue;
    if (seenOpenedMessageIds.has(openEvent.messageId)) continue;
    seenOpenedMessageIds.add(openEvent.messageId);
    openedCounts.set(openEvent.sequenceId, (openedCounts.get(openEvent.sequenceId) ?? 0) + 1);
  }

  return Promise.all(rows.map(async (row) => {
    const version = row.currentVersionId
      ? (await ctx.db.select().from(schema.sequenceVersions).where(and(
        eq(schema.sequenceVersions.id, row.currentVersionId),
        eq(schema.sequenceVersions.workspaceId, ctx.workspaceId),
      )).limit(1))[0]
      : undefined;
    const steps = version
      ? await ctx.db.select().from(schema.sequenceSteps).where(and(
        eq(schema.sequenceSteps.sequenceVersionId, version.id),
        eq(schema.sequenceSteps.workspaceId, ctx.workspaceId),
      )).orderBy(schema.sequenceSteps.stepOrder)
      : [];
    const snapshot = (version?.snapshot ?? {}) as Record<string, unknown>;
    const campaign = campaignBySequence.get(row.id);
    const display = deriveSequenceDisplay({
      sequenceStatus: row.status,
      campaign,
      enrolledCount: counts.get(row.id) ?? 0,
      inProgressCount: inProgressCounts.get(row.id) ?? 0,
      lastStoppedAt: lastStoppedAt.get(row.id) ?? null,
      sequenceOwnDisplay: displayStatuses.get(row.id)!,
      campaignDisplay: campaign ? displayStatuses.get(campaign.id) : undefined,
    });

    return {
      id: row.id,
      name: row.name,
      mailboxIds: mailboxIdsBySequence.get(row.id) ?? [],
      description: typeof snapshot.description === "string" ? snapshot.description : "",
      status: row.status === "active" ? "published" : row.status,
      displayStatus: display.displayStatus,
      statusReason: display.statusReason,
      completedAt: display.completedAt,
      steps: steps.map((step) => ({ id: step.id, delayDays: step.delayDays, subject: step.subject, body: step.bodyText })),
      enrolledCount: counts.get(row.id) ?? 0,
      queuedCount: queuedCounts.get(row.id) ?? 0,
      activeCount: activeCounts.get(row.id) ?? 0,
      finishedCount: finishedCounts.get(row.id) ?? 0,
      openRate: percent(openedCounts.get(row.id) ?? 0, sentCounts.get(row.id) ?? 0),
      replyRate: percent(replyCounts.get(row.id) ?? 0, sentCounts.get(row.id) ?? 0),
      unsubscribed: unsubscribeCounts.get(row.id) ?? 0,
      unsubscribeRate: percent(unsubscribeCounts.get(row.id) ?? 0, sentCounts.get(row.id) ?? 0),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }));
}

async function sequenceFor(ctx: OperationContext, sequenceId: string) {
  const sequence = (await readSequences(ctx)).find((item) => item.id === sequenceId);
  if (!sequence) throw new OpError("NOT_FOUND", "Sequence not found.");
  return sequence;
}

async function readLeads(ctx: OperationContext) {
  const rows = await ctx.db.select().from(schema.contacts)
    .where(eq(schema.contacts.workspaceId, ctx.workspaceId))
    .orderBy(desc(schema.contacts.createdAt));
  const lists = await ctx.db.select().from(schema.contactLists).where(eq(schema.contactLists.workspaceId, ctx.workspaceId));
  const members = lists.length
    ? await ctx.db.select().from(schema.contactListMembers).where(inArray(schema.contactListMembers.contactListId, lists.map((list) => list.id)))
    : [];
  const names = new Map(members.map((member) => [member.contactId, lists.find((list) => list.id === member.contactListId)?.name ?? "Imported leads"]));
  const touches = await ctx.db.select({ contactId: schema.messages.contactId, acceptedAt: schema.messages.acceptedAt }).from(schema.messages)
    .where(and(eq(schema.messages.workspaceId, ctx.workspaceId), eq(schema.messages.status, "accepted")));
  const lastTouches = new Map<string, Date>();
  for (const touch of touches) if (touch.acceptedAt && (!lastTouches.has(touch.contactId) || lastTouches.get(touch.contactId)! < touch.acceptedAt)) lastTouches.set(touch.contactId, touch.acceptedAt);

  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    normalizedEmail: row.normalizedEmail,
    firstName: row.firstName ?? "",
    lastName: row.lastName ?? "",
    company: row.company ?? "",
    title: row.title ?? "",
    source: row.source ?? "",
    status: row.status === "replied" ? "Replied" : row.status === "suppressed" ? "Suppressed" : row.status === "enrolled" ? "Enrolled" : row.status === "bounced" ? "Bounced" : row.status === "unsubscribed" ? "Unsubscribed" : "Ready",
    listName: names.get(row.id) ?? "Imported leads",
    importedAt: row.createdAt.toISOString(),
    lastTouchAt: lastTouches.get(row.id)?.toISOString() ?? null,
  }));
}

// Suppressing an address is not just a row in a table: the contact has to stop
// reading as a live prospect, every enrollment across every campaign has to stop,
// and queued messages have to be cancelled. This lived only inside app.ts's
// applySuppression, so the one-click footer link cascaded and the manual
// suppression operation did not -- a manually suppressed contact kept its old
// status and live enrollments. Both paths now share this.
export async function cascadeSuppression(
  // Structural so it accepts both a db handle and a transaction: a PgTransaction
  // has no $client, so the full database type would reject it.
  tx: Pick<OperationContext["db"], "select" | "update" | "execute">,
  input: { workspaceId: string; contactId: string; reason: string; at?: Date },
): Promise<void> {
  if ("$client" in tx) {
    await retryTransaction(() => (tx as InboxJoyDb).transaction((transaction) => cascadeSuppression(transaction, input)));
    return;
  }
  const now = input.at ?? new Date();
  await tx.execute(sql`SELECT id FROM campaigns WHERE workspace_id = ${input.workspaceId} AND id IN (
    SELECT campaign_id FROM enrollments WHERE workspace_id = ${input.workspaceId} AND contact_id = ${input.contactId}
  ) ORDER BY id FOR UPDATE`);
  await tx.update(schema.contacts)
    .set({ status: "suppressed", unsubscribedAt: now, updatedAt: now })
    .where(and(eq(schema.contacts.id, input.contactId), eq(schema.contacts.workspaceId, input.workspaceId)));

  const activeEnrollments = await tx.select({ id: schema.enrollments.id, campaignId: schema.enrollments.campaignId }).from(schema.enrollments).where(and(
    eq(schema.enrollments.workspaceId, input.workspaceId),
    eq(schema.enrollments.contactId, input.contactId),
    inArray(schema.enrollments.status, ["scheduled", "active", "paused"]),
  ));
  const enrollmentIds = activeEnrollments.map((enrollment) => enrollment.id);
  if (!enrollmentIds.length) return;

  await tx.update(schema.enrollments)
    .set({ status: "unsubscribed", stoppedAt: now, stopReason: input.reason, nextDueAt: null, updatedAt: now })
    .where(inArray(schema.enrollments.id, enrollmentIds));

  const cancellable = await tx.select({ id: schema.messages.id }).from(schema.messages).where(and(
    inArray(schema.messages.enrollmentId, enrollmentIds),
    inArray(schema.messages.status, ["scheduled", "retryable", "claimed", "sending"]),
  ));
  const messageIds = cancellable.map((message) => message.id);
  if (messageIds.length) {
    await tx.update(schema.messages)
      .set({ status: "cancelled", errorClass: "recipient_suppressed", errorMessage: "Recipient unsubscribed", claimExpiresAt: null, updatedAt: now })
      .where(inArray(schema.messages.id, messageIds));
    await tx.update(schema.sendAttempts)
      .set({ status: "cancelled", errorClass: "recipient_suppressed", errorMessage: "Recipient unsubscribed", finishedAt: now })
      .where(and(inArray(schema.sendAttempts.messageId, messageIds), eq(schema.sendAttempts.status, "sending")));
  }
  for (const campaignId of [...new Set(activeEnrollments.flatMap((enrollment) => enrollment.campaignId ? [enrollment.campaignId] : []))].sort()) {
    await reconcileCampaignStatus(tx, { workspaceId: input.workspaceId, campaignId, now });
  }
}

export const operations: Array<Operation<any, any>> = [
  {
    name: "sequences.draft",
    description: "Draft a validated cold-email sequence with AI. This does not save or publish the sequence.",
    access: "write",
    inputSchema: sequenceDraftInputSchema,
    outputSchema: sequenceDraftOutputSchema,
    handler: async (ctx, input) => {
      const client = resolveAIProvider(ctx.env) ? ctx.ai ?? createSequenceDraftClient(ctx.env) : undefined;
      if (!client) throw new OpError("ai_unconfigured", "AI sequence drafting is not configured.");
      await consumeDailyDraftQuota(ctx);
      try {
        return await client.draftSequence(input);
      } catch (error) {
        if (error instanceof OpError) throw error;
        throw new OpError("UNAVAILABLE", "AI sequence drafting is temporarily unavailable.");
      }
    },
  },
  {
    name: "sequences.refineStep",
    description: "Refine one cold-email sequence step without changing the rest of the sequence.",
    access: "write",
    inputSchema: refineStepInputSchema,
    outputSchema: refineStepOutputSchema,
    handler: async (ctx, input) => {
      const client = resolveAIProvider(ctx.env) ? ctx.ai ?? createSequenceDraftClient(ctx.env) : undefined;
      if (!client) throw new OpError("ai_unconfigured", "AI sequence refinement is not configured.");
      await consumeDailyDraftQuota(ctx);
      try {
        return validateRefinedStep(input, await client.refineStep(input));
      } catch (error) {
        if (error instanceof OpError) throw error;
        throw new OpError("UNAVAILABLE", "AI sequence refinement is temporarily unavailable.");
      }
    },
  },
  {
    name: "sequences.list",
    description: "List all sequences in the authenticated workspace, including their steps and enrollment counts.",
    access: "read",
    inputSchema: z.object({}),
    outputSchema: anyOutput,
    handler: async (ctx) => ({ workspaceId: ctx.workspaceId, sequences: await readSequences(ctx) }),
  },
  {
    name: "sequences.create",
    description: "Create a draft sequence with a name, optional description, and one or more ordered email steps. This does not publish or send email.",
    access: "write",
    inputSchema: sequenceInput,
    outputSchema: anyOutput,
    handler: async (ctx, input) => {
      const sequenceId = randomUUID();
      const versionId = randomUUID();
      const now = new Date();
      await ctx.db.transaction(async (tx) => {
        await tx.insert(schema.sequences).values({ id: sequenceId, workspaceId: ctx.workspaceId, name: input.name, status: "draft" });
        await tx.insert(schema.sequenceVersions).values({ id: versionId, workspaceId: ctx.workspaceId, sequenceId, version: 1, status: "draft", snapshot: { description: input.description, enrolledCount: 0 } });
        await tx.insert(schema.sequenceSteps).values(input.steps.map((step: z.infer<typeof stepSchema>, index: number) => ({ id: step.id ?? randomUUID(), workspaceId: ctx.workspaceId, sequenceVersionId: versionId, stepOrder: index + 1, delayDays: step.delayDays, subject: step.subject, bodyText: step.body })));
        await tx.update(schema.sequences).set({ currentVersionId: versionId, updatedAt: now }).where(eq(schema.sequences.id, sequenceId));
      });
      return { sequence: (await readSequences(ctx)).find((sequence) => sequence.id === sequenceId) };
    },
  },
  {
    name: "sequences.publish",
    description: "Publish a draft or paused sequence so it can accept eligible lead enrollments.",
    access: "write",
    inputSchema: z.object({ id }),
    outputSchema: anyOutput,
    handler: async (ctx, input) => {
      await requireWorkspaceManager(ctx);
      const sequence = await sequenceFor(ctx, input.id);
      if (!sequence.steps.length) throw new OpError("BAD_INPUT", "Add at least one step before publishing.");
      if (sequence.status === "archived") throw new OpError("CONFLICT", "Archived sequences cannot be published.");
      // Postal address is optional by owner decision (2026-09-15); no publish gate.
      const [stored] = await ctx.db.select().from(schema.sequences).where(and(eq(schema.sequences.id, input.id), eq(schema.sequences.workspaceId, ctx.workspaceId)));
      // A draft's queued leads enroll as part of publishing, so they must have every custom
      // variable first. Leads re-queued on an already-live sequence (waiting on values by
      // design) must not block later publishes; they convert when their values arrive.
      const queuedLeads = await ctx.db.select({ leadId: schema.stagedEnrollments.leadId }).from(schema.stagedEnrollments).where(and(eq(schema.stagedEnrollments.workspaceId, ctx.workspaceId), eq(schema.stagedEnrollments.sequenceId, input.id)));
      if (sequence.status === "draft" && queuedLeads.length) await assertLaunchAudienceComplete(ctx.db, OpError, { workspaceId: ctx.workspaceId, sequenceId: input.id, leadIds: queuedLeads.map((row) => row.leadId) });
      const now = new Date();
      await ctx.db.update(schema.sequences).set({ status: "active", updatedAt: now }).where(and(eq(schema.sequences.id, input.id), eq(schema.sequences.workspaceId, ctx.workspaceId)));
      if (stored?.currentVersionId) await ctx.db.update(schema.sequenceVersions).set({ status: "active", launchedAt: now }).where(eq(schema.sequenceVersions.id, stored.currentVersionId));
      const queuedEnrollment = await convertStagedEnrollments(ctx, input.id);
      return { sequence: await sequenceFor(ctx, input.id), message: "Sequence published and ready for safeguarded enrollment.", ...(queuedEnrollment ? { queuedEnrollment } : {}) };
    },
  },
  {
    name: "sequences.pause",
    description: "Pause a published sequence. Existing scheduled messages are retained but no new sequence processing should occur until resumed.",
    access: "write",
    inputSchema: z.object({ id }),
    outputSchema: anyOutput,
    handler: async (ctx, input) => {
      await requireWorkspaceManager(ctx);
      const [sequence] = await ctx.db.select().from(schema.sequences).where(and(eq(schema.sequences.id, input.id), eq(schema.sequences.workspaceId, ctx.workspaceId)));
      if (!sequence) throw new OpError("NOT_FOUND", "Sequence not found.");
      if (sequence.status !== "active") throw new OpError("CONFLICT", "Only published sequences can be paused.");
      const now = new Date();
      await ctx.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM campaigns WHERE workspace_id = ${ctx.workspaceId} AND sequence_id = ${sequence.id} ORDER BY id FOR UPDATE`);
        const pausedRows = await tx.update(schema.sequences).set({ status: "paused", pausedAt: now, updatedAt: now }).where(and(
          eq(schema.sequences.id, sequence.id),
          eq(schema.sequences.status, "active"),
        )).returning({ id: schema.sequences.id });
        if (!pausedRows.length) return;
        await tx.update(schema.enrollments).set({ status: "paused", statusBeforePause: sql`status`, pausedAt: now, updatedAt: now }).where(and(
          eq(schema.enrollments.sequenceId, sequence.id),
          inArray(schema.enrollments.status, ["scheduled", "active"]),
        ));
      });
      return { sequence: (await readSequences(ctx)).find((item) => item.id === sequence.id) };
    },
  },
  {
    name: "sequences.resume",
    description: "Resume a paused sequence and return it to published status.",
    access: "write",
    inputSchema: z.object({ id }),
    outputSchema: anyOutput,
    handler: async (ctx, input) => {
      await requireWorkspaceManager(ctx);
      const [sequence] = await ctx.db.select().from(schema.sequences).where(and(eq(schema.sequences.id, input.id), eq(schema.sequences.workspaceId, ctx.workspaceId)));
      if (!sequence) throw new OpError("NOT_FOUND", "Sequence not found.");
      if (sequence.status !== "paused") throw new OpError("CONFLICT", "Only paused sequences can be resumed.");
      const now = new Date();
      const pausedAt = sequence.pausedAt ?? now;
      const pauseMs = Math.max(0, now.getTime() - pausedAt.getTime());
      const resumable = and(eq(schema.enrollments.workspaceId, ctx.workspaceId), eq(schema.enrollments.sequenceId, sequence.id), eq(schema.enrollments.status, "paused"), or(and(eq(schema.enrollments.pausedAt, pausedAt), isNull(schema.enrollments.stopReason)), eq(schema.enrollments.stopReason, "repeated_provider_failure")));
      await ctx.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM campaigns WHERE workspace_id = ${ctx.workspaceId} AND sequence_id = ${sequence.id} ORDER BY id FOR UPDATE`);
        await tx.execute(sql`SELECT id FROM sequences WHERE workspace_id = ${ctx.workspaceId} AND id = ${sequence.id} FOR UPDATE`);
        const resuming = await tx.select({ id: schema.enrollments.id }).from(schema.enrollments).where(resumable);
        await refreshPendingOnResume(tx, { workspaceId: ctx.workspaceId, sequenceId: sequence.id, enrollmentIds: resuming.map((row) => row.id), now });
        await tx.update(schema.enrollments).set({ status: sql`COALESCE(${schema.enrollments.statusBeforePause}, 'active'::enrollment_status)`, statusBeforePause: null, pausedAt: null, stopReason: null, updatedAt: now }).where(resumable);
        await tx.update(schema.sequences).set({ status: "active", pausedAt: null, updatedAt: now }).where(eq(schema.sequences.id, sequence.id));
        if (sequence.currentVersionId) await tx.update(schema.sequenceVersions).set({ status: "active", launchedAt: now, updatedAt: now }).where(eq(schema.sequenceVersions.id, sequence.currentVersionId));
      });
      // Leads parked while the sequence was paused (values written meanwhile) enroll now if complete.
      try {
        const parked = await ctx.db.select({ leadId: schema.stagedEnrollments.leadId }).from(schema.stagedEnrollments).where(and(eq(schema.stagedEnrollments.workspaceId, ctx.workspaceId), eq(schema.stagedEnrollments.sequenceId, sequence.id)));
        if (parked.length) await convertQueuedLeads(ctx, sequence.id, parked.map((row) => row.leadId));
      } catch (error) {
        try { ctx.logger?.warn?.({ error, sequenceId: sequence.id, workspaceId: ctx.workspaceId }, "Enrolling leads parked while the sequence was paused failed."); } catch {}
      }
      return { sequence: (await readSequences(ctx)).find((item) => item.id === sequence.id), resumedAfterMs: pauseMs };
    },
  },
  {
    name: "sequences.archive",
    description: "Archive a draft or paused sequence, or a published one with no leads scheduled or sending (for example a finished campaign).",
    access: "write",
    inputSchema: z.object({ id }),
    outputSchema: anyOutput,
    handler: async (ctx, input) => {
      await requireWorkspaceManager(ctx);
      const [sequence] = await ctx.db.select().from(schema.sequences).where(and(eq(schema.sequences.id, input.id), eq(schema.sequences.workspaceId, ctx.workspaceId)));
      if (!sequence) throw new OpError("NOT_FOUND", "Sequence not found.");
      if (sequence.status === "archived" || sequence.status === "completed") throw new OpError("CONFLICT", "Only draft, paused, or finished sequences can be archived.");
      const now = new Date();
      await ctx.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM campaigns WHERE workspace_id = ${ctx.workspaceId} AND sequence_id = ${sequence.id} ORDER BY id FOR UPDATE`);
        // Enrollment locks the sequence row too, so a concurrent enroll either lands
        // before this count or sees the archived status and aborts.
        const [locked] = await tx.select({ status: schema.sequences.status }).from(schema.sequences).where(and(eq(schema.sequences.id, sequence.id), eq(schema.sequences.workspaceId, ctx.workspaceId))).for("update");
        if (locked?.status === "active") {
          const [sending] = await tx.select({ id: schema.enrollments.id }).from(schema.enrollments).where(and(eq(schema.enrollments.workspaceId, ctx.workspaceId), eq(schema.enrollments.sequenceId, sequence.id), inArray(schema.enrollments.status, ["scheduled", "active"]))).limit(1);
          if (sending) throw new OpError("CONFLICT", "Pause this campaign before archiving it.");
        } else if (locked?.status !== "draft" && locked?.status !== "paused") {
          throw new OpError("CONFLICT", "Only draft, paused, or finished sequences can be archived.");
        }
        await tx.update(schema.sequences).set({ status: "archived", archivedAt: now, updatedAt: now }).where(eq(schema.sequences.id, sequence.id));
        if (sequence.currentVersionId) await tx.update(schema.sequenceVersions).set({ status: "archived", updatedAt: now }).where(eq(schema.sequenceVersions.id, sequence.currentVersionId));
        // Archiving (the only way to "unpublish" a draft) discards anything queued for it.
        await tx.delete(schema.stagedEnrollments).where(and(eq(schema.stagedEnrollments.workspaceId, ctx.workspaceId), eq(schema.stagedEnrollments.sequenceId, sequence.id)));
      });
      return { sequence: (await readSequences(ctx)).find((item) => item.id === sequence.id) };
    },
  },
  {
    name: "sequences.delete",
    description: "Permanently delete a sequence and its enrollment and send history.",
    access: "write",
    inputSchema: z.object({ id }),
    outputSchema: anyOutput,
    handler: async (ctx, input) => {
      await requireWorkspaceOwner(ctx);
      await ctx.db.transaction(async (tx) => {
        const [sequence] = await tx.select({ id: schema.sequences.id }).from(schema.sequences).where(and(
          eq(schema.sequences.id, input.id),
          eq(schema.sequences.workspaceId, ctx.workspaceId),
        )).limit(1);
        if (!sequence) throw new OpError("NOT_FOUND", "Sequence not found.");

        await tx.delete(schema.stagedEnrollments).where(and(
          eq(schema.stagedEnrollments.workspaceId, ctx.workspaceId),
          eq(schema.stagedEnrollments.sequenceId, sequence.id),
        ));

        const enrollmentIds = tx.select({ id: schema.enrollments.id }).from(schema.enrollments).where(and(
          eq(schema.enrollments.workspaceId, ctx.workspaceId),
          eq(schema.enrollments.sequenceId, sequence.id),
        ));
        const sequenceMessages = await tx.select({ status: schema.messages.status, claimExpiresAt: schema.messages.claimExpiresAt }).from(schema.messages).where(and(
          eq(schema.messages.workspaceId, ctx.workspaceId),
          inArray(schema.messages.enrollmentId, enrollmentIds),
        )).for("update");
        const now = new Date();
        if (sequenceMessages.some((message) => message.status === "sending" && message.claimExpiresAt && message.claimExpiresAt > now)) {
          throw new OpError("CONFLICT", "This campaign has sends in progress. Pause it and try again in a few minutes.");
        }
        const versionIds = tx.select({ id: schema.sequenceVersions.id }).from(schema.sequenceVersions).where(and(
          eq(schema.sequenceVersions.workspaceId, ctx.workspaceId),
          eq(schema.sequenceVersions.sequenceId, sequence.id),
        ));
        const stepIds = tx.select({ id: schema.sequenceSteps.id }).from(schema.sequenceSteps).where(and(
          eq(schema.sequenceSteps.workspaceId, ctx.workspaceId),
          inArray(schema.sequenceSteps.sequenceVersionId, versionIds),
        ));
        const messageIds = tx.select({ id: schema.messages.id }).from(schema.messages).where(and(
          eq(schema.messages.workspaceId, ctx.workspaceId),
          or(
            inArray(schema.messages.enrollmentId, enrollmentIds),
            inArray(schema.messages.sequenceStepId, stepIds),
          ),
        ));

        await tx.delete(schema.sendAttempts).where(and(
          eq(schema.sendAttempts.workspaceId, ctx.workspaceId),
          inArray(schema.sendAttempts.messageId, messageIds),
        ));
        await tx.delete(schema.messageEvents).where(and(
          eq(schema.messageEvents.workspaceId, ctx.workspaceId),
          inArray(schema.messageEvents.messageId, messageIds),
        ));
        await tx.delete(schema.messages).where(and(
          eq(schema.messages.workspaceId, ctx.workspaceId),
          inArray(schema.messages.id, messageIds),
        ));
        await tx.delete(schema.enrollments).where(and(
          eq(schema.enrollments.workspaceId, ctx.workspaceId),
          eq(schema.enrollments.sequenceId, sequence.id),
        ));
        await tx.update(schema.sequences).set({ currentVersionId: null }).where(and(
          eq(schema.sequences.id, sequence.id),
          eq(schema.sequences.workspaceId, ctx.workspaceId),
        ));
        await tx.delete(schema.sequenceSteps).where(and(
          eq(schema.sequenceSteps.workspaceId, ctx.workspaceId),
          inArray(schema.sequenceSteps.sequenceVersionId, versionIds),
        ));
        await tx.delete(schema.sequenceVersions).where(and(
          eq(schema.sequenceVersions.workspaceId, ctx.workspaceId),
          eq(schema.sequenceVersions.sequenceId, sequence.id),
        ));
        await tx.delete(schema.campaigns).where(and(
          eq(schema.campaigns.workspaceId, ctx.workspaceId),
          eq(schema.campaigns.sequenceId, sequence.id),
        ));
        const deleted = await tx.delete(schema.sequences).where(and(
          eq(schema.sequences.id, sequence.id),
          eq(schema.sequences.workspaceId, ctx.workspaceId),
        )).returning({ id: schema.sequences.id });
        if (!deleted.length) throw new OpError("NOT_FOUND", "Sequence not found.");
      });
      return { deleted: true, id: input.id };
    },
  },
  {
    name: "sequences.duplicate",
    description: "Create a new draft copy of an existing sequence, including all steps, without copying enrollments.",
    access: "write",
    inputSchema: z.object({ id }),
    outputSchema: anyOutput,
    handler: async (ctx, input) => {
      const [source] = await ctx.db.select().from(schema.sequences).where(and(eq(schema.sequences.id, input.id), eq(schema.sequences.workspaceId, ctx.workspaceId)));
      if (!source) throw new OpError("NOT_FOUND", "Sequence not found.");
      const [version] = await ctx.db.select().from(schema.sequenceVersions).where(eq(schema.sequenceVersions.sequenceId, source.id)).orderBy(desc(schema.sequenceVersions.version)).limit(1);
      if (!version) throw new OpError("CONFLICT", "Sequence has no version to duplicate.");
      const steps = await ctx.db.select().from(schema.sequenceSteps).where(eq(schema.sequenceSteps.sequenceVersionId, version.id)).orderBy(schema.sequenceSteps.stepOrder);
      const sequenceId = randomUUID();
      const versionId = randomUUID();
      await ctx.db.transaction(async (tx) => {
        await tx.insert(schema.sequences).values({ id: sequenceId, workspaceId: ctx.workspaceId, name: `${source.name} (copy)`, status: "draft" });
        await tx.insert(schema.sequenceVersions).values({ id: versionId, workspaceId: ctx.workspaceId, sequenceId, version: 1, status: "draft", snapshot: version.snapshot });
        if (steps.length) await tx.insert(schema.sequenceSteps).values(steps.map((step) => ({ id: randomUUID(), workspaceId: ctx.workspaceId, sequenceVersionId: versionId, stepOrder: step.stepOrder, delayDays: step.delayDays, subject: step.subject, bodyText: step.bodyText, bodyHtml: step.bodyHtml, variables: step.variables })));
        await tx.update(schema.sequences).set({ currentVersionId: versionId, updatedAt: new Date() }).where(eq(schema.sequences.id, sequenceId));
      });
      return { sequence: (await readSequences(ctx)).find((item) => item.id === sequenceId) };
    },
  },
  {
    name: "sequences.analytics",
    description: "Get delivery and enrollment analytics for a sequence in the authenticated workspace.",
    access: "read",
    inputSchema: sequenceAnalyticsInput,
    outputSchema: anyOutput,
    handler: async (ctx, input) => {
      const sequence = await sequenceFor(ctx, input.id);
      const [storedSequence] = await ctx.db.select({ id: schema.sequences.id, currentVersionId: schema.sequences.currentVersionId }).from(schema.sequences).where(and(eq(schema.sequences.id, input.id), eq(schema.sequences.workspaceId, ctx.workspaceId))).limit(1);
      if (!storedSequence) throw new OpError("NOT_FOUND", "Sequence not found.");
      const versions = await ctx.db.select({ id: schema.sequenceVersions.id, version: schema.sequenceVersions.version, status: schema.sequenceVersions.status, createdAt: schema.sequenceVersions.createdAt, updatedAt: schema.sequenceVersions.updatedAt })
        .from(schema.sequenceVersions)
        .where(and(eq(schema.sequenceVersions.sequenceId, sequence.id), eq(schema.sequenceVersions.workspaceId, ctx.workspaceId)))
        .orderBy(desc(schema.sequenceVersions.version));
      const currentVersion = versions.find((version) => version.id === storedSequence.currentVersionId) ?? versions[0] ?? null;
      const selectedVersions = input.version === "all" ? versions : typeof input.version === "number" ? versions.filter((version) => version.version === input.version) : currentVersion ? [currentVersion] : [];
      if (typeof input.version === "number" && !selectedVersions.length) throw new OpError("NOT_FOUND", "Sequence version not found.");
      const selectedVersionIds = selectedVersions.map((version) => version.id);
      const versionFilter = input.version === "all" ? undefined : selectedVersionIds.length ? inArray(schema.sequenceVersions.id, selectedVersionIds) : sql`false`;
      const steps = await ctx.db.select({ id: schema.sequenceSteps.id, stepOrder: schema.sequenceSteps.stepOrder, subject: schema.sequenceSteps.subject, sequenceVersionId: schema.sequenceSteps.sequenceVersionId, version: schema.sequenceVersions.version })
        .from(schema.sequenceSteps)
        .innerJoin(schema.sequenceVersions, eq(schema.sequenceSteps.sequenceVersionId, schema.sequenceVersions.id))
        .where(and(eq(schema.sequenceVersions.sequenceId, sequence.id), eq(schema.sequenceVersions.workspaceId, ctx.workspaceId), versionFilter))
        .orderBy(schema.sequenceVersions.version, schema.sequenceSteps.stepOrder);
      const rows = await ctx.db.select({ messageId: schema.messages.id, stepId: schema.messages.sequenceStepId, messageStatus: schema.messages.status, acceptedAt: schema.messages.acceptedAt, enrollmentId: schema.enrollments.id, enrollmentStatus: schema.enrollments.status, repliedAt: schema.contacts.repliedAt, stoppedAt: schema.enrollments.stoppedAt })
        .from(schema.messages)
        .innerJoin(schema.enrollments, eq(schema.messages.enrollmentId, schema.enrollments.id))
        .innerJoin(schema.contacts, eq(schema.enrollments.contactId, schema.contacts.id))
        .where(and(eq(schema.enrollments.sequenceId, sequence.id), eq(schema.enrollments.workspaceId, ctx.workspaceId)));
      const enrollmentRows = await ctx.db.select({ id: schema.enrollments.id, status: schema.enrollments.status })
        .from(schema.enrollments)
        .where(and(eq(schema.enrollments.sequenceId, sequence.id), eq(schema.enrollments.workspaceId, ctx.workspaceId)));
      const messageIds = rows.map((row) => row.messageId);
      const openRows = messageIds.length ? await ctx.db.select({ messageId: schema.messageEvents.messageId, metadata: schema.messageEvents.metadata }).from(schema.messageEvents).where(and(eq(schema.messageEvents.workspaceId, ctx.workspaceId), eq(schema.messageEvents.eventType, "opened"), inArray(schema.messageEvents.messageId, messageIds))) : [];
      const openedIds = new Set(openRows.flatMap((row) => row.messageId && row.metadata.bot !== true ? [row.messageId] : []));
      type Metrics = { scheduled: number; sent: number; replied: number; opened: number; bounced: number; failed: number; unsubscribed: number };
      const blank = (): Metrics => ({ scheduled: 0, sent: 0, replied: 0, opened: 0, bounced: 0, failed: 0, unsubscribed: 0 });
      const byStep = new Map<string, Metrics>(steps.map((step) => [step.id, blank()]));
      const totals = blank();
      for (const row of rows) {
        const metrics = byStep.get(row.stepId) ?? blank();
        if (row.messageStatus === "scheduled" || row.messageStatus === "retryable") { metrics.scheduled++; totals.scheduled++; }
        if (row.messageStatus === "accepted") { metrics.sent++; totals.sent++; }
        if (openedIds.has(row.messageId)) { metrics.opened++; totals.opened++; }
        if (row.messageStatus === "failed") { metrics.failed++; totals.failed++; }
        if (row.enrollmentStatus === "bounced") { metrics.bounced++; totals.bounced++; }
        byStep.set(row.stepId, metrics);
      }
      const messagesByEnrollment = new Map<string, typeof rows>();
      for (const row of rows) {
        const messages = messagesByEnrollment.get(row.enrollmentId) ?? [];
        messages.push(row);
        messagesByEnrollment.set(row.enrollmentId, messages);
      }
      for (const enrollment of enrollmentRows.filter((row) => row.status === "replied")) {
        totals.replied++;
        const messages = messagesByEnrollment.get(enrollment.id) ?? [];
        const replyAt = messages.find((message) => message.repliedAt)?.repliedAt ?? messages.find((message) => message.stoppedAt)?.stoppedAt;
        const accepted = messages.filter((message) => message.messageStatus === "accepted" && message.acceptedAt);
        const acceptedBeforeReply = replyAt ? accepted.filter((message) => message.acceptedAt! <= replyAt) : accepted;
        const attributed = (acceptedBeforeReply.length ? acceptedBeforeReply : accepted).sort((left, right) => right.acceptedAt!.getTime() - left.acceptedAt!.getTime())[0];
        if (attributed) (byStep.get(attributed.stepId) ?? blank()).replied++;
      }
      for (const enrollment of enrollmentRows.filter((row) => row.status === "unsubscribed")) {
        totals.unsubscribed++;
        const accepted = (messagesByEnrollment.get(enrollment.id) ?? [])
          .filter((message) => message.messageStatus === "accepted" && message.acceptedAt)
          .sort((left, right) => right.acceptedAt!.getTime() - left.acceptedAt!.getTime());
        const attributed = accepted[0];
        if (attributed) (byStep.get(attributed.stepId) ?? blank()).unsubscribed++;
      }
      const enrollmentStatus = enrollmentRows.reduce<Record<string, number>>((counts, row) => ({ ...counts, [row.status]: (counts[row.status] ?? 0) + 1 }), {});
      return {
        sequenceId: sequence.id,
        currentVersion: currentVersion?.version ?? null,
        selectedVersion: input.version === "all" ? "all" : selectedVersions[0]?.version ?? null,
        versions: versions.map((version) => ({ id: version.id, version: version.version, status: version.status, current: version.id === storedSequence.currentVersionId, createdAt: version.createdAt.toISOString(), updatedAt: version.updatedAt.toISOString() })),
        totals: { ...totals, openRate: percent(totals.opened, totals.sent), replyRate: percent(totals.replied, totals.sent), unsubscribeRate: percent(totals.unsubscribed, totals.sent) },
        enrollmentStatus,
        steps: steps.map((step) => { const metrics = byStep.get(step.id)!; return { stepId: step.id, stepOrder: step.stepOrder, subject: step.subject, version: step.version, ...metrics, openRate: percent(metrics.opened, metrics.sent), replyRate: percent(metrics.replied, metrics.sent), unsubscribeRate: percent(metrics.unsubscribed, metrics.sent) }; }),
      };
    },
  },
  {
    name: "sequences.preview",
    description: "Preview a sequence's email steps for a lead. Use contactId to personalize the preview when available.",
    access: "read",
    inputSchema: z.object({ id, contactId: id.optional() }),
    outputSchema: anyOutput,
    handler: async (ctx, input) => {
      const sequence = await sequenceFor(ctx, input.id);
      let lead: { firstName: string; lastName: string; company: string; title: string; email: string } = { firstName: "Ada", lastName: "Lovelace", company: "Example Co", title: "Founder", email: "ada@example.com" };
      let variableSource: LeadVariableSource = { ...lead };
      if (input.contactId) {
        const [contact] = await ctx.db.select().from(schema.contacts).where(and(eq(schema.contacts.id, input.contactId), eq(schema.contacts.workspaceId, ctx.workspaceId)));
        if (!contact) throw new OpError("NOT_FOUND", "Contact not found.");
        lead = { firstName: contact.firstName ?? "", lastName: contact.lastName ?? "", company: contact.company ?? "", title: contact.title ?? "", email: contact.email };
        const campaignVariables = (await loadLeadVariables(ctx.db, ctx.workspaceId, sequence.id, [contact.id])).get(contact.id) ?? {};
        variableSource = { ...lead, customFields: contact.customFields as Record<string, unknown> | null, campaignVariables };
      }
      // Sequences published before custom variables shipped preview like they always did.
      const renderOptions = { enforceCustom: await isCustomVariablesEnforced(ctx.db, ctx.workspaceId, sequence.id) };
      return {
        sequenceId: sequence.id,
        contact: lead,
        steps: sequence.steps.map((step, index) => {
          const subject = renderTemplateWithPlaceholders(step.subject, variableSource, renderOptions);
          const body = renderTemplateWithPlaceholders(step.body, variableSource, renderOptions);
          return { stepId: step.id, stepOrder: index + 1, subject: subject.text, body: body.text, missingVariables: [...new Set([...subject.missing, ...body.missing])].sort() };
        }),
      };
    },
  },
  {
    name: "sequences.setMailboxes",
    description: "Save up to 50 sender mailboxIds for a sequence and reassign only enrollments waiting for their first send. An empty selection rotates across all healthy mailboxes.",
    access: "write",
    inputSchema: z.object({ id, mailboxIds: sequenceMailboxIdsSchema }),
    outputSchema: anyOutput,
    handler: async (ctx, input) => {
      await requireWorkspaceManager(ctx);
      const mailboxIds: string[] = input.mailboxIds;
      const reassigned = await ctx.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('send-capacity:' || ${ctx.workspaceId}::text))`);
        const [storedSequence] = await tx.select().from(schema.sequences).where(and(
          eq(schema.sequences.id, input.id),
          eq(schema.sequences.workspaceId, ctx.workspaceId),
        )).for("update");
        if (!storedSequence) throw new OpError("NOT_FOUND", "Sequence not found.");
        if (storedSequence.status === "archived") throw new OpError("CONFLICT", "Archived campaigns cannot change sender mailboxes.");

        const workspaceMailboxes = await tx.select({
          id: schema.emailAccounts.id,
          status: schema.emailAccounts.status,
          email: schema.emailAccounts.email,
          healthState: schema.mailboxHealth.state,
        }).from(schema.emailAccounts)
          .leftJoin(schema.mailboxHealth, eq(schema.mailboxHealth.emailAccountId, schema.emailAccounts.id))
          // Includes deleted mailboxes: a saved list may still hold one (see removeMailbox),
          // and re-saving it must not fail. They are never sendable.
          .where(eq(schema.emailAccounts.workspaceId, ctx.workspaceId))
          .orderBy(schema.emailAccounts.id);
        const mailboxRows = workspaceMailboxes.filter((mailbox) => mailboxIds.includes(mailbox.id));
        if (mailboxRows.length !== mailboxIds.length) throw new OpError("BAD_INPUT", "One or more mailboxes do not belong to this workspace.");

        await tx.delete(schema.sequenceEmailAccounts).where(and(
          eq(schema.sequenceEmailAccounts.sequenceId, input.id),
          eq(schema.sequenceEmailAccounts.workspaceId, ctx.workspaceId),
        ));
        if (mailboxIds.length) await tx.insert(schema.sequenceEmailAccounts).values(mailboxIds.map((emailAccountId) => ({
          sequenceId: input.id,
          emailAccountId,
          workspaceId: ctx.workspaceId,
        })));
        await tx.update(schema.sequences).set({ updatedAt: new Date() }).where(and(
          eq(schema.sequences.id, input.id),
          eq(schema.sequences.workspaceId, ctx.workspaceId),
        ));

        // Targets are the sendable mailboxes in the effective sender set: the saved
        // selection, or every workspace mailbox when the selection is empty.
        const sendableMailboxes = (mailboxIds.length ? mailboxRows : workspaceMailboxes).filter(isSendableSequenceMailbox);
        return reassignWaitingEnrollments(tx, { workspaceId: ctx.workspaceId, sequenceId: input.id, sendableMailboxIds: sendableMailboxes.map((mailbox) => mailbox.id) });
      });
      return { sequence: { ...await sequenceFor(ctx, input.id), mailboxIds }, mailboxIds, reassigned };
    },
  },
  {
    name: "sequences.enroll",
    description: "Enroll selected leads or the distinct union of up to 20 contact lists in a published sequence. Use listIds for multiple lists or legacy listId for one list. Saved sender mailboxes apply unless inboxIds or inboxId is supplied. When the sequence has exactly one launched campaign, the enrollment joins it: a finished campaign restarts and sends begin, and a paused campaign rejects the enrollment until it is resumed. A draft sequence instead queues the contacts: nothing is scheduled, and they convert to real enrollments when the sequence is published.",
    access: "write",
    inputSchema: z.object({ id, leadIds: z.array(id).optional(), listIds: listIds.optional(), listId: id.optional(), listName: z.string().optional(), inboxId: id.optional(), inboxIds: z.array(id).optional(), campaignId: id.optional() }),
    outputSchema: anyOutput,
    handler: enrollSequence,
  },
  {
    name: "sequences.queued",
    description: "List the contacts queued on a draft sequence, waiting for it to be published.",
    access: "read",
    inputSchema: z.object({ id }),
    outputSchema: anyOutput,
    handler: async (ctx, input) => {
      const sequence = await sequenceFor(ctx, input.id);
      const rows = await ctx.db.select({
        leadId: schema.stagedEnrollments.leadId,
        createdAt: schema.stagedEnrollments.createdAt,
        email: schema.contacts.email,
        firstName: schema.contacts.firstName,
        lastName: schema.contacts.lastName,
        company: schema.contacts.company,
      }).from(schema.stagedEnrollments)
        .innerJoin(schema.contacts, eq(schema.contacts.id, schema.stagedEnrollments.leadId))
        .where(and(eq(schema.stagedEnrollments.workspaceId, ctx.workspaceId), eq(schema.stagedEnrollments.sequenceId, input.id)))
        .orderBy(desc(schema.stagedEnrollments.createdAt));
      return { sequenceId: sequence.id, queued: rows.map((row) => ({ leadId: row.leadId, email: row.email, firstName: row.firstName, lastName: row.lastName, company: row.company, queuedAt: row.createdAt.toISOString() })) };
    },
  },
  {
    name: "sequences.dequeue",
    description: "Remove contacts from a draft sequence's enrollment queue without publishing. Omit leadIds to clear the whole queue.",
    access: "write",
    inputSchema: z.object({ id, leadIds: z.array(id).max(1000).optional() }),
    outputSchema: anyOutput,
    handler: async (ctx, input) => {
      await requireWorkspaceManager(ctx);
      const sequence = await sequenceFor(ctx, input.id);
      const removed = await ctx.db.delete(schema.stagedEnrollments).where(and(
        eq(schema.stagedEnrollments.workspaceId, ctx.workspaceId),
        eq(schema.stagedEnrollments.sequenceId, input.id),
        input.leadIds?.length ? inArray(schema.stagedEnrollments.leadId, input.leadIds) : undefined,
      )).returning({ leadId: schema.stagedEnrollments.leadId });
      return { sequence: { ...sequence, queuedCount: Math.max(0, sequence.queuedCount - removed.length) }, removed: removed.length };
    },
  },
  {
    name: "leads.list",
    description: "List leads in the authenticated workspace with optional list, search, status filter, and pagination.",
    access: "read",
    inputSchema: z.object({
      q: z.string().max(200).optional(),
      status: z.enum(["active", "enrolled", "replied", "bounced", "suppressed", "unsubscribed"]).optional(),
      listId: id.optional(),
      page: z.number().int().min(1).optional(),
      pageSize: z.number().int().min(1).max(200).optional(),
    }),
    outputSchema: anyOutput,
    handler: async (ctx, input) => {
      const all = await readLeads(ctx);
      const listLeadIds = input.listId
        ? new Set((await ctx.db.select({ contactId: schema.contactListMembers.contactId }).from(schema.contactListMembers).where(and(eq(schema.contactListMembers.workspaceId, ctx.workspaceId), eq(schema.contactListMembers.contactListId, input.listId)))).map((member) => member.contactId))
        : null;
      const q = input.q?.trim().toLowerCase();
      const filtered = all.filter((lead) => {
        if (listLeadIds && !listLeadIds.has(lead.id)) return false;
        if (input.status && lead.status.toLowerCase() !== input.status) return false;
        if (!q) return true;
        return [lead.email, lead.firstName, lead.lastName, lead.company, lead.title].some((field) => field.toLowerCase().includes(q));
      });
      const pageSize = input.pageSize ?? 50;
      const page = input.page ?? 1;
      return {
        workspaceId: ctx.workspaceId,
        leads: filtered.slice((page - 1) * pageSize, page * pageSize),
        pagination: { page, pageSize, total: filtered.length },
      };
    },
  },
  {
    name: "leads.delete",
    description: "Delete leads by id. Leads with enrollment history are skipped rather than deleted.",
    access: "write",
    inputSchema: z.object({ ids: z.array(id).min(1).max(100) }),
    outputSchema: anyOutput,
    handler: async (ctx, input) => {
      let deleted = 0;
      let skipped = 0;
      for (const leadId of input.ids) {
        const [contact] = await ctx.db.select({ id: schema.contacts.id }).from(schema.contacts)
          .where(and(eq(schema.contacts.id, leadId), eq(schema.contacts.workspaceId, ctx.workspaceId))).limit(1);
        if (!contact) { skipped += 1; continue; }
        const [enrollment] = await ctx.db.select({ id: schema.enrollments.id }).from(schema.enrollments)
          .where(and(eq(schema.enrollments.workspaceId, ctx.workspaceId), eq(schema.enrollments.contactId, leadId))).limit(1);
        if (enrollment) { skipped += 1; continue; }
        await ctx.db.delete(schema.contactListMembers).where(eq(schema.contactListMembers.contactId, leadId));
        const gone = await ctx.db.delete(schema.contacts)
          .where(and(eq(schema.contacts.id, leadId), eq(schema.contacts.workspaceId, ctx.workspaceId)))
          .returning({ id: schema.contacts.id });
        deleted += gone.length;
      }
      return { deleted, skipped };
    },
  },
  {
    name: "lists.create",
    description: "Create a contact list in the authenticated workspace.",
    access: "write",
    inputSchema: z.object({ name: z.string().trim().min(1).max(80) }),
    outputSchema: anyOutput,
    handler: async (ctx, input) => {
      const [list] = await ctx.db.insert(schema.contactLists).values({ id: randomUUID(), workspaceId: ctx.workspaceId, name: input.name, createdByUserId: ctx.userId }).onConflictDoNothing().returning({ id: schema.contactLists.id, name: schema.contactLists.name });
      if (!list) throw new OpError("CONFLICT", "A list with that name already exists.");
      return { list: { ...list, count: 0, leadCount: 0, repliedCount: 0, bouncedCount: 0 } };
    },
  },
  {
    name: "lists.rename",
    description: "Rename a contact list in the authenticated workspace.",
    access: "write",
    inputSchema: z.object({ id, name: z.string().trim().min(1).max(80) }),
    outputSchema: anyOutput,
    handler: async (ctx, input) => {
      const [existing] = await ctx.db.select({ id: schema.contactLists.id, name: schema.contactLists.name }).from(schema.contactLists).where(and(eq(schema.contactLists.id, input.id), eq(schema.contactLists.workspaceId, ctx.workspaceId))).limit(1);
      if (!existing) throw new OpError("NOT_FOUND", "Contact list not found.");
      if (existing.name === input.name) return { list: existing };
      const [duplicate] = await ctx.db.select({ id: schema.contactLists.id }).from(schema.contactLists).where(and(eq(schema.contactLists.workspaceId, ctx.workspaceId), eq(schema.contactLists.name, input.name))).limit(1);
      if (duplicate) throw new OpError("CONFLICT", "A list with that name already exists.");
      const [list] = await ctx.db.update(schema.contactLists).set({ name: input.name, updatedAt: new Date() }).where(and(eq(schema.contactLists.id, input.id), eq(schema.contactLists.workspaceId, ctx.workspaceId))).returning({ id: schema.contactLists.id, name: schema.contactLists.name });
      if (!list) throw new OpError("NOT_FOUND", "Contact list not found.");
      return { list };
    },
  },
  {
    name: "lists.delete",
    description: "Delete a contact list while keeping its leads.",
    access: "write",
    inputSchema: z.object({ id }),
    outputSchema: anyOutput,
    handler: async (ctx, input) => {
      const deleted = await ctx.db.transaction(async (tx) => {
        const [list] = await tx.select({ id: schema.contactLists.id }).from(schema.contactLists).where(and(eq(schema.contactLists.id, input.id), eq(schema.contactLists.workspaceId, ctx.workspaceId))).limit(1).for("update");
        if (!list) throw new OpError("NOT_FOUND", "Contact list not found.");
        // A campaign with zero lists enrolls all ready leads, so a campaign that can
        // still enroll keeps its last list. Finished and archived campaigns, and
        // campaigns on an archived sequence (which can never publish or enroll again),
        // release the list; a campaign with other lists just narrows.
        const [soleAudienceCampaign] = await tx.select({ name: schema.campaigns.name, status: schema.campaigns.status }).from(schema.campaignContactLists)
          .innerJoin(schema.campaigns, and(eq(schema.campaigns.id, schema.campaignContactLists.campaignId), eq(schema.campaigns.workspaceId, ctx.workspaceId)))
          .innerJoin(schema.sequences, eq(schema.sequences.id, schema.campaigns.sequenceId))
          .where(and(
            eq(schema.campaignContactLists.workspaceId, ctx.workspaceId),
            eq(schema.campaignContactLists.contactListId, input.id),
            sql`${schema.campaigns.status} not in ('completed', 'archived')`,
            sql`${schema.sequences.status} <> 'archived'`,
            sql`not exists (select 1 from ${schema.campaignContactLists} other_list where other_list.campaign_id = ${schema.campaigns.id} and other_list.contact_list_id <> ${input.id})`,
          )).limit(1);
        if (soleAudienceCampaign) throw new OpError("CONFLICT", `This list is the only audience for the ${soleAudienceCampaign.status} campaign "${soleAudienceCampaign.name}". Add another list to that campaign or archive it, then delete this list.`);
        const primaryCampaigns = await tx.select({ id: schema.campaigns.id }).from(schema.campaigns).where(and(eq(schema.campaigns.workspaceId, ctx.workspaceId), eq(schema.campaigns.contactListId, input.id)));
        await tx.delete(schema.contactListMembers).where(and(eq(schema.contactListMembers.contactListId, input.id), eq(schema.contactListMembers.workspaceId, ctx.workspaceId)));
        const rows = await tx.delete(schema.contactLists).where(and(eq(schema.contactLists.id, input.id), eq(schema.contactLists.workspaceId, ctx.workspaceId))).returning({ id: schema.contactLists.id });
        if (primaryCampaigns.length) {
          const campaignIds = primaryCampaigns.map((campaign) => campaign.id);
          const remaining = await tx.select({ campaignId: schema.campaignContactLists.campaignId, contactListId: schema.campaignContactLists.contactListId }).from(schema.campaignContactLists)
            .where(and(eq(schema.campaignContactLists.workspaceId, ctx.workspaceId), inArray(schema.campaignContactLists.campaignId, campaignIds)))
            .orderBy(schema.campaignContactLists.createdAt, schema.campaignContactLists.contactListId);
          const firstByCampaign = new Map<string, string>();
          for (const audience of remaining) if (!firstByCampaign.has(audience.campaignId)) firstByCampaign.set(audience.campaignId, audience.contactListId);
          for (const campaignId of campaignIds) await tx.update(schema.campaigns).set({ contactListId: firstByCampaign.get(campaignId) ?? null, updatedAt: new Date() }).where(and(eq(schema.campaigns.id, campaignId), eq(schema.campaigns.workspaceId, ctx.workspaceId)));
        }
        return rows;
      });
      return { deleted: deleted.length };
    },
  },
  {
    name: "lists.addLeads",
    description: "Add leads to a contact list, ignoring existing memberships. New members of a list used by an active or finished campaign are automatically enrolled and can start sends.",
    access: "write",
    inputSchema: z.object({ id, leadIds: z.array(id).min(1).max(500) }),
    outputSchema: anyOutput,
    handler: async (ctx, input) => {
      const [list] = await ctx.db.select({ id: schema.contactLists.id }).from(schema.contactLists).where(and(eq(schema.contactLists.id, input.id), eq(schema.contactLists.workspaceId, ctx.workspaceId))).limit(1);
      if (!list) throw new OpError("NOT_FOUND", "Contact list not found.");
      const leadIds = [...new Set<string>(input.leadIds as string[])];
      const leads = await ctx.db.select({ id: schema.contacts.id }).from(schema.contacts).where(and(eq(schema.contacts.workspaceId, ctx.workspaceId), inArray(schema.contacts.id, leadIds)));
      if (!leads.length) return { added: 0, campaignUpdates: [] };
      const added = await ctx.db.insert(schema.contactListMembers).values(leads.map((lead) => ({ workspaceId: ctx.workspaceId, contactListId: input.id, contactId: lead.id, addedByUserId: ctx.userId }))).onConflictDoNothing().returning({ contactId: schema.contactListMembers.contactId });
      return { added: added.length, ...await enrollNewListLeads(ctx, { listId: input.id, leadIds: added.map((row) => row.contactId) }) };
    },
  },
  {
    name: "lists.list",
    description: "List contact lists and their member status counts in the authenticated workspace.",
    access: "read",
    inputSchema: z.object({}),
    outputSchema: anyOutput,
    handler: async (ctx) => ({
      lists: await ctx.db.select({
        id: schema.contactLists.id,
        name: schema.contactLists.name,
        count: sql<number>`count(${schema.contactListMembers.contactId})`.mapWith(Number),
        leadCount: sql<number>`count(${schema.contactListMembers.contactId})`.mapWith(Number),
        repliedCount: sql<number>`count(${schema.contactListMembers.contactId}) filter (where ${schema.contacts.status} = 'replied')`.mapWith(Number),
        bouncedCount: sql<number>`count(${schema.contactListMembers.contactId}) filter (where ${schema.contacts.status} = 'bounced')`.mapWith(Number),
      }).from(schema.contactLists)
        .leftJoin(schema.contactListMembers, and(eq(schema.contactListMembers.contactListId, schema.contactLists.id), eq(schema.contactListMembers.workspaceId, ctx.workspaceId)))
        .leftJoin(schema.contacts, and(eq(schema.contacts.id, schema.contactListMembers.contactId), eq(schema.contacts.workspaceId, ctx.workspaceId)))
        .where(eq(schema.contactLists.workspaceId, ctx.workspaceId))
        .groupBy(schema.contactLists.id, schema.contactLists.name, schema.contactLists.createdAt)
        .orderBy(desc(schema.contactLists.createdAt)),
    }),
  },
  { name: "suppressions.list", description: "List suppressed recipient email addresses for the authenticated workspace.", access: "read", inputSchema: z.object({}), outputSchema: anyOutput, handler: async (ctx) => ({ suppressions: (await ctx.db.select({ id: schema.suppressions.id, email: schema.suppressions.email, reason: schema.suppressions.reason, source: schema.suppressions.source, createdAt: schema.suppressions.createdAt }).from(schema.suppressions).where(eq(schema.suppressions.workspaceId, ctx.workspaceId)).orderBy(desc(schema.suppressions.createdAt)).limit(500)).map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })) }) },
  { name: "suppressions.add", description: "Manually suppress an email address in the authenticated workspace to prevent future delivery.", access: "write", inputSchema: z.object({ email: z.string().email(), reason: z.string().max(80).optional() }), outputSchema: anyOutput, handler: async (ctx, input) => { const email = input.email.trim(); const normalizedEmail = email.toLowerCase(); const emailHash = createHash("sha256").update(normalizedEmail).digest("hex"); const [created] = await ctx.db.insert(schema.suppressions).values({ id: randomUUID(), workspaceId: ctx.workspaceId, email, normalizedEmail, emailHash, reason: input.reason?.trim() || "manual_suppression", source: "manual" }).onConflictDoNothing().returning(); const suppression = created ?? (await ctx.db.select().from(schema.suppressions).where(and(eq(schema.suppressions.workspaceId, ctx.workspaceId), or(eq(schema.suppressions.emailHash, emailHash), eq(schema.suppressions.normalizedEmail, normalizedEmail)))).limit(1))[0]; if (!suppression) throw new OpError("CONFLICT", "The email address could not be suppressed."); const [target] = await ctx.db.select({ id: schema.contacts.id }).from(schema.contacts).where(and(eq(schema.contacts.workspaceId, ctx.workspaceId), eq(schema.contacts.normalizedEmail, normalizedEmail))).limit(1); if (target) await cascadeSuppression(ctx.db, { workspaceId: ctx.workspaceId, contactId: target.id, reason: suppression.reason }); return { suppression: { id: suppression.id, email: suppression.email, reason: suppression.reason, source: suppression.source, createdAt: suppression.createdAt.toISOString() }, alreadySuppressed: !created }; } },
  { name: "suppressions.remove", description: "Remove a manual suppression by its ID within the authenticated workspace.", access: "write", inputSchema: z.object({ id }), outputSchema: anyOutput, handler: async (ctx, input) => { await requireWorkspaceOwner(ctx); const deleted = await ctx.db.delete(schema.suppressions).where(and(eq(schema.suppressions.id, input.id), eq(schema.suppressions.workspaceId, ctx.workspaceId))).returning({ id: schema.suppressions.id }); if (!deleted.length) throw new OpError("NOT_FOUND", "Suppression not found."); return { removed: true }; } },
  { name: "workspace.get", description: "Get the authenticated workspace's settings and identity.", access: "read", inputSchema: z.object({}), outputSchema: anyOutput, handler: async (ctx) => { const [workspace] = await ctx.db.select({ id: schema.workspaces.id, name: schema.workspaces.name, status: schema.workspaces.status, defaultTimezone: schema.workspaces.defaultTimezone, dailySendCap: schema.workspaces.dailySendCap, killSwitchEnabled: schema.workspaces.killSwitchEnabled, openTrackingEnabled: schema.workspaces.openTrackingEnabled, postalAddress: schema.workspaces.postalAddress }).from(schema.workspaces).where(eq(schema.workspaces.id, ctx.workspaceId)); if (!workspace) throw new OpError("NOT_FOUND", "Workspace not found."); return { workspace, role: await workspaceRole(ctx) }; } },
  {
    name: "workspace.update",
    description: "Update editable settings for the authenticated workspace.",
    access: "write",
    inputSchema: z.object({
      name: z.string().trim().min(1).max(160).optional(),
      defaultTimezone: z.string().trim().min(1).max(80).refine(validTimezone, "Enter a valid IANA timezone.").optional(),
      dailySendCap: z.number().int().min(1).max(100_000).optional(),
      killSwitchEnabled: z.boolean().optional(),
      openTrackingEnabled: z.boolean().optional(),
      postalAddress: z.string().max(1000).nullable().optional(),
    }).refine((input) => Object.values(input).some((value) => value !== undefined), "Provide at least one workspace setting."),
    outputSchema: anyOutput,
    handler: async (ctx, input) => {
      await requireWorkspaceManager(ctx);
      const updates: {
        name?: string;
        defaultTimezone?: string;
        dailySendCap?: number;
        killSwitchEnabled?: boolean;
        openTrackingEnabled?: boolean;
        postalAddress?: string | null;
        updatedAt: Date;
      } = { updatedAt: new Date() };
      if (input.name !== undefined) updates.name = input.name;
      if (input.defaultTimezone !== undefined) updates.defaultTimezone = input.defaultTimezone;
      if (input.dailySendCap !== undefined) updates.dailySendCap = input.dailySendCap;
      if (input.killSwitchEnabled !== undefined) updates.killSwitchEnabled = input.killSwitchEnabled;
      if (input.openTrackingEnabled !== undefined) updates.openTrackingEnabled = input.openTrackingEnabled;
      if (input.postalAddress !== undefined) updates.postalAddress = input.postalAddress?.trim() || null;
      const workspace = await ctx.db.transaction(async (tx) => {
        const [updated] = await tx.update(schema.workspaces).set(updates).where(eq(schema.workspaces.id, ctx.workspaceId)).returning({ id: schema.workspaces.id, name: schema.workspaces.name, status: schema.workspaces.status, defaultTimezone: schema.workspaces.defaultTimezone, dailySendCap: schema.workspaces.dailySendCap, killSwitchEnabled: schema.workspaces.killSwitchEnabled, openTrackingEnabled: schema.workspaces.openTrackingEnabled, postalAddress: schema.workspaces.postalAddress });
        if (updated && input.postalAddress !== undefined && updates.postalAddress) await tx.update(schema.enrollments).set({ status: sql`COALESCE(${schema.enrollments.statusBeforePause}, 'active'::enrollment_status)`, statusBeforePause: null, pausedAt: null, stopReason: null, updatedAt: new Date() }).where(and(eq(schema.enrollments.workspaceId, ctx.workspaceId), eq(schema.enrollments.status, "paused"), eq(schema.enrollments.stopReason, "postal_address_required")));
        return updated;
      });
      if (!workspace) throw new OpError("NOT_FOUND", "Workspace not found.");
      return { workspace };
    },
  },
  {
    name: "sending.get",
    description: "Get workspace sending limits and mailbox health.",
    access: "read",
    inputSchema: z.object({}),
    outputSchema: anyOutput,
    handler: async (ctx) => {
      const [workspace] = await ctx.db.select({ dailySendCap: schema.workspaces.dailySendCap, killSwitchEnabled: schema.workspaces.killSwitchEnabled, openTrackingEnabled: schema.workspaces.openTrackingEnabled }).from(schema.workspaces).where(eq(schema.workspaces.id, ctx.workspaceId));
      if (!workspace) throw new OpError("NOT_FOUND", "Workspace not found.");
      const rows = await ctx.db.select({
        id: schema.emailAccounts.id,
        email: schema.emailAccounts.email,
        displayName: schema.emailAccounts.displayName,
        provider: schema.emailAccounts.provider,
        status: schema.emailAccounts.status,
        dailyLimit: schema.emailAccounts.dailyLimit,
        healthState: schema.mailboxHealth.state,
        bounceRate: schema.mailboxHealth.bounceRate,
        replyRate: schema.mailboxHealth.replyRate,
        lastSuccessfulSendAt: schema.mailboxHealth.lastSuccessfulSendAt,
        effectiveDailyLimit: schema.mailboxHealth.effectiveDailyLimit,
      }).from(schema.emailAccounts).leftJoin(schema.mailboxHealth, and(eq(schema.mailboxHealth.emailAccountId, schema.emailAccounts.id), eq(schema.mailboxHealth.workspaceId, ctx.workspaceId))).where(and(eq(schema.emailAccounts.workspaceId, ctx.workspaceId), ne(schema.emailAccounts.status, "removed"))).orderBy(schema.emailAccounts.createdAt);
      return { workspace, role: await workspaceRole(ctx), mailboxes: rows.map((row) => ({ ...row, healthState: row.healthState ?? "unknown", bounceRate: Number(row.bounceRate ?? 0), replyRate: Number(row.replyRate ?? 0), effectiveDailyLimit: row.effectiveDailyLimit ?? row.dailyLimit, lastSuccessfulSendAt: row.lastSuccessfulSendAt?.toISOString() ?? null })) };
    },
  },
  {
    name: "workspaces.list",
    description: "List the signed-in user's active workspace memberships and current workspace.",
    access: "read",
    inputSchema: z.object({}),
    outputSchema: z.object({ workspaces: z.array(z.object({ id, name: z.string(), role: z.enum(["owner", "admin", "member"]), isCurrent: z.boolean() })) }),
    handler: async (ctx) => {
      const workspaces = await ctx.db.select({ id: schema.workspaces.id, name: schema.workspaces.name, role: schema.memberships.role })
        .from(schema.memberships)
        .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.memberships.workspaceId))
        .where(and(eq(schema.memberships.userId, ctx.userId), eq(schema.memberships.status, "active")))
        .orderBy(asc(schema.workspaces.name));
      return { workspaces: workspaces.map((workspace) => ({ ...workspace, isCurrent: workspace.id === ctx.workspaceId })) };
    },
  },
  {
    name: "workspaces.switch",
    description: "Set the signed-in user's active workspace to one of their active memberships.",
    access: "write",
    inputSchema: z.object({ workspaceId: id }),
    outputSchema: z.object({ workspaceId: id }),
    handler: async (ctx, input) => {
      const [updated] = await ctx.db.update(schema.users).set({ activeWorkspaceId: input.workspaceId, updatedAt: new Date() })
        .where(and(eq(schema.users.id, ctx.userId), inArray(schema.users.id,
          ctx.db.select({ userId: schema.memberships.userId }).from(schema.memberships)
            .where(and(eq(schema.memberships.userId, ctx.userId), eq(schema.memberships.workspaceId, input.workspaceId), eq(schema.memberships.status, "active"))),
        )))
        .returning({ workspaceId: schema.users.activeWorkspaceId });
      if (!updated) throw new OpError("NOT_FOUND", "Active workspace membership not found.");
      return { workspaceId: input.workspaceId };
    },
  },
  {
    name: "team.list",
    description: "List active members and pending invitations for the authenticated workspace.",
    access: "read",
    inputSchema: z.object({}),
    outputSchema: anyOutput,
    handler: async (ctx) => {
      const [role, members, invitations] = await Promise.all([
        workspaceRole(ctx),
        ctx.db.select({ id: schema.memberships.id, userId: schema.memberships.userId, email: schema.users.email, displayName: schema.users.displayName, role: schema.memberships.role, joinedAt: schema.memberships.joinedAt }).from(schema.memberships).innerJoin(schema.users, eq(schema.memberships.userId, schema.users.id)).where(and(eq(schema.memberships.workspaceId, ctx.workspaceId), eq(schema.memberships.status, "active"))).orderBy(schema.memberships.createdAt),
        ctx.db.select({ id: schema.invitations.id, email: schema.invitations.email, role: schema.invitations.role, expiresAt: schema.invitations.expiresAt, createdAt: schema.invitations.createdAt }).from(schema.invitations).where(and(eq(schema.invitations.workspaceId, ctx.workspaceId), isNull(schema.invitations.acceptedAt), gt(schema.invitations.expiresAt, new Date()))).orderBy(desc(schema.invitations.createdAt)),
      ]);
      return { role, members: members.map((member) => ({ ...member, joinedAt: member.joinedAt?.toISOString() ?? null })), invitations: invitations.map((invitation) => ({ ...invitation, expiresAt: invitation.expiresAt.toISOString(), createdAt: invitation.createdAt.toISOString() })) };
    },
  },
  {
    name: "team.invite",
    description: "Invite a teammate to the authenticated workspace.",
    access: "write",
    inputSchema: z.object({ email: z.string().trim().email().max(320), role: z.enum(["admin", "member"]).default("member") }),
    outputSchema: anyOutput,
    handler: async (ctx, input) => {
      await requireWorkspaceOwner(ctx);
      await requireVerifiedInviter(ctx);
      const normalizedEmail = input.email.toLowerCase();
      const [existingMember] = await ctx.db.select({ id: schema.memberships.id }).from(schema.memberships).innerJoin(schema.users, eq(schema.memberships.userId, schema.users.id)).where(and(eq(schema.memberships.workspaceId, ctx.workspaceId), eq(schema.users.normalizedEmail, normalizedEmail), eq(schema.memberships.status, "active"))).limit(1);
      if (existingMember) throw new OpError("CONFLICT", "That person is already a workspace member.");
      const token = `${ctx.workspaceId}.${randomBytes(32).toString("base64url")}`;
      const tokenHash = createHash("sha256").update(token).digest("hex");
      const expiresAt = new Date(Date.now() + 7 * 86_400_000);
      const invitation = await ctx.db.transaction(async (tx) => {
        await tx.select({ id: schema.workspaces.id }).from(schema.workspaces).where(eq(schema.workspaces.id, ctx.workspaceId)).for("no key update");
        await tx.delete(schema.invitations).where(and(eq(schema.invitations.workspaceId, ctx.workspaceId), eq(schema.invitations.normalizedEmail, normalizedEmail), isNull(schema.invitations.acceptedAt)));
        const [openInvitations] = await tx.select({ count: sql<number>`count(*)::int` }).from(schema.invitations)
          .where(and(eq(schema.invitations.workspaceId, ctx.workspaceId), isNull(schema.invitations.acceptedAt), gt(schema.invitations.expiresAt, new Date())));
        if ((openInvitations?.count ?? 0) >= 20) throw new OpError("CONFLICT", "This workspace has reached the limit of 20 open invitations. Revoke an invitation before inviting someone else.");
        const [created] = await tx.insert(schema.invitations).values({ id: randomUUID(), workspaceId: ctx.workspaceId, email: input.email, normalizedEmail, role: input.role, tokenHash, expiresAt, invitedByUserId: ctx.userId }).returning({ id: schema.invitations.id, email: schema.invitations.email, role: schema.invitations.role, expiresAt: schema.invitations.expiresAt, createdAt: schema.invitations.createdAt });
        return created;
      });
      let emailSent = false;
      if (ctx.env.webBaseUrl && ctx.transactionalEmail?.enabled) {
        try {
          const [details] = await ctx.db.select({ workspaceName: schema.workspaces.name, inviterName: schema.users.displayName, inviterEmail: schema.users.email })
            .from(schema.workspaces).innerJoin(schema.users, eq(schema.users.id, ctx.userId))
            .where(eq(schema.workspaces.id, ctx.workspaceId)).limit(1);
          if (details) {
            await ctx.transactionalEmail.sendWorkspaceInvite({
              recipient: { email: input.email },
              inviterName: details.inviterName?.trim() || details.inviterEmail,
              workspaceName: details.workspaceName,
              role: input.role,
              acceptUrl: `${ctx.env.webBaseUrl.replace(/\/$/, "")}/app/invite/${token}`,
              expiresAt,
            });
            emailSent = true;
          }
        } catch {
          ctx.logger?.warn?.({ invitationId: invitation!.id }, "Workspace invitation email could not be sent.");
        }
      }
      return { invitation: { ...invitation!, expiresAt: invitation!.expiresAt.toISOString(), createdAt: invitation!.createdAt.toISOString() }, token, emailSent };
    },
  },
  {
    name: "team.inviteRevoke",
    description: "Revoke a pending workspace invitation.",
    access: "write",
    inputSchema: z.object({ id }),
    outputSchema: anyOutput,
    handler: async (ctx, input) => {
      await requireWorkspaceOwner(ctx);
      const deleted = await ctx.db.delete(schema.invitations).where(and(eq(schema.invitations.id, input.id), eq(schema.invitations.workspaceId, ctx.workspaceId), isNull(schema.invitations.acceptedAt))).returning({ id: schema.invitations.id });
      if (!deleted.length) throw new OpError("NOT_FOUND", "Pending invitation not found.");
      return { revoked: true };
    },
  },
  {
    name: "team.memberRemove",
    description: "Remove a non-owner member from the authenticated workspace.",
    access: "write",
    inputSchema: z.object({ id }),
    outputSchema: anyOutput,
    handler: async (ctx, input) => {
      await requireWorkspaceOwner(ctx);
      await ctx.db.transaction(async (tx) => {
        const [membership] = await tx.select({ id: schema.memberships.id, userId: schema.memberships.userId, role: schema.memberships.role }).from(schema.memberships).where(and(eq(schema.memberships.id, input.id), eq(schema.memberships.workspaceId, ctx.workspaceId), eq(schema.memberships.status, "active"))).limit(1);
        if (!membership) throw new OpError("NOT_FOUND", "Workspace member not found.");
        if (membership.role === "owner" || membership.userId === ctx.userId) throw new OpError("FORBIDDEN", "The workspace owner cannot be removed.");
        const revokedAt = new Date();
        await tx.update(schema.mcpGrants).set({ revokedAt }).where(and(eq(schema.mcpGrants.userId, membership.userId), eq(schema.mcpGrants.workspaceId, ctx.workspaceId), isNull(schema.mcpGrants.revokedAt)));
        await tx.update(schema.mcpOauthTokens).set({ revokedAt }).where(and(eq(schema.mcpOauthTokens.userId, membership.userId), eq(schema.mcpOauthTokens.workspaceId, ctx.workspaceId), isNull(schema.mcpOauthTokens.revokedAt)));
        await tx.delete(schema.memberships).where(and(eq(schema.memberships.id, membership.id), eq(schema.memberships.workspaceId, ctx.workspaceId)));
      });
      return { removed: true };
    },
  },
  {
    name: "team.memberRoleChange",
    description: "Change an active non-owner member's role in the authenticated workspace. Only workspace owners can complete this action.",
    access: "write",
    inputSchema: z.object({ id, role: z.enum(["admin", "member"]) }),
    outputSchema: z.object({ id, role: z.enum(["admin", "member"]) }),
    handler: async (ctx, input) => {
      await requireWorkspaceOwner(ctx);
      return ctx.db.transaction(async (tx) => {
        const [membership] = await tx.select({ id: schema.memberships.id, userId: schema.memberships.userId, role: schema.memberships.role }).from(schema.memberships).where(and(eq(schema.memberships.id, input.id), eq(schema.memberships.workspaceId, ctx.workspaceId), eq(schema.memberships.status, "active"))).limit(1).for("update");
        if (!membership) throw new OpError("NOT_FOUND", "Workspace member not found.");
        if (membership.role === "owner" || membership.userId === ctx.userId) throw new OpError("FORBIDDEN", "The workspace owner's role cannot be changed.");
        const [updated] = await tx.update(schema.memberships).set({ role: input.role, updatedAt: new Date() }).where(and(eq(schema.memberships.id, membership.id), eq(schema.memberships.workspaceId, ctx.workspaceId), eq(schema.memberships.status, "active"))).returning({ id: schema.memberships.id, role: schema.memberships.role });
        if (!updated) throw new OpError("NOT_FOUND", "Workspace member not found.");
        return updated;
      });
    },
  },
  {
    name: "team.invitePreview",
    description: "Show who sent a workspace invitation and whether the signed-in user can accept it.",
    access: "read",
    inputSchema: z.object({ token: z.string().min(20).max(200) }),
    outputSchema: anyOutput,
    handler: async (ctx, input) => {
      if (!invitationTokenWorkspaceId(input.token)) throw new OpError("NOT_FOUND", "This invitation link is invalid.");
      const invitation = await findInvitationByToken(ctx.db, input.token);
      if (!invitation) throw new OpError("NOT_FOUND", "This invitation link is invalid or was revoked.");
      const invitedWorkspaceId = invitation.workspaceId;
      const [[sender], user, [membership]] = await Promise.all([
        ctx.db.select({ workspaceName: schema.workspaces.name, inviterName: schema.users.displayName }).from(schema.invitations)
          .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.invitations.workspaceId))
          .leftJoin(schema.users, eq(schema.users.id, schema.invitations.invitedByUserId))
          .where(eq(schema.invitations.id, invitation.id)).limit(1),
        invitationUser(ctx),
        ctx.db.select({ id: schema.memberships.id }).from(schema.memberships)
          .where(and(eq(schema.memberships.workspaceId, invitedWorkspaceId), eq(schema.memberships.userId, ctx.userId), eq(schema.memberships.status, "active"))).limit(1),
      ]);
      if (!sender) throw new OpError("NOT_FOUND", "This invitation link is invalid or was revoked.");
      const status = membership ? "member"
        : invitation.acceptedAt ? "accepted"
        : invitation.expiresAt <= new Date() ? "expired"
        : !user ? "account_unavailable"
        : user.normalizedEmail !== invitation.normalizedEmail ? "wrong_email"
        : !user.emailVerified ? "verify_email"
        : "pending";
      const open = status === "pending" || status === "wrong_email" || status === "account_unavailable" || status === "verify_email";
      return {
        status,
        workspaceId: invitedWorkspaceId,
        workspaceName: sender.workspaceName,
        inviterName: sender.inviterName?.trim() || null,
        role: invitation.role,
        invitedEmail: open ? invitation.email : null,
        signedInEmail: user?.email ?? null,
        expiresAt: invitation.expiresAt.toISOString(),
      };
    },
  },
  {
    name: "team.inviteAccept",
    description: "Accept a workspace invitation for the signed-in user.",
    access: "write",
    inputSchema: z.object({ token: z.string().min(20).max(200) }),
    outputSchema: anyOutput,
    handler: async (ctx, input) => {
      if (!invitationTokenWorkspaceId(input.token)) throw new OpError("BAD_INPUT", "Invitation token is invalid.");
      const user = await invitationUser(ctx);
      if (!user) throw new OpError("NOT_FOUND", "User not found.");
      const invitation = await findInvitationByToken(ctx.db, input.token);
      if (!invitation || invitation.acceptedAt) throw new OpError("NOT_FOUND", "Invitation not found or already accepted.");
      if (invitation.expiresAt <= new Date()) throw new OpError("CONFLICT", "This invitation has expired.");
      if (invitation.normalizedEmail !== user.normalizedEmail) throw new OpError("FORBIDDEN", "This invitation was sent to a different email address.");
      // Signup does not require verification, so a matching address alone proves
      // nothing: anyone who saw the invite could register as the invitee first.
      if (!user.emailVerified) throw new OpError("FORBIDDEN", invitationVerificationRequiredMessage, { code: "verify_email" });
      await ctx.db.transaction(async (tx) => {
        const [accepted] = await tx.update(schema.invitations).set({ acceptedAt: new Date(), updatedAt: new Date() }).where(and(eq(schema.invitations.id, invitation.id), isNull(schema.invitations.acceptedAt), gt(schema.invitations.expiresAt, new Date()))).returning({ id: schema.invitations.id });
        if (!accepted) throw new OpError("CONFLICT", "This invitation is no longer available.");
        await tx.insert(schema.memberships).values({ id: randomUUID(), workspaceId: invitation.workspaceId, userId: ctx.userId, role: invitation.role, status: "active", invitedByUserId: invitation.invitedByUserId, joinedAt: new Date() }).onConflictDoUpdate({ target: [schema.memberships.workspaceId, schema.memberships.userId], set: { role: invitation.role, status: "active", invitedByUserId: invitation.invitedByUserId, joinedAt: new Date(), updatedAt: new Date() } });
        await tx.update(schema.users).set({ activeWorkspaceId: invitation.workspaceId, updatedAt: new Date() }).where(eq(schema.users.id, ctx.userId));
      });
      return { accepted: true, workspaceId: invitation.workspaceId };
    },
  },
  {
    name: "apiKeys.create",
    description: "Create an API key for the authenticated workspace. The plaintext key is returned once.",
    access: "write",
    inputSchema: z.object({ name: z.string().trim().min(1).max(160) }),
    outputSchema: anyOutput,
    handler: async (ctx, input) => {
      await requireWorkspaceOwner(ctx);
      const key = `ij_${randomBytes(24).toString("base64url")}`;
      const [apiKey] = await ctx.db.insert(schema.apiKeys).values({ id: randomUUID(), workspaceId: ctx.workspaceId, name: input.name, keyHash: createHash("sha256").update(key).digest("hex"), createdByUserId: ctx.userId }).returning({ id: schema.apiKeys.id, name: schema.apiKeys.name, createdAt: schema.apiKeys.createdAt, lastUsedAt: schema.apiKeys.lastUsedAt, revokedAt: schema.apiKeys.revokedAt });
      return { apiKey: { ...apiKey!, createdAt: apiKey!.createdAt.toISOString(), lastUsedAt: null, revokedAt: null }, key };
    },
  },
  {
    name: "apiKeys.list",
    description: "List API key metadata for the authenticated workspace without exposing key hashes.",
    access: "read",
    inputSchema: z.object({}),
    outputSchema: anyOutput,
    handler: async (ctx) => {
      await requireWorkspaceOwner(ctx);
      const apiKeys = await ctx.db.select({ id: schema.apiKeys.id, name: schema.apiKeys.name, createdAt: schema.apiKeys.createdAt, lastUsedAt: schema.apiKeys.lastUsedAt, revokedAt: schema.apiKeys.revokedAt }).from(schema.apiKeys).where(eq(schema.apiKeys.workspaceId, ctx.workspaceId)).orderBy(desc(schema.apiKeys.createdAt));
      return { apiKeys: apiKeys.map((apiKey) => ({ ...apiKey, createdAt: apiKey.createdAt.toISOString(), lastUsedAt: apiKey.lastUsedAt?.toISOString() ?? null, revokedAt: apiKey.revokedAt?.toISOString() ?? null })) };
    },
  },
  {
    name: "apiKeys.revoke",
    description: "Revoke an API key in the authenticated workspace.",
    access: "write",
    inputSchema: z.object({ id }),
    outputSchema: anyOutput,
    handler: async (ctx, input) => {
      await requireWorkspaceOwner(ctx);
      const revoked = await ctx.db.update(schema.apiKeys).set({ revokedAt: new Date() }).where(and(eq(schema.apiKeys.id, input.id), eq(schema.apiKeys.workspaceId, ctx.workspaceId), isNull(schema.apiKeys.revokedAt))).returning({ id: schema.apiKeys.id });
      if (!revoked.length) throw new OpError("NOT_FOUND", "API key not found.");
      return { revoked: true };
    },
  },
  {
    name: "workspace.delete",
    description: "Permanently delete the authenticated workspace and all workspace-owned data.",
    access: "write",
    inputSchema: z.object({ confirmation: z.string().trim().min(1).max(160) }),
    outputSchema: anyOutput,
    handler: async (ctx, input) => {
      await requireWorkspaceOwner(ctx);
      const [workspace] = await ctx.db.select({ id: schema.workspaces.id, name: schema.workspaces.name }).from(schema.workspaces).where(eq(schema.workspaces.id, ctx.workspaceId)).limit(1);
      if (!workspace) throw new OpError("NOT_FOUND", "Workspace not found.");
      if (input.confirmation !== workspace.name) throw new OpError("BAD_INPUT", "Type the workspace name exactly to confirm deletion.");
      if (ctx.env.dodoPaymentsApiKey && ctx.billing) {
        const [subscription] = await ctx.db.select({ dodoSubscriptionId: schema.subscriptions.dodoSubscriptionId }).from(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, ctx.workspaceId)).limit(1);
        if (subscription?.dodoSubscriptionId) {
          try {
            await ctx.billing.updateSubscription(subscription.dodoSubscriptionId, { status: "cancelled", cancel_reason: "cancelled_by_customer" });
          } catch (error) {
            ctx.logger?.warn?.({ err: error, workspaceId: ctx.workspaceId, dodoSubscriptionId: subscription.dodoSubscriptionId }, "Failed to cancel Dodo subscription before workspace deletion");
            throw new OpError("UNAVAILABLE", "We could not cancel your subscription. Please try deleting the workspace again shortly.");
          }
        }
      }
      const deleted = await ctx.db.delete(schema.workspaces).where(eq(schema.workspaces.id, ctx.workspaceId)).returning({ id: schema.workspaces.id });
      if (!deleted.length) throw new OpError("NOT_FOUND", "Workspace not found.");
      return { deleted: true, workspaceId: workspace.id };
    },
  },
  {
    name: "billing.checkoutStart",
    description: "Create a Dodo Payments checkout session for the authenticated workspace.",
    access: "write",
    // The lifetime license is the only plan on sale.
    inputSchema: z.object({ productKey: z.enum(["lifetime"]), piqoVisitorId: z.string().optional() }),
    outputSchema: z.object({ checkoutUrl: z.string().url() }),
    handler: async (ctx, input) => {
      requireCloudBilling(ctx);
      await requireWorkspaceOwner(ctx);
      const client = billingClient(ctx);
      const productId = ctx.env.dodoProductLifetime;
      if (!productId || !ctx.env.webBaseUrl) throw new OpError("billing_unconfigured", "Billing is not configured.");
      const activeStatuses = new Set(["active", "trialing", "on_hold", "paused"]);
      const now = new Date();
      const reserve = async () => ctx.db.transaction(async (tx) => {
        await tx.select({ id: schema.workspaces.id }).from(schema.workspaces).where(eq(schema.workspaces.id, ctx.workspaceId)).for("update");
        const [subscription] = await tx.select({ dodoCustomerId: schema.subscriptions.dodoCustomerId, dodoSubscriptionId: schema.subscriptions.dodoSubscriptionId, status: schema.subscriptions.status }).from(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, ctx.workspaceId)).limit(1);
        if (subscription && activeStatuses.has(subscription.status)) {
          throw new OpError("CONFLICT", "This workspace already has a plan. Change it from the billing portal.");
        }
        const [intent] = await tx.select().from(schema.billingCheckoutIntents).where(eq(schema.billingCheckoutIntents.workspaceId, ctx.workspaceId)).limit(1);
        // Only an unexpired intent for the same plan is reused. A plan switch or an
        // expired intent is replaced, after provider reconciliation below.
        if (intent && intent.expiresAt > now && intent.productKey === input.productKey) return { intent, subscription, replace: false };
        if (intent) return { intent, subscription, replace: true };
        const [created] = await tx.insert(schema.billingCheckoutIntents).values({
          workspaceId: ctx.workspaceId,
          productKey: input.productKey,
          idempotencyKey: `billing-checkout:${randomUUID()}`,
          expiresAt: new Date(now.getTime() + BILLING_CHECKOUT_INTENT_TTL_MS),
        }).returning();
        return { intent: created!, subscription, replace: false };
      });

      let reservation = await reserve();
      if (reservation.replace) {
        // A checkout may have completed while its webhook was delayed or missed.
        // Reconcile provider truth before replacing its intent with another session.
        const [owner] = await ctx.db.select({ email: schema.users.email })
          .from(schema.memberships)
          .innerJoin(schema.users, eq(schema.memberships.userId, schema.users.id))
          .where(and(eq(schema.memberships.workspaceId, ctx.workspaceId), eq(schema.memberships.role, "owner"), eq(schema.memberships.status, "active")))
          .orderBy(schema.memberships.createdAt)
          .limit(1);
        if (!owner) throw new OpError("NOT_FOUND", "Workspace owner not found.");
        const customerLookup = reservation.subscription?.dodoCustomerId
          ? { customerId: reservation.subscription.dodoCustomerId }
          : { customerEmail: owner.email };
        const lifetimePayment = client.listPayments
          ? findWorkspaceLifetimePayment(await client.listPayments({ ...customerLookup, productId }), {
            workspaceId: ctx.workspaceId,
            lifetimeProductId: productId,
            dodoCustomerId: reservation.subscription?.dodoCustomerId,
          })
          : undefined;
        if (lifetimePayment) {
          await grantLifetimeLicense(ctx.db, { workspaceId: ctx.workspaceId, productId, payment: lifetimePayment });
          const [current] = await ctx.db.select({ status: schema.subscriptions.status }).from(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, ctx.workspaceId)).limit(1);
          if (current && activeStatuses.has(current.status)) {
            await ctx.db.delete(schema.billingCheckoutIntents).where(eq(schema.billingCheckoutIntents.workspaceId, ctx.workspaceId));
            throw new OpError("CONFLICT", "This workspace already has a lifetime license.");
          }
        }
        const candidates = await client.listSubscriptions(customerLookup);
        const match = candidates.map(objectValue)
          .filter((candidate) => {
            const candidateWorkspaceId = providerWorkspaceId(candidate);
            const customerId = billingString(objectValue(candidate.customer).customer_id);
            if (candidateWorkspaceId) return candidateWorkspaceId === ctx.workspaceId;
            return Boolean(reservation.subscription?.dodoCustomerId && customerId === reservation.subscription.dodoCustomerId);
          })
          .filter((candidate) => billingString(candidate.subscription_id) && providerSubscriptionTime(candidate))
          .sort((left, right) =>
            Number(providerSubscriptionIsLive(right)) - Number(providerSubscriptionIsLive(left))
            || providerSubscriptionTime(right)!.getTime() - providerSubscriptionTime(left)!.getTime())[0];
        if (match) {
          const reconciled = await ctx.db.transaction((tx) => upsertDodoSubscription(tx, ctx.workspaceId, match));
          const [current] = await ctx.db.select({ status: schema.subscriptions.status }).from(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, ctx.workspaceId)).limit(1);
          if (reconciled.persisted && current && activeStatuses.has(current.status)) {
            await ctx.db.delete(schema.billingCheckoutIntents).where(eq(schema.billingCheckoutIntents.workspaceId, ctx.workspaceId));
            throw new OpError("CONFLICT", "This workspace already has a plan. Change it from the billing portal.");
          }
        }
        reservation = await ctx.db.transaction(async (tx) => {
          await tx.select({ id: schema.workspaces.id }).from(schema.workspaces).where(eq(schema.workspaces.id, ctx.workspaceId)).for("update");
          const [subscription] = await tx.select({ dodoCustomerId: schema.subscriptions.dodoCustomerId, dodoSubscriptionId: schema.subscriptions.dodoSubscriptionId, status: schema.subscriptions.status }).from(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, ctx.workspaceId)).limit(1);
          if (subscription && activeStatuses.has(subscription.status)) throw new OpError("CONFLICT", "This workspace already has a plan. Change it from the billing portal.");
          const [currentIntent] = await tx.select().from(schema.billingCheckoutIntents).where(eq(schema.billingCheckoutIntents.workspaceId, ctx.workspaceId)).limit(1);
          const reservationTime = new Date();
          // A concurrent request may already have replaced the intent; reuse its session.
          if (currentIntent && currentIntent.expiresAt > reservationTime && currentIntent.productKey === input.productKey) {
            return { intent: currentIntent, subscription, replace: false };
          }
          await tx.delete(schema.billingCheckoutIntents).where(eq(schema.billingCheckoutIntents.workspaceId, ctx.workspaceId));
          const [created] = await tx.insert(schema.billingCheckoutIntents).values({
            workspaceId: ctx.workspaceId,
            productKey: input.productKey,
            idempotencyKey: `billing-checkout:${randomUUID()}`,
            expiresAt: new Date(reservationTime.getTime() + BILLING_CHECKOUT_INTENT_TTL_MS),
          }).returning();
          return { intent: created!, subscription, replace: false };
        });
      }
      if (reservation.intent.checkoutUrl) return { checkoutUrl: reservation.intent.checkoutUrl };
      const [user] = await ctx.db.select({ email: schema.users.email, displayName: schema.users.displayName }).from(schema.users).where(eq(schema.users.id, ctx.userId)).limit(1);
      if (!user) throw new OpError("NOT_FOUND", "User not found.");
      const checkoutInput: Parameters<BillingClient["createCheckoutSession"]>[0] = {
        product_cart: [{ product_id: productId, quantity: 1 }],
        customer: reservation.subscription?.dodoCustomerId ? { customer_id: reservation.subscription.dodoCustomerId } : { email: user.email, name: user.displayName ?? undefined },
        return_url: `${ctx.env.webBaseUrl}/app?billing=success`,
        cancel_url: `${ctx.env.webBaseUrl}/app?checkout=cancelled`,
        metadata: { workspaceId: ctx.workspaceId },
        confirm: false,
      };
      // Piqo attributes the payment to a traffic source through this metadata key.
      // Attribution is best-effort: a missing or malformed id never blocks checkout.
      const piqoVisitorId = input.piqoVisitorId && PIQO_VISITOR_ID.test(input.piqoVisitorId) ? input.piqoVisitorId : undefined;
      if (piqoVisitorId) checkoutInput.metadata.piqo_visitor_id = piqoVisitorId;
      // The visitor id is part of the request body, so it is part of the key too:
      // a retry from another browser must not reuse a key with a different body.
      const idempotencyKey = piqoVisitorId ? `${reservation.intent.idempotencyKey}:${piqoVisitorId}` : reservation.intent.idempotencyKey;
      const response = objectValue(await client.createCheckoutSession(checkoutInput, { idempotencyKey }));
      const checkoutUrl = typeof response.checkout_url === "string" ? response.checkout_url : typeof response.checkoutUrl === "string" ? response.checkoutUrl : undefined;
      if (!checkoutUrl) throw new OpError("UNAVAILABLE", "Dodo Payments did not return a checkout URL.");
      // First-writer-wins: two browsers with different piqoVisitorId values each create
      // their own Dodo session above (the idempotency key differs by design), but only one
      // checkoutUrl may be persisted for this workspace/intent, and every caller is handed
      // that same stored URL rather than the one it individually created.
      const [written] = await ctx.db.update(schema.billingCheckoutIntents)
        .set({ checkoutUrl })
        .where(and(
          eq(schema.billingCheckoutIntents.workspaceId, ctx.workspaceId),
          eq(schema.billingCheckoutIntents.idempotencyKey, reservation.intent.idempotencyKey),
          isNull(schema.billingCheckoutIntents.checkoutUrl),
        ))
        .returning({ checkoutUrl: schema.billingCheckoutIntents.checkoutUrl });
      if (written) return { checkoutUrl: written.checkoutUrl ?? checkoutUrl };
      const [stored] = await ctx.db.select({ checkoutUrl: schema.billingCheckoutIntents.checkoutUrl })
        .from(schema.billingCheckoutIntents)
        .where(and(eq(schema.billingCheckoutIntents.workspaceId, ctx.workspaceId), eq(schema.billingCheckoutIntents.idempotencyKey, reservation.intent.idempotencyKey)))
        .limit(1);
      return { checkoutUrl: stored?.checkoutUrl ?? checkoutUrl };
    },
  },
  {
    name: "billing.get",
    description: "Get the authenticated workspace's current billing tier and subscription state.",
    access: "read",
    inputSchema: z.object({}),
    outputSchema: billingStateSchema,
    handler: async (ctx) => {
      const [plan, role] = await Promise.all([getWorkspacePlan(ctx), workspaceRole(ctx)]);
      const canManage = role === "owner";
      // Self-host has no billing at all: always entitled, nothing to buy.
      if (!isCloudEdition(ctx.env.edition)) return { ...plan, configured: false, hasCustomer: false, canManage };
      const [subscription] = await ctx.db.select({ dodoCustomerId: schema.subscriptions.dodoCustomerId }).from(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, ctx.workspaceId)).limit(1);
      const hasCustomer = Boolean(subscription?.dodoCustomerId);
      // Unconfigured cloud billing (a dev box without Dodo keys) still reports
      // the real plan, so the app agrees with what the worker allows.
      return { ...plan, configured: Boolean(ctx.env.dodoPaymentsApiKey && ctx.billing), hasCustomer, canManage };
    },
  },
  {
    name: "billing.reconcile",
    description: "Refresh the authenticated workspace's subscription state from Dodo Payments.",
    access: "write",
    inputSchema: z.object({}),
    outputSchema: billingStateSchema.extend({ reconciled: z.boolean() }),
    handler: async (ctx) => {
      requireCloudBilling(ctx);
      await requireWorkspaceOwner(ctx);
      if (!ctx.env.dodoPaymentsApiKey || !ctx.billing) {
        const [subscription] = await ctx.db.select({ dodoCustomerId: schema.subscriptions.dodoCustomerId }).from(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, ctx.workspaceId)).limit(1);
        return { ...await getWorkspacePlan(ctx), configured: false, hasCustomer: Boolean(subscription?.dodoCustomerId), canManage: true, reconciled: false };
      }
      const client = billingClient(ctx);
      const [stored] = await ctx.db.select({
        dodoCustomerId: schema.subscriptions.dodoCustomerId,
        dodoSubscriptionId: schema.subscriptions.dodoSubscriptionId,
        status: schema.subscriptions.status,
        metadata: schema.subscriptions.metadata,
      }).from(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, ctx.workspaceId)).limit(1);

      // An active lifetime license has no provider subscription to refresh.
      if (stored?.status === "active" && isLifetimeSubscriptionRow(stored)) {
        return { ...await getWorkspacePlan(ctx), configured: true as const, hasCustomer: Boolean(stored.dodoCustomerId), canManage: true, reconciled: false };
      }

      const terminalStatuses = new Set(["cancelled", "expired", "failed"]);
      let providerSubscription: unknown;
      if (stored?.dodoSubscriptionId && !terminalStatuses.has(stored.status)) {
        providerSubscription = await client.retrieveSubscription(stored.dodoSubscriptionId);
      }
      if (!providerSubscription) {
        const [owner] = await ctx.db.select({ email: schema.users.email })
          .from(schema.memberships)
          .innerJoin(schema.users, eq(schema.memberships.userId, schema.users.id))
          .where(and(
            eq(schema.memberships.workspaceId, ctx.workspaceId),
            eq(schema.memberships.role, "owner"),
            eq(schema.memberships.status, "active"),
          ))
          .orderBy(schema.memberships.createdAt)
          .limit(1);
        if (!owner) throw new OpError("NOT_FOUND", "Workspace owner not found.");

        const customerLookup = stored?.dodoCustomerId ? { customerId: stored.dodoCustomerId } : { customerEmail: owner.email };
        // A lifetime purchase whose webhook is late or missing: grant it from provider truth.
        const lifetimeProductId = ctx.env.dodoProductLifetime;
        if (lifetimeProductId && client.listPayments) {
          const lifetimePayment = findWorkspaceLifetimePayment(await client.listPayments({ ...customerLookup, productId: lifetimeProductId }), {
            workspaceId: ctx.workspaceId,
            lifetimeProductId,
            dodoCustomerId: stored?.dodoCustomerId,
          });
          if (lifetimePayment) {
            const { granted } = await grantLifetimeLicense(ctx.db, { workspaceId: ctx.workspaceId, productId: lifetimeProductId, payment: lifetimePayment });
            if (granted) await ctx.db.delete(schema.billingCheckoutIntents).where(eq(schema.billingCheckoutIntents.workspaceId, ctx.workspaceId));
            const [lifetimeSubscription] = await ctx.db.select({ dodoCustomerId: schema.subscriptions.dodoCustomerId }).from(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, ctx.workspaceId)).limit(1);
            return { ...await getWorkspacePlan(ctx), configured: true as const, hasCustomer: Boolean(lifetimeSubscription?.dodoCustomerId), canManage: true, reconciled: granted };
          }
        }

        const candidates = await client.listSubscriptions(customerLookup);
        const matching = candidates
          .map(objectValue)
          .filter((candidate) => {
            const candidateWorkspaceId = providerWorkspaceId(candidate);
            const customerId = billingString(objectValue(candidate.customer).customer_id);
            if (candidateWorkspaceId) return candidateWorkspaceId === ctx.workspaceId;
            return Boolean(stored?.dodoCustomerId && customerId === stored.dodoCustomerId);
          })
          .filter((candidate) => billingString(candidate.subscription_id) && providerSubscriptionTime(candidate))
          .sort((left, right) =>
            Number(providerSubscriptionIsLive(right)) - Number(providerSubscriptionIsLive(left))
            || providerSubscriptionTime(right)!.getTime() - providerSubscriptionTime(left)!.getTime());
        providerSubscription = matching[0];
      }

      if (!providerSubscription) {
        const plan = await getWorkspacePlan(ctx);
        return { ...plan, configured: true as const, hasCustomer: Boolean(stored?.dodoCustomerId), canManage: true, reconciled: false };
      }

      const persisted = await ctx.db.transaction((tx) => upsertDodoSubscription(tx, ctx.workspaceId, providerSubscription));
      if (persisted.persisted && ["active", "trialing", "on_hold", "paused"].includes(persisted.status)) {
        await ctx.db.delete(schema.billingCheckoutIntents).where(eq(schema.billingCheckoutIntents.workspaceId, ctx.workspaceId));
      }
      const [reconciledSubscription] = await ctx.db.select({ dodoCustomerId: schema.subscriptions.dodoCustomerId }).from(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, ctx.workspaceId)).limit(1);
      return { ...await getWorkspacePlan(ctx), configured: true as const, hasCustomer: Boolean(reconciledSubscription?.dodoCustomerId), canManage: true, reconciled: persisted.persisted };
    },
  },
  {
    name: "billing.portalLink",
    description: "Create a Dodo Payments customer portal session for the authenticated workspace.",
    access: "write",
    inputSchema: z.object({}),
    outputSchema: z.object({ url: z.string().url() }),
    handler: async (ctx) => {
      requireCloudBilling(ctx);
      await requireWorkspaceOwner(ctx);
      const client = billingClient(ctx);
      const [subscription] = await ctx.db.select({ dodoCustomerId: schema.subscriptions.dodoCustomerId }).from(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, ctx.workspaceId)).limit(1);
      if (!subscription?.dodoCustomerId) throw new OpError("NOT_FOUND", "No billing customer exists for this workspace.");
      const rawResponse = await client.createCustomerPortal(subscription.dodoCustomerId);
      ctx.logger?.info({ dodoPortalResponseShape: portalResponseShape(rawResponse) }, "Dodo customer portal response shape");
      const response = objectValue(rawResponse);
      const url = typeof response.link === "string" ? response.link : typeof response.url === "string" ? response.url : undefined;
      if (!url) throw new OpError("UNAVAILABLE", "Dodo Payments did not return a customer portal URL.");
      return { url };
    },
  },
  {
    name: "billing.cancel",
    description: "Cancel the authenticated workspace's Dodo Payments subscription now or at period end.",
    access: "write",
    inputSchema: z.object({ atPeriodEnd: z.literal(true).optional() }),
    outputSchema: z.object({ cancelled: z.literal(true), atPeriodEnd: z.boolean() }),
    handler: async (ctx, input) => {
      requireCloudBilling(ctx);
      await requireWorkspaceOwner(ctx);
      const client = billingClient(ctx);
      const [subscription] = await ctx.db.select({ dodoSubscriptionId: schema.subscriptions.dodoSubscriptionId }).from(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, ctx.workspaceId)).limit(1);
      if (!subscription?.dodoSubscriptionId) throw new OpError("NOT_FOUND", "No active billing subscription exists for this workspace.");
      if (input.atPeriodEnd) {
        await client.updateSubscription(subscription.dodoSubscriptionId, { cancel_at_next_billing_date: true });
      } else {
        await client.updateSubscription(subscription.dodoSubscriptionId, { status: "cancelled", cancel_reason: "cancelled_by_customer" });
      }
      return { cancelled: true as const, atPeriodEnd: input.atPeriodEnd === true };
    },
  },
  {
    name: "affiliate.get",
    description: "Get the authenticated workspace's Refer & earn affiliate code, commission rate, and earnings summary (clicks, signups, paid customers, and pending/available/paid commission totals). Lazily creates the workspace's affiliate code on first call. This is read-only.",
    access: "read",
    inputSchema: z.object({}),
    outputSchema: z.object({
      code: z.string(),
      commissionPercent: z.number(),
      commissionMonths: z.number(),
      holdDays: z.number(),
      clicks: z.number(),
      signups: z.number(),
      paidCustomers: z.number(),
      currency: z.string(),
      earnedCents: z.number(),
      pendingCents: z.number(),
      availableCents: z.number(),
      paidCents: z.number(),
    }),
    handler: async (ctx) => {
      const affiliateCode = await ensureAffiliateCode(ctx.db, ctx.workspaceId);
      const referralRows = await ctx.db.select({ status: schema.affiliateReferrals.status }).from(schema.affiliateReferrals).where(eq(schema.affiliateReferrals.affiliateWorkspaceId, ctx.workspaceId));
      const signups = referralRows.length;
      const paidCustomers = referralRows.filter((row) => row.status === "paid").length;
      const commissionRows = await ctx.db.select({
        status: schema.affiliateCommissions.status,
        availableAt: schema.affiliateCommissions.availableAt,
        commissionCents: schema.affiliateCommissions.commissionCents,
        currency: schema.affiliateCommissions.currency,
      }).from(schema.affiliateCommissions).where(eq(schema.affiliateCommissions.affiliateWorkspaceId, ctx.workspaceId));
      const now = Date.now();
      let earnedCents = 0;
      let pendingCents = 0;
      let availableCents = 0;
      let paidCents = 0;
      const currencyCounts = new Map<string, number>();
      for (const row of commissionRows) {
        currencyCounts.set(row.currency, (currencyCounts.get(row.currency) ?? 0) + 1);
        if (row.status === "reversed") continue;
        earnedCents += row.commissionCents;
        if (row.status === "paid") {
          paidCents += row.commissionCents;
        } else if (row.status === "pending") {
          if (row.availableAt.getTime() <= now) availableCents += row.commissionCents;
          else pendingCents += row.commissionCents;
        }
      }
      let currency = "USD";
      let bestCount = 0;
      for (const [candidate, count] of currencyCounts) {
        if (count > bestCount) {
          currency = candidate;
          bestCount = count;
        }
      }
      return {
        code: affiliateCode.code,
        commissionPercent: affiliateCode.commissionPercent,
        commissionMonths: affiliateCode.commissionMonths,
        holdDays: AFFILIATE_HOLD_DAYS,
        clicks: affiliateCode.clicks,
        signups,
        paidCustomers,
        currency,
        earnedCents,
        pendingCents,
        availableCents,
        paidCents,
      };
    },
  },
  {
    name: "affiliate.listReferrals",
    description: "List the authenticated workspace's Refer & earn referrals (signups and paying customers attributed to its affiliate code), newest first, with each referral's non-reversed commission total. Never exposes the referred customer's email, name, or workspace id. This is read-only.",
    access: "read",
    inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(50) }),
    outputSchema: z.object({
      referrals: z.array(z.object({
        id: z.string(),
        createdAt: z.string(),
        status: z.enum(["signed_up", "paid"]),
        earnedCents: z.number(),
      })),
    }),
    handler: async (ctx, input) => {
      const referralRows = await ctx.db.select({
        id: schema.affiliateReferrals.id,
        createdAt: schema.affiliateReferrals.createdAt,
        status: schema.affiliateReferrals.status,
      }).from(schema.affiliateReferrals)
        .where(eq(schema.affiliateReferrals.affiliateWorkspaceId, ctx.workspaceId))
        .orderBy(desc(schema.affiliateReferrals.createdAt))
        .limit(input.limit);
      if (!referralRows.length) return { referrals: [] };
      const referralIds = referralRows.map((row) => row.id);
      const commissionRows = await ctx.db.select({
        referralId: schema.affiliateCommissions.referralId,
        status: schema.affiliateCommissions.status,
        commissionCents: schema.affiliateCommissions.commissionCents,
      }).from(schema.affiliateCommissions).where(inArray(schema.affiliateCommissions.referralId, referralIds));
      const earnedByReferral = new Map<string, number>();
      for (const row of commissionRows) {
        if (row.status === "reversed") continue;
        earnedByReferral.set(row.referralId, (earnedByReferral.get(row.referralId) ?? 0) + row.commissionCents);
      }
      return {
        referrals: referralRows.map((row) => ({
          id: row.id,
          createdAt: row.createdAt.toISOString(),
          status: row.status,
          earnedCents: earnedByReferral.get(row.id) ?? 0,
        })),
      };
    },
  },
  {
    name: "inboxes.list",
    description: "List connected inboxes and their sending settings in the authenticated workspace. This is read-only.",
    access: "read",
    inputSchema: z.object({}),
    outputSchema: anyOutput,
    handler: async (ctx) => {
      const rows = await ctx.db.select().from(schema.emailAccounts).where(and(eq(schema.emailAccounts.workspaceId, ctx.workspaceId), ne(schema.emailAccounts.status, "removed")));
      const today = new Date().toISOString().slice(0, 10);
      const usage = await ctx.db.select().from(schema.mailboxDailyUsage).where(and(eq(schema.mailboxDailyUsage.workspaceId, ctx.workspaceId), eq(schema.mailboxDailyUsage.usageDate, today)));
      const sentToday = new Map(usage.map((item) => [item.emailAccountId, item.acceptedCount]));
      const healthRows = await ctx.db.select().from(schema.mailboxHealth).where(eq(schema.mailboxHealth.workspaceId, ctx.workspaceId));
      const healthByAccount = new Map(healthRows.map((item) => [item.emailAccountId, item]));
      const nowTs = new Date();
      const todayIso = nowTs.toISOString().slice(0, 10);
      const warmupInfo = (row: { rampStartedOn: string | null; dailyLimit: number; rampPausedDays: number | null; rampPauseLastDate: string | null }) => {
        const paused = row.rampPauseLastDate === todayIso;
        const capToday = warmupDailyLimit(row.dailyLimit, row.rampStartedOn, nowTs, row.rampPausedDays ?? 0);
        const percent = row.dailyLimit > 0 ? Math.min(100, Math.round((capToday / row.dailyLimit) * 100)) : 100;
        return { percent, capToday, fullOn: percent >= 100 ? null : warmupFullOn(row.dailyLimit, row.rampStartedOn, row.rampPausedDays ?? 0), paused };
      };
      return {
        workspaceId: ctx.workspaceId,
        inboxes: rows.map((row) => ({
          id: row.id,
          provider: row.provider,
          email: row.email,
          displayName: row.displayName ?? row.email,
          alias: row.alias,
          status: row.status,
          timezone: row.timezone,
          dailyLimit: row.dailyLimit,
          hourlyLimit: row.hourlyLimit,
          sentToday: sentToday.get(row.id) ?? 0,
          rampStartedOn: row.rampStartedOn,
          warmupPercent: warmupInfo(row).percent,
          warmupCapToday: warmupInfo(row).capToday,
          warmupFullOn: warmupInfo(row).fullOn,
          warmupPaused: warmupInfo(row).paused,
          // The warm-up badge needs to know why a mailbox is not sending: a ramp at
          // 100% is not "full speed" if health is holding the mailbox back.
          healthState: healthByAccount.get(row.id)?.state ?? "healthy",
          bounceRate: Number(healthByAccount.get(row.id)?.bounceRate ?? 0),
          composioConnectedAccountId: row.composioConnectedAccountId,
          connectMode: "composio",
          lastHealthCheckAt: row.lastHealthCheckAt?.toISOString() ?? null,
        })),
      };
    },
  },
  ...createSendingAnalyticsOperations((name, ctx, input) => runOperation(operationByName.get(name)!, ctx, input), OpError, requireWorkspaceManager, requireVerifiedWorkspaceOwner),
  ...createMcpOperations((name, ctx, input) => runOperation(operationByName.get(name)!, ctx, input), OpError, requireWorkspaceManager, requireVerifiedWorkspaceOwner),
];

export const operationByName = new Map(operations.map((operation) => [operation.name, operation]));
export async function runOperation<I extends z.ZodType, O extends z.ZodType>(operation: Operation<I, O>, ctx: OperationContext, input: unknown): Promise<z.infer<O>> {
  return operation.handler(ctx, operation.inputSchema.parse(input));
}

// Workspace export/import (docs/workspace-transfer.md). Not registered operations: session-only REST.
export * from "./workspace-transfer/index.js";
