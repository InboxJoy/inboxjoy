import { schema, type InboxJoyDb } from "@inboxjoy/db";
import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { OpError, type OperationContext } from "../index.js";
import {
  assembleWorkspaceExport,
  parseWorkspaceTransferFile,
  prepareWorkspaceImport,
  suppressionEmailHash,
  workspaceExportFilename,
  WorkspaceTransferError,
  type WorkspaceImportPlan,
  type WorkspaceTransferFile,
} from "./format.js";

// Workspace export/import (docs/workspace-transfer.md). Owner only, and only
// for a person in a browser session: the API module refuses API keys and MCP
// never sees these functions (they are not registered operations).

type TransferContext = Pick<OperationContext, "db" | "workspaceId" | "userId">;
type Tx = Parameters<Parameters<InboxJoyDb["transaction"]>[0]>[0];

// Same cap team.invite enforces.
const OPEN_INVITATION_LIMIT = 20;
const INVITATION_TTL_MS = 7 * 86_400_000;

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

// Import also needs a verified email, the same bar as sending
// (requireVerifiedWorkspaceOwner): an unverified account must not mint
// invitation links into a workspace through a file.
async function requireOwner(db: Pick<InboxJoyDb, "select">, workspaceId: string, userId: string, options: { verifiedEmail?: boolean } = {}): Promise<void> {
  const [membership] = await db.select({ role: schema.memberships.role, emailVerified: schema.authUsers.emailVerified })
    .from(schema.memberships)
    .leftJoin(schema.authUsers, eq(schema.authUsers.id, schema.memberships.userId))
    .where(and(
      eq(schema.memberships.workspaceId, workspaceId),
      eq(schema.memberships.userId, userId),
      eq(schema.memberships.status, "active"),
    )).limit(1);
  if (!membership) throw new OpError("FORBIDDEN", "You do not have access to this workspace.");
  if (membership.role !== "owner") throw new OpError("FORBIDDEN", "Only the workspace owner can export or import the workspace.");
  if (options.verifiedEmail && membership.emailVerified !== true) {
    throw new OpError("FORBIDDEN", "Verify your email address before importing a workspace. Check your inbox for the verification link.", { code: "email_unverified" });
  }
}

export type WorkspaceExportResult = { file: WorkspaceTransferFile; filename: string };

export async function exportWorkspace(
  ctx: TransferContext,
  options: { source?: { edition?: string | null; appVersion?: string | null }; now?: Date } = {},
): Promise<WorkspaceExportResult> {
  await requireOwner(ctx.db, ctx.workspaceId, ctx.userId);
  const exportedAt = options.now ?? new Date();
  const workspaceId = ctx.workspaceId;
  // One snapshot: rows added mid-export cannot leave a list pointing at a lead
  // the file does not contain.
  const snapshot = await ctx.db.transaction(async (tx) => {
    const [workspace] = await tx.select({
      name: schema.workspaces.name,
      defaultTimezone: schema.workspaces.defaultTimezone,
      dailySendCap: schema.workspaces.dailySendCap,
      killSwitchEnabled: schema.workspaces.killSwitchEnabled,
      openTrackingEnabled: schema.workspaces.openTrackingEnabled,
      postalAddress: schema.workspaces.postalAddress,
    }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).limit(1);
    if (!workspace) throw new OpError("NOT_FOUND", "Workspace not found.");

    const contacts = await tx.select({
      id: schema.contacts.id,
      email: schema.contacts.email,
      firstName: schema.contacts.firstName,
      lastName: schema.contacts.lastName,
      company: schema.contacts.company,
      title: schema.contacts.title,
      website: schema.contacts.website,
      phone: schema.contacts.phone,
      location: schema.contacts.location,
      linkedinUrl: schema.contacts.linkedinUrl,
      source: schema.contacts.source,
      lawfulBasisNote: schema.contacts.lawfulBasisNote,
      customFields: schema.contacts.customFields,
      status: schema.contacts.status,
      repliedAt: schema.contacts.repliedAt,
      bouncedAt: schema.contacts.bouncedAt,
      unsubscribedAt: schema.contacts.unsubscribedAt,
      createdAt: schema.contacts.createdAt,
    }).from(schema.contacts).where(eq(schema.contacts.workspaceId, workspaceId)).orderBy(asc(schema.contacts.createdAt), asc(schema.contacts.id));

    const lists = await tx.select({ id: schema.contactLists.id, name: schema.contactLists.name, description: schema.contactLists.description })
      .from(schema.contactLists).where(eq(schema.contactLists.workspaceId, workspaceId)).orderBy(asc(schema.contactLists.createdAt), asc(schema.contactLists.id));
    const listMembers = await tx.select({ contactListId: schema.contactListMembers.contactListId, contactId: schema.contactListMembers.contactId })
      .from(schema.contactListMembers)
      .innerJoin(schema.contacts, and(eq(schema.contacts.id, schema.contactListMembers.contactId), eq(schema.contacts.workspaceId, workspaceId)))
      .innerJoin(schema.contactLists, and(eq(schema.contactLists.id, schema.contactListMembers.contactListId), eq(schema.contactLists.workspaceId, workspaceId)))
      .where(eq(schema.contactListMembers.workspaceId, workspaceId))
      .orderBy(asc(schema.contactListMembers.createdAt), asc(schema.contacts.createdAt), asc(schema.contacts.id));

    const suppressions = await tx.select({
      email: schema.suppressions.email,
      emailHash: schema.suppressions.emailHash,
      reason: schema.suppressions.reason,
      source: schema.suppressions.source,
      createdAt: schema.suppressions.createdAt,
    }).from(schema.suppressions).where(eq(schema.suppressions.workspaceId, workspaceId)).orderBy(asc(schema.suppressions.createdAt), asc(schema.suppressions.id));

    const sequenceRows = await tx.select({ id: schema.sequences.id, name: schema.sequences.name, status: schema.sequences.status, currentVersionId: schema.sequences.currentVersionId })
      .from(schema.sequences).where(eq(schema.sequences.workspaceId, workspaceId)).orderBy(asc(schema.sequences.createdAt), asc(schema.sequences.id));
    const versionIds = sequenceRows.flatMap((sequence) => sequence.currentVersionId ? [sequence.currentVersionId] : []);
    const versions = versionIds.length ? await tx.select({ id: schema.sequenceVersions.id, sequenceId: schema.sequenceVersions.sequenceId, snapshot: schema.sequenceVersions.snapshot, customVariablesEnforced: schema.sequenceVersions.customVariablesEnforced })
      .from(schema.sequenceVersions).where(and(eq(schema.sequenceVersions.workspaceId, workspaceId), inArray(schema.sequenceVersions.id, versionIds))) : [];
    const steps = versionIds.length ? await tx.select({
      sequenceVersionId: schema.sequenceSteps.sequenceVersionId,
      stepOrder: schema.sequenceSteps.stepOrder,
      delayDays: schema.sequenceSteps.delayDays,
      subject: schema.sequenceSteps.subject,
      bodyText: schema.sequenceSteps.bodyText,
      bodyHtml: schema.sequenceSteps.bodyHtml,
    }).from(schema.sequenceSteps).where(and(eq(schema.sequenceSteps.workspaceId, workspaceId), inArray(schema.sequenceSteps.sequenceVersionId, versionIds))).orderBy(asc(schema.sequenceSteps.stepOrder)) : [];
    const versionById = new Map(versions.map((version) => [version.id, version]));
    const stepsByVersion = new Map<string, typeof steps>();
    for (const step of steps) stepsByVersion.set(step.sequenceVersionId, [...(stepsByVersion.get(step.sequenceVersionId) ?? []), step]);

    const campaigns = await tx.select({ id: schema.campaigns.id, sequenceId: schema.campaigns.sequenceId, name: schema.campaigns.name, status: schema.campaigns.status, emailAccountId: schema.campaigns.emailAccountId, contactListId: schema.campaigns.contactListId })
      .from(schema.campaigns).where(eq(schema.campaigns.workspaceId, workspaceId)).orderBy(asc(schema.campaigns.createdAt), asc(schema.campaigns.id));
    const campaignLists = await tx.select({ campaignId: schema.campaignContactLists.campaignId, contactListId: schema.campaignContactLists.contactListId })
      .from(schema.campaignContactLists).where(eq(schema.campaignContactLists.workspaceId, workspaceId)).orderBy(asc(schema.campaignContactLists.createdAt));
    const listsByCampaign = new Map<string, string[]>();
    for (const row of campaignLists) listsByCampaign.set(row.campaignId, [...(listsByCampaign.get(row.campaignId) ?? []), row.contactListId]);

    const leadVariables = await tx.select({ sequenceId: schema.campaignLeadVariables.sequenceId, contactId: schema.campaignLeadVariables.contactId, values: schema.campaignLeadVariables.values })
      .from(schema.campaignLeadVariables).where(eq(schema.campaignLeadVariables.workspaceId, workspaceId)).orderBy(asc(schema.campaignLeadVariables.createdAt));

    // Named columns only: credentials, provider connection ids and provider
    // metadata are never read, so they cannot reach the file.
    const mailboxes = await tx.select({
      id: schema.emailAccounts.id,
      email: schema.emailAccounts.email,
      provider: schema.emailAccounts.provider,
      displayName: schema.emailAccounts.displayName,
      timezone: schema.emailAccounts.timezone,
      dailyLimit: schema.emailAccounts.dailyLimit,
      hourlyLimit: schema.emailAccounts.hourlyLimit,
      status: schema.emailAccounts.status,
    }).from(schema.emailAccounts).where(eq(schema.emailAccounts.workspaceId, workspaceId)).orderBy(asc(schema.emailAccounts.createdAt), asc(schema.emailAccounts.id));
    const windows = await tx.select({
      emailAccountId: schema.mailboxSchedules.emailAccountId,
      dayOfWeek: schema.mailboxSchedules.dayOfWeek,
      startTime: schema.mailboxSchedules.startTime,
      endTime: schema.mailboxSchedules.endTime,
      timezone: schema.mailboxSchedules.timezone,
      isActive: schema.mailboxSchedules.isActive,
    }).from(schema.mailboxSchedules).where(eq(schema.mailboxSchedules.workspaceId, workspaceId)).orderBy(asc(schema.mailboxSchedules.dayOfWeek));

    const team = await tx.select({ email: schema.users.email, role: schema.memberships.role })
      .from(schema.memberships).innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .where(and(eq(schema.memberships.workspaceId, workspaceId), eq(schema.memberships.status, "active")))
      .orderBy(asc(schema.memberships.createdAt));

    return {
      workspace,
      contacts,
      lists,
      listMembers,
      suppressions,
      sequences: sequenceRows.map((sequence) => {
        const version = sequence.currentVersionId ? versionById.get(sequence.currentVersionId) : undefined;
        const description = version?.snapshot && typeof version.snapshot.description === "string" ? version.snapshot.description : "";
        return {
          id: sequence.id,
          name: sequence.name,
          status: sequence.status,
          description,
          customVariablesEnforced: version?.customVariablesEnforced ?? true,
          steps: version ? stepsByVersion.get(version.id) ?? [] : [],
        };
      }),
      campaigns: campaigns.map((campaign) => ({
        sequenceId: campaign.sequenceId,
        name: campaign.name,
        status: campaign.status,
        emailAccountId: campaign.emailAccountId,
        listIds: listsByCampaign.get(campaign.id) ?? (campaign.contactListId ? [campaign.contactListId] : []),
      })),
      leadVariables,
      mailboxes: mailboxes.map((mailbox) => ({
        id: mailbox.id,
        email: mailbox.email,
        provider: mailbox.provider,
        displayName: mailbox.displayName,
        timezone: mailbox.timezone,
        dailyLimit: mailbox.dailyLimit,
        hourlyLimit: mailbox.hourlyLimit,
        removed: mailbox.status === "removed",
        sendingWindows: windows.filter((window) => window.emailAccountId === mailbox.id).map((window) => ({
          dayOfWeek: window.dayOfWeek,
          startTime: window.startTime,
          endTime: window.endTime,
          timezone: window.timezone,
          isActive: window.isActive,
        })),
      })),
      team,
    };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });

  const file = assembleWorkspaceExport({ exportedAt, source: options.source, ...snapshot });
  return { file, filename: workspaceExportFilename(snapshot.workspace.name, exportedAt) };
}

export type WorkspaceImportResult = {
  workspace: { name: string };
  imported: {
    leads: number;
    lists: number;
    listMemberships: number;
    suppressions: number;
    sequences: number;
    steps: number;
    leadVariables: number;
    invitations: number;
  };
  // Pending invitations created without email. The owner shares the link or
  // re-sends from Settings > Team; nothing is emailed by the import.
  invitations: Array<{ email: string; role: "admin" | "member"; token: string; expiresAt: string }>;
  notInvited: Array<{ email: string; reason: "already_member" | "already_invited" | "invitation_limit" }>;
  mailboxesToReconnect: WorkspaceImportPlan["mailboxes"];
  campaignsToRebuild: Array<{ campaign: string; name: string; sourceStatus: string | null; listNames: string[]; senderEmail: string | null }>;
  kept: { killSwitchEnabled: boolean; sequencesArchived: number };
  warnings: string[];
};

function postgresErrorCode(error: unknown): string | undefined {
  let cause: unknown = error;
  while (cause && typeof cause === "object") {
    if ("code" in cause && typeof cause.code === "string" && /^[0-9A-Z]{5}$/.test(cause.code)) return cause.code;
    cause = "cause" in cause ? cause.cause : null;
  }
  return undefined;
}

// A hand-edited file can carry values PostgreSQL refuses (a NUL byte, an
// impossible date). The transaction has rolled back; say so instead of a 500.
const UNSTORABLE_VALUE_CODES = new Set(["22001", "22007", "22008", "22021", "22P02", "22P05"]);

export function toImportOpError(error: WorkspaceTransferError): OpError {
  return new OpError("BAD_INPUT", error.message, { code: error.code, ...(error.details && typeof error.details === "object" ? error.details : {}) });
}

export async function importWorkspace(ctx: TransferContext, input: unknown, options: { now?: Date } = {}): Promise<WorkspaceImportResult> {
  await requireOwner(ctx.db, ctx.workspaceId, ctx.userId, { verifiedEmail: true });
  let plan: WorkspaceImportPlan;
  try {
    plan = prepareWorkspaceImport(parseWorkspaceTransferFile(input));
  } catch (error) {
    if (error instanceof WorkspaceTransferError) throw toImportOpError(error);
    throw error;
  }
  const now = options.now ?? new Date();
  try {
    return await ctx.db.transaction((tx) => applyImport(tx, ctx, plan, now));
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code === "23505") {
      throw new OpError("CONFLICT", "This workspace changed while the import ran. Nothing was imported. Try again.", { code: "workspace_changed_during_import" });
    }
    if (code && UNSTORABLE_VALUE_CODES.has(code)) {
      throw new OpError("BAD_INPUT", "This export has a value this install cannot store. Nothing was imported.", { code: "invalid_export", postgresCode: code });
    }
    throw error;
  }
}

async function applyImport(tx: Tx, ctx: TransferContext, plan: WorkspaceImportPlan, now: Date): Promise<WorkspaceImportResult> {
  const workspaceId = ctx.workspaceId;
  // The row lock serializes two imports into the same workspace; the second
  // one then sees leads and stops.
  const [workspace] = await tx.select({
    id: schema.workspaces.id,
    defaultTimezone: schema.workspaces.defaultTimezone,
    killSwitchEnabled: schema.workspaces.killSwitchEnabled,
    postalAddress: schema.workspaces.postalAddress,
  }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).for("update");
  if (!workspace) throw new OpError("NOT_FOUND", "Workspace not found.");
  await requireOwner(tx, workspaceId, ctx.userId, { verifiedEmail: true });

  const [lead] = await tx.select({ id: schema.contacts.id }).from(schema.contacts).where(eq(schema.contacts.workspaceId, workspaceId)).limit(1);
  const [list] = await tx.select({ id: schema.contactLists.id }).from(schema.contactLists).where(eq(schema.contactLists.workspaceId, workspaceId)).limit(1);
  const [sequence] = await tx.select({ id: schema.sequences.id }).from(schema.sequences).where(eq(schema.sequences.workspaceId, workspaceId)).limit(1);
  if (lead || list || sequence) {
    throw new OpError("CONFLICT", "This workspace already has leads, lists or campaigns. Import into a new, empty workspace.", { code: "workspace_not_empty", hasLeads: Boolean(lead), hasLists: Boolean(list), hasCampaigns: Boolean(sequence) });
  }

  // Settings. The sending pause only ever turns on here: an import must not
  // resume a workspace someone paused, and a paused source stays paused.
  const killSwitchEnabled = workspace.killSwitchEnabled || plan.workspace.killSwitchEnabled;
  await tx.update(schema.workspaces).set({
    name: plan.workspace.name,
    defaultTimezone: plan.workspace.defaultTimezone ?? workspace.defaultTimezone,
    ...(plan.workspace.dailySendCap !== null ? { dailySendCap: plan.workspace.dailySendCap } : {}),
    ...(plan.workspace.openTrackingEnabled !== null ? { openTrackingEnabled: plan.workspace.openTrackingEnabled } : {}),
    killSwitchEnabled,
    // Never clears an address the workspace already has.
    postalAddress: plan.workspace.postalAddress ?? workspace.postalAddress,
    updatedAt: now,
  }).where(eq(schema.workspaces.id, workspaceId));

  const contactIdByEmail = new Map<string, string>();
  for (const batch of chunks(plan.leads, 1_000)) {
    await tx.insert(schema.contacts).values(batch.map((row) => {
      const id = randomUUID();
      contactIdByEmail.set(row.normalizedEmail, id);
      return {
        id,
        workspaceId,
        email: row.email,
        normalizedEmail: row.normalizedEmail,
        firstName: row.firstName,
        lastName: row.lastName,
        company: row.company,
        title: row.title,
        website: row.website,
        phone: row.phone,
        location: row.location,
        linkedinUrl: row.linkedinUrl,
        source: row.source,
        lawfulBasisNote: row.lawfulBasisNote,
        customFields: row.customFields,
        status: row.status,
        repliedAt: row.repliedAt,
        bouncedAt: row.bouncedAt,
        unsubscribedAt: row.unsubscribedAt,
        createdByUserId: ctx.userId,
        createdAt: row.createdAt ?? now,
        updatedAt: now,
      };
    }));
  }

  const listIdByName = new Map<string, string>();
  let listMemberships = 0;
  // Lists and campaigns are stamped a millisecond apart so they keep the
  // file's order wherever the app sorts by creation time.
  const ordered = (index: number) => new Date(now.getTime() + index);
  let listIndex = 0;
  for (const batch of chunks(plan.lists, 1_000)) {
    await tx.insert(schema.contactLists).values(batch.map((row) => {
      const id = randomUUID();
      listIdByName.set(row.name, id);
      const createdAt = ordered(listIndex++);
      return { id, workspaceId, name: row.name, description: row.description, createdByUserId: ctx.userId, createdAt, updatedAt: createdAt };
    }));
  }
  const memberRows = plan.lists.flatMap((row) => row.memberEmails.map((memberEmail) => ({
    workspaceId,
    contactListId: listIdByName.get(row.name)!,
    contactId: contactIdByEmail.get(memberEmail)!,
    addedByUserId: ctx.userId,
    createdAt: now,
  })));
  for (const batch of chunks(memberRows, 5_000)) {
    await tx.insert(schema.contactListMembers).values(batch);
    listMemberships += batch.length;
  }

  // Suppressions merge: an address the workspace already suppresses stays as it is.
  let suppressions = 0;
  for (const batch of chunks(plan.suppressions, 2_000)) {
    const inserted = await tx.insert(schema.suppressions).values(batch.map((row) => ({
      id: randomUUID(),
      workspaceId,
      email: row.email,
      normalizedEmail: row.normalizedEmail,
      emailHash: row.emailHash,
      reason: row.reason,
      source: row.source,
      createdByUserId: ctx.userId,
      createdAt: row.createdAt ?? now,
    }))).onConflictDoNothing().returning({ id: schema.suppressions.id });
    suppressions += inserted.length;
  }
  const suppressedLeads = await suppressImportedLeads(tx, workspaceId, plan.leads, contactIdByEmail, now);

  // Campaigns arrive as drafts with no sender, no audience and no enrollment.
  // Nothing here calls enrollment or list auto-enrollment, so nothing sends.
  let steps = 0;
  let leadVariables = 0;
  let sequencesArchived = 0;
  for (const [index, row] of plan.sequences.entries()) {
    const sequenceId = randomUUID();
    const versionId = randomUUID();
    const archived = row.status === "archived";
    const createdAt = ordered(index);
    if (archived) sequencesArchived++;
    await tx.insert(schema.sequences).values({ id: sequenceId, workspaceId, name: row.name, status: row.status, createdByUserId: ctx.userId, archivedAt: archived ? now : null, createdAt, updatedAt: createdAt });
    await tx.insert(schema.sequenceVersions).values({
      id: versionId,
      workspaceId,
      sequenceId,
      version: 1,
      status: row.status,
      snapshot: { description: row.description, enrolledCount: 0 },
      createdByUserId: ctx.userId,
      customVariablesEnforced: row.customVariablesEnforced,
      createdAt: now,
      updatedAt: now,
    });
    if (row.steps.length) {
      await tx.insert(schema.sequenceSteps).values(row.steps.map((step) => ({
        id: randomUUID(),
        workspaceId,
        sequenceVersionId: versionId,
        stepOrder: step.stepOrder,
        delayDays: step.delayDays,
        subject: step.subject,
        bodyText: step.bodyText,
        bodyHtml: step.bodyHtml,
      })));
      steps += row.steps.length;
    }
    await tx.update(schema.sequences).set({ currentVersionId: versionId }).where(and(eq(schema.sequences.id, sequenceId), eq(schema.sequences.workspaceId, workspaceId)));
    for (const batch of chunks(row.leadVariables, 5_000)) {
      await tx.insert(schema.campaignLeadVariables).values(batch.map((variables) => ({
        sequenceId,
        contactId: contactIdByEmail.get(variables.normalizedEmail)!,
        workspaceId,
        values: variables.values,
        createdAt: now,
        updatedAt: now,
      })));
      leadVariables += batch.length;
    }
  }

  const invitationResult = await createImportInvitations(tx, ctx, plan.team, now);

  return {
    workspace: { name: plan.workspace.name },
    imported: {
      leads: plan.leads.length,
      lists: plan.lists.length,
      listMemberships,
      suppressions,
      sequences: plan.sequences.length,
      steps,
      leadVariables,
      invitations: invitationResult.invitations.length,
    },
    invitations: invitationResult.invitations,
    notInvited: invitationResult.notInvited,
    mailboxesToReconnect: plan.mailboxes,
    campaignsToRebuild: plan.sequences.flatMap((row) => row.campaigns.map((campaign) => ({
      campaign: row.name,
      name: campaign.name,
      sourceStatus: campaign.sourceStatus,
      listNames: campaign.listNames,
      senderEmail: campaign.senderEmail,
    }))),
    kept: { killSwitchEnabled, sequencesArchived },
    warnings: [
      ...plan.warnings,
      ...(plan.suppressions.length > suppressions ? [`${(plan.suppressions.length - suppressions).toLocaleString("en-US")} suppressions were already in this workspace and were kept as they were.`] : []),
      ...(suppressedLeads ? [`${suppressedLeads.toLocaleString("en-US")} leads match a suppression in this workspace and were imported as suppressed.`] : []),
    ],
  };
}

// These states already keep a lead out of every campaign and say why, so a
// matching suppression leaves them as they are (a bounce writes a suppression
// and marks the lead bounced; that lead stays bounced).
const STATES_KEPT_WHEN_SUPPRESSED = new Set(["suppressed", "bounced", "unsubscribed"]);

// A lead whose address the workspace suppresses arrives suppressed, the state
// cascadeSuppression gives a lead when its address is suppressed. Enrollment
// and the worker match suppressions on normalized_email only, so a hash-only
// entry (an erased address) would not stop an imported lead without this. The
// match is the CSV importer's: the address, or its SHA-256 hash. Imported
// leads have no enrollments or messages, so there is nothing else to stop.
async function suppressImportedLeads(tx: Tx, workspaceId: string, leads: WorkspaceImportPlan["leads"], contactIdByEmail: Map<string, string>, now: Date): Promise<number> {
  let suppressed = 0;
  for (const batch of chunks(leads.filter((lead) => !STATES_KEPT_WHEN_SUPPRESSED.has(lead.status)), 5_000)) {
    const emails = batch.map((lead) => lead.normalizedEmail);
    const emailByHash = new Map(emails.map((email) => [suppressionEmailHash(email), email]));
    const rows = await tx.select({ normalizedEmail: schema.suppressions.normalizedEmail, emailHash: schema.suppressions.emailHash }).from(schema.suppressions).where(and(
      eq(schema.suppressions.workspaceId, workspaceId),
      or(inArray(schema.suppressions.normalizedEmail, emails), inArray(schema.suppressions.emailHash, [...emailByHash.keys()])),
    ));
    const batchEmails = new Set(emails);
    const matched = new Set<string>();
    for (const row of rows) {
      if (row.normalizedEmail && batchEmails.has(row.normalizedEmail)) matched.add(row.normalizedEmail);
      const hashed = emailByHash.get(row.emailHash);
      if (hashed) matched.add(hashed);
    }
    const contactIds = [...matched].flatMap((email) => contactIdByEmail.get(email) ?? []);
    if (!contactIds.length) continue;
    await tx.update(schema.contacts)
      .set({ status: "suppressed", unsubscribedAt: sql`coalesce(${schema.contacts.unsubscribedAt}, ${now.toISOString()}::timestamptz)`, updatedAt: now })
      .where(and(eq(schema.contacts.workspaceId, workspaceId), inArray(schema.contacts.id, contactIds)));
    suppressed += contactIds.length;
  }
  return suppressed;
}

// Teammates become pending invitations, never members, and no email is sent:
// the owner decides who to invite from the new install and when.
async function createImportInvitations(tx: Tx, ctx: TransferContext, team: WorkspaceImportPlan["team"], now: Date) {
  const invitations: WorkspaceImportResult["invitations"] = [];
  const notInvited: WorkspaceImportResult["notInvited"] = [];
  if (!team.length) return { invitations, notInvited };
  const workspaceId = ctx.workspaceId;
  const members = await tx.select({ normalizedEmail: schema.users.normalizedEmail })
    .from(schema.memberships).innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .where(and(eq(schema.memberships.workspaceId, workspaceId), eq(schema.memberships.status, "active")));
  const memberEmails = new Set(members.map((member) => member.normalizedEmail));
  const [importer] = await tx.select({ normalizedEmail: schema.users.normalizedEmail }).from(schema.users).where(eq(schema.users.id, ctx.userId)).limit(1);
  if (importer) memberEmails.add(importer.normalizedEmail);
  const open = await tx.select({ normalizedEmail: schema.invitations.normalizedEmail }).from(schema.invitations)
    .where(and(eq(schema.invitations.workspaceId, workspaceId), isNull(schema.invitations.acceptedAt), gt(schema.invitations.expiresAt, now)));
  const invitedEmails = new Set(open.map((invitation) => invitation.normalizedEmail));
  let available = Math.max(0, OPEN_INVITATION_LIMIT - open.length);
  const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS);
  const rows: Array<typeof schema.invitations.$inferInsert> = [];
  for (const member of team) {
    if (memberEmails.has(member.normalizedEmail)) {
      // The importer is the owner already; other existing members are reported.
      if (member.normalizedEmail !== importer?.normalizedEmail) notInvited.push({ email: member.email, reason: "already_member" });
      continue;
    }
    if (invitedEmails.has(member.normalizedEmail)) { notInvited.push({ email: member.email, reason: "already_invited" }); continue; }
    if (available <= 0) { notInvited.push({ email: member.email, reason: "invitation_limit" }); continue; }
    available--;
    const token = `${workspaceId}.${randomBytes(32).toString("base64url")}`;
    rows.push({
      id: randomUUID(),
      workspaceId,
      email: member.email,
      normalizedEmail: member.normalizedEmail,
      role: member.role,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      expiresAt,
      invitedByUserId: ctx.userId,
      createdAt: now,
      updatedAt: now,
    });
    invitations.push({ email: member.email, role: member.role, token, expiresAt: expiresAt.toISOString() });
  }
  // Expired, unaccepted invitations still hold the open-invite unique index.
  if (rows.length) {
    await tx.delete(schema.invitations).where(and(
      eq(schema.invitations.workspaceId, workspaceId),
      isNull(schema.invitations.acceptedAt),
      inArray(schema.invitations.normalizedEmail, rows.map((row) => row.normalizedEmail)),
    ));
    await tx.insert(schema.invitations).values(rows);
  }
  return { invitations, notInvited };
}
