import { schema, type InboxJoyDb } from "@inboxjoy/db";
import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";

import { findLeadsMissingVariables } from "./lead-variables.js";

export type EligibleContact = {
  id: string;
  email: string;
  normalizedEmail: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  title: string | null;
};

export type EnrollmentSkipped = Record<"suppressed" | "already_enrolled" | "replied" | "bounced" | "unsubscribed" | "missing_variables", number>;
export type EnrollmentSkippedLeadIds = Record<keyof EnrollmentSkipped, string[]>;

function emptySkipped(): EnrollmentSkipped {
  return { suppressed: 0, already_enrolled: 0, replied: 0, bounced: 0, unsubscribed: 0, missing_variables: 0 };
}

export function emptySkippedLeadIds(): EnrollmentSkippedLeadIds {
  return { suppressed: [], already_enrolled: [], replied: [], bounced: [], unsubscribed: [], missing_variables: [] };
}

export async function findEligibleEnrollmentAudience(input: {
  db: Pick<InboxJoyDb, "select" | "selectDistinct">;
  workspaceId: string;
  sequenceId?: string;
  campaignId?: string;
  sequenceVersionId: string | null;
  listIds?: string[];
  leadIds?: string[];
}): Promise<{ candidates: number; eligible: EligibleContact[]; skipped: EnrollmentSkipped; skippedLeadIds: EnrollmentSkippedLeadIds }> {
  const contactRows = input.listIds?.length
    ? await input.db.selectDistinct({ id: schema.contacts.id, email: schema.contacts.email, normalizedEmail: schema.contacts.normalizedEmail, firstName: schema.contacts.firstName, lastName: schema.contacts.lastName, company: schema.contacts.company, title: schema.contacts.title, status: schema.contacts.status }).from(schema.contactListMembers).innerJoin(schema.contacts, eq(schema.contactListMembers.contactId, schema.contacts.id)).where(and(eq(schema.contactListMembers.workspaceId, input.workspaceId), inArray(schema.contactListMembers.contactListId, input.listIds), eq(schema.contacts.workspaceId, input.workspaceId)))
    : input.leadIds?.length
      ? await input.db.select({ id: schema.contacts.id, email: schema.contacts.email, normalizedEmail: schema.contacts.normalizedEmail, firstName: schema.contacts.firstName, lastName: schema.contacts.lastName, company: schema.contacts.company, title: schema.contacts.title, status: schema.contacts.status }).from(schema.contacts).where(and(eq(schema.contacts.workspaceId, input.workspaceId), inArray(schema.contacts.id, input.leadIds)))
      : [];
  if (!contactRows.length) return { candidates: 0, eligible: [], skipped: emptySkipped(), skippedLeadIds: emptySkippedLeadIds() };
  const suppressions = await input.db.select({ normalizedEmail: schema.suppressions.normalizedEmail }).from(schema.suppressions).where(and(eq(schema.suppressions.workspaceId, input.workspaceId), inArray(schema.suppressions.normalizedEmail, contactRows.map((lead) => lead.normalizedEmail))));
  const suppressed = new Set(suppressions.flatMap((item) => item.normalizedEmail ? [item.normalizedEmail] : []));
  const activeEnrollmentStatuses = inArray(schema.enrollments.status, ["scheduled", "active", "paused"]);
  const matchingVersion = input.sequenceVersionId ? eq(schema.enrollments.sequenceVersionId, input.sequenceVersionId) : undefined;
  const duplicateRules = matchingVersion ? or(activeEnrollmentStatuses, matchingVersion) : activeEnrollmentStatuses;
  const existingRows = input.sequenceId || input.campaignId ? await input.db.select({ contactId: schema.enrollments.contactId, campaignId: schema.enrollments.campaignId }).from(schema.enrollments).where(and(
    eq(schema.enrollments.workspaceId, input.workspaceId),
    inArray(schema.enrollments.contactId, contactRows.map((lead) => lead.id)),
    // An enrollment stopped because a variable value was cleared (stop_reason missing_variables)
    // is not a duplicate: the lead re-enrolls, by reviving that enrollment, once the value returns.
    or(ne(schema.enrollments.status, "cancelled"), isNull(schema.enrollments.stopReason), ne(schema.enrollments.stopReason, "missing_variables")),
    or(
      input.sequenceId ? and(eq(schema.enrollments.sequenceId, input.sequenceId), input.campaignId ? undefined : duplicateRules) : undefined,
      input.campaignId ? eq(schema.enrollments.campaignId, input.campaignId) : undefined,
    ),
  )) : [];
  const alreadyEnrolled = new Set(existingRows.map((row) => row.contactId));
  const alreadyInCampaign = new Set(existingRows.filter((row) => input.campaignId && row.campaignId === input.campaignId).map((row) => row.contactId));
  const skipped: EnrollmentSkipped = emptySkipped();
  const skippedLeadIds: EnrollmentSkippedLeadIds = emptySkippedLeadIds();
  const ready = contactRows.flatMap((lead) => {
    // contacts.status === "enrolled" no longer blocks: a lead can be active in several
    // sequences at once. Only an enrollment in THIS sequence (above) is a duplicate.
    const reason = alreadyInCampaign.has(lead.id) ? "already_enrolled" : suppressed.has(lead.normalizedEmail) || lead.status === "suppressed" ? "suppressed" : alreadyEnrolled.has(lead.id) ? "already_enrolled" : lead.status === "replied" ? "replied" : lead.status === "bounced" ? "bounced" : lead.status === "unsubscribed" ? "unsubscribed" : undefined;
    if (reason) { skipped[reason] += 1; skippedLeadIds[reason].push(lead.id); return []; }
    return [{ id: lead.id, email: lead.email, normalizedEmail: lead.normalizedEmail, firstName: lead.firstName, lastName: lead.lastName, company: lead.company, title: lead.title }];
  });
  // Leads missing a custom {{variable}} used by the sequence wait (not enrolled) until
  // their values are written. Only checked once the cheaper skip reasons are settled.
  const missing = input.sequenceId && ready.length
    ? await findLeadsMissingVariables(input.db, input.workspaceId, input.sequenceId, ready.map((lead) => lead.id), input.sequenceVersionId ?? undefined)
    : new Map<string, string[]>();
  const eligible = ready.filter((lead) => {
    if (!missing.has(lead.id)) return true;
    skipped.missing_variables += 1;
    skippedLeadIds.missing_variables.push(lead.id);
    return false;
  });
  return { candidates: contactRows.length, eligible, skipped, skippedLeadIds };
}
