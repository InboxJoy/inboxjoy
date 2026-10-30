import { schema, type InboxJoyDb } from "@inboxjoy/db";
import { and, eq, inArray } from "drizzle-orm";

import { findEligibleEnrollmentAudience } from "./enrollment-eligibility.js";
import { findLeadsMissingVariables } from "./lead-variables.js";
import { renderTemplate, type LeadVariableSource, type RenderOptions } from "./template-variables.js";

type GateDb = Parameters<typeof findLeadsMissingVariables>[0] & Pick<InboxJoyDb, "select" | "selectDistinct">;
type GateErrorConstructor = new (code: "CONFLICT", message: string, details?: unknown) => Error;

const SAMPLE_EMAIL_LIMIT = 20;
const CONTACT_CHUNK_SIZE = 5000;

export type MissingVariablesSummary = {
  total: number;
  variables: string[];
  byVariable: Record<string, number>;
  sampleEmails: string[];
};

export const EMPTY_MISSING_VARIABLES: MissingVariablesSummary = { total: 0, variables: [], byVariable: {}, sampleEmails: [] };

function chunked<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

// Leads whose campaign-scoped or custom-field values do not cover every custom
// variable the sequence uses, summarized for launch blockers and audience previews.
export async function summarizeMissingVariables(db: GateDb, workspaceId: string, sequenceId: string, contactIds: string[], sequenceVersionId?: string | null): Promise<MissingVariablesSummary> {
  const uniqueIds = [...new Set(contactIds)];
  if (!uniqueIds.length) return EMPTY_MISSING_VARIABLES;
  const missing = await findLeadsMissingVariables(db, workspaceId, sequenceId, uniqueIds, sequenceVersionId ?? undefined);
  if (!missing.size) return EMPTY_MISSING_VARIABLES;
  const byVariable: Record<string, number> = {};
  for (const names of missing.values()) for (const name of names) byVariable[name] = (byVariable[name] ?? 0) + 1;
  const sampleIds = [...missing.keys()].slice(0, SAMPLE_EMAIL_LIMIT);
  const rows = await db.select({ email: schema.contacts.email }).from(schema.contacts).where(and(eq(schema.contacts.workspaceId, workspaceId), inArray(schema.contacts.id, sampleIds)));
  return { total: missing.size, variables: Object.keys(byVariable).sort(), byVariable, sampleEmails: rows.map((row) => row.email).sort() };
}

export function missingVariablesMessage(summary: MissingVariablesSummary): string {
  const names = summary.variables.map((name) => `{{${name}}}`).join(", ");
  return `${summary.total} ${summary.total === 1 ? "lead is" : "leads are"} missing ${names}. Add their lines with campaigns.setLeadVariables, then launch again.`;
}

// Every eligible audience member, including leads the eligibility step parks
// because their variables are incomplete, so the gate sees the full audience.
export async function launchAudienceContactIds(db: GateDb, input: { workspaceId: string; sequenceId: string; sequenceVersionId?: string | null; campaignId?: string; listIds?: string[]; leadIds?: string[] }): Promise<string[]> {
  if (!input.listIds?.length && !input.leadIds?.length) return [];
  const audience = await findEligibleEnrollmentAudience({ db, workspaceId: input.workspaceId, sequenceId: input.sequenceId, campaignId: input.campaignId, sequenceVersionId: input.sequenceVersionId ?? null, listIds: input.listIds?.length ? input.listIds : undefined, leadIds: input.listIds?.length ? undefined : input.leadIds });
  const parked = (audience.skippedLeadIds as unknown as Partial<Record<string, string[]>>).missing_variables ?? [];
  return [...new Set([...audience.eligible.map((lead) => lead.id), ...parked])];
}

// Blocks a first launch when any audience lead lacks a custom variable the
// sequence's steps use. Nothing is enrolled or sent when this throws.
export async function assertAudienceHasVariables(db: GateDb, OpError: GateErrorConstructor, input: { workspaceId: string; sequenceId: string; sequenceVersionId?: string | null; contactIds: string[] }): Promise<void> {
  const summary = await summarizeMissingVariables(db, input.workspaceId, input.sequenceId, input.contactIds, input.sequenceVersionId);
  if (summary.total) throw new OpError("CONFLICT", missingVariablesMessage(summary), { code: "missing_variables", ...summary });
}

// One call for launch paths: resolves the audience for the selected lists (or explicit
// leads) and blocks when any of them lacks a variable the sequence's steps use.
export async function assertLaunchAudienceComplete(db: GateDb, OpError: GateErrorConstructor, input: { workspaceId: string; sequenceId: string; campaignId?: string; listIds?: string[]; leadIds?: string[] }): Promise<void> {
  const [sequence] = await db.select({ currentVersionId: schema.sequences.currentVersionId }).from(schema.sequences).where(and(eq(schema.sequences.id, input.sequenceId), eq(schema.sequences.workspaceId, input.workspaceId)));
  const contactIds = await launchAudienceContactIds(db, { ...input, sequenceVersionId: sequence?.currentVersionId ?? null });
  await assertAudienceHasVariables(db, OpError, { workspaceId: input.workspaceId, sequenceId: input.sequenceId, sequenceVersionId: sequence?.currentVersionId ?? null, contactIds });
}

export async function loadContactCustomFields(db: GateDb, workspaceId: string, contactIds: string[]): Promise<Map<string, Record<string, unknown>>> {
  const result = new Map<string, Record<string, unknown>>();
  for (const batch of chunked([...new Set(contactIds)], CONTACT_CHUNK_SIZE)) {
    const rows = await db.select({ id: schema.contacts.id, customFields: schema.contacts.customFields }).from(schema.contacts).where(and(eq(schema.contacts.workspaceId, workspaceId), inArray(schema.contacts.id, batch)));
    for (const row of rows) result.set(row.id, row.customFields && typeof row.customFields === "object" && !Array.isArray(row.customFields) ? row.customFields as Record<string, unknown> : {});
  }
  return result;
}

// Preview rendering: unresolved custom variables show as [name] so the gap is visible
// and `missing` still lists them. Never use this text for a real send.
export function renderTemplateWithPlaceholders(template: string, lead: LeadVariableSource, options: RenderOptions = {}): { text: string; missing: string[] } {
  const rendered = renderTemplate(template, lead, options);
  if (!rendered.missing.length) return rendered;
  const placeholders = Object.fromEntries(rendered.missing.map((name) => [name, `[${name}]`]));
  return { text: renderTemplate(template, { ...lead, campaignVariables: { ...(lead.campaignVariables ?? {}), ...placeholders } }, options).text, missing: rendered.missing };
}
