import { schema, type InboxJoyDb } from "@inboxjoy/db";
import { and, asc, eq, ilike, inArray, isNotNull, ne, notInArray, or, sql, type SQL } from "drizzle-orm";

import { resolveVariableSequence, sequenceRequiredVariables } from "./lead-variables.js";
import { isBuiltInOrAliasVariable, sanitizeVariableValue, VARIABLE_NAME_PATTERN } from "./template-variables.js";

type ViewDb = Pick<InboxJoyDb, "select" | "execute">;

export type LeadVariableValue = { value: string; source: "campaign" | "lead" };

export type LeadVariablesView = {
  variables: Array<{ name: string; ready: number; missing: number }>;
  audienceTotal: number;
  leads: Array<{
    contactId: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    values: Record<string, LeadVariableValue | null>;
    missing: string[];
  }>;
  page: number;
  pageSize: number;
  total: number;
};

export type LeadVariablesViewInput = {
  campaignId?: string;
  sequenceId?: string;
  filter?: "all" | "missing";
  variable?: string;
  page?: number;
  pageSize?: number;
  search?: string;
};

// Keys that live in contacts.custom_fields for internal bookkeeping, never a user variable.
const INTERNAL_CUSTOM_FIELD_KEYS = new Set(["replyBackfillCheckedAt"]);
const NAME_LIMIT = 200;
// Contacts in these states can never be sent to, so they do not need values.
const UNSENDABLE_STATUSES = ["suppressed", "unsubscribed", "bounced"];

// Audience of a sequence for the variables grid: the union of
//  - contacts with a live (scheduled/active/paused) or completed enrollment in the sequence,
//  - contacts queued in staged_enrollments for it (draft or waiting on values), and
//  - members of the lists selected on any non-archived campaign of the sequence
//    (campaigns.contact_list_id plus campaign_contact_lists),
// restricted to the workspace and to contacts that are not suppressed, unsubscribed or bounced.
function audienceCondition(db: ViewDb, workspaceId: string, sequenceId: string): SQL {
  const enrolled = db.select({ id: schema.enrollments.contactId }).from(schema.enrollments).where(and(
    eq(schema.enrollments.workspaceId, workspaceId),
    eq(schema.enrollments.sequenceId, sequenceId),
    inArray(schema.enrollments.status, ["scheduled", "active", "paused", "completed"]),
  ));
  const staged = db.select({ id: schema.stagedEnrollments.leadId }).from(schema.stagedEnrollments).where(and(
    eq(schema.stagedEnrollments.workspaceId, workspaceId),
    eq(schema.stagedEnrollments.sequenceId, sequenceId),
  ));
  const campaignIds = db.select({ id: schema.campaigns.id }).from(schema.campaigns).where(and(
    eq(schema.campaigns.workspaceId, workspaceId),
    eq(schema.campaigns.sequenceId, sequenceId),
    ne(schema.campaigns.status, "archived"),
  ));
  const linkedLists = db.select({ id: schema.campaignContactLists.contactListId }).from(schema.campaignContactLists).where(and(
    eq(schema.campaignContactLists.workspaceId, workspaceId),
    inArray(schema.campaignContactLists.campaignId, campaignIds),
  ));
  const primaryLists = db.select({ id: schema.campaigns.contactListId }).from(schema.campaigns).where(and(
    eq(schema.campaigns.workspaceId, workspaceId),
    eq(schema.campaigns.sequenceId, sequenceId),
    ne(schema.campaigns.status, "archived"),
    isNotNull(schema.campaigns.contactListId),
  ));
  const members = db.select({ id: schema.contactListMembers.contactId }).from(schema.contactListMembers).where(and(
    eq(schema.contactListMembers.workspaceId, workspaceId),
    or(inArray(schema.contactListMembers.contactListId, linkedLists), inArray(schema.contactListMembers.contactListId, primaryLists)),
  ));
  return and(
    eq(schema.contacts.workspaceId, workspaceId),
    notInArray(schema.contacts.status, UNSENDABLE_STATUSES),
    or(inArray(schema.contacts.id, enrolled), inArray(schema.contacts.id, staged), inArray(schema.contacts.id, members)),
  )!;
}

// Same resolution as rendering: campaign value first, then the lead's own custom field.
function readyCondition(name: string): SQL {
  const trimmed = (column: SQL) => sql`nullif(btrim(${column} ->> ${name}::text, E' \t\r\n'), '')`;
  return sql`coalesce(${trimmed(sql`${schema.campaignLeadVariables.values}`)}, ${trimmed(sql`${schema.contacts.customFields}`)}) is not null`;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

// Read side of campaigns.setLeadVariables: which custom variables a campaign's steps use,
// how many audience leads are ready for each, and a filtered, paged list of leads with
// where each value comes from. Writes nothing.
export async function readLeadVariables(db: ViewDb, workspaceId: string, input: LeadVariablesViewInput): Promise<LeadVariablesView> {
  const sequenceId = await resolveVariableSequence(db, workspaceId, input);
  const names = await sequenceRequiredVariables(db, workspaceId, sequenceId);
  const page = Math.max(1, Math.floor(input.page ?? 1));
  const pageSize = Math.min(200, Math.max(1, Math.floor(input.pageSize ?? 50)));
  const audience = audienceCondition(db, workspaceId, sequenceId);
  const join = and(
    eq(schema.campaignLeadVariables.contactId, schema.contacts.id),
    eq(schema.campaignLeadVariables.sequenceId, sequenceId),
    eq(schema.campaignLeadVariables.workspaceId, workspaceId),
  );

  const countSelect: Record<string, SQL<number>> = { total: sql<number>`count(*)`.mapWith(Number) };
  names.forEach((name, index) => { countSelect[`ready${index}`] = sql<number>`count(*) filter (where ${readyCondition(name)})`.mapWith(Number); });
  const [counts] = await db.select(countSelect).from(schema.contacts).leftJoin(schema.campaignLeadVariables, join).where(audience);
  const audienceTotal = Number(counts?.total ?? 0);
  const variables = names.map((name, index) => {
    const ready = Number(counts?.[`ready${index}`] ?? 0);
    return { name, ready, missing: audienceTotal - ready };
  });

  const search = input.search?.trim();
  const searchCondition = search
    ? or(
      ilike(schema.contacts.email, `%${escapeLike(search)}%`),
      ilike(schema.contacts.firstName, `%${escapeLike(search)}%`),
      ilike(schema.contacts.lastName, `%${escapeLike(search)}%`),
      ilike(sql`concat_ws(' ', ${schema.contacts.firstName}, ${schema.contacts.lastName})`, `%${escapeLike(search)}%`),
    )
    : undefined;
  // `variable` narrows the missing filter to one variable; it has no effect on filter=all.
  let missingCondition: SQL | undefined;
  if (input.filter === "missing") {
    const targets = input.variable ? names.filter((name) => name === input.variable) : names;
    missingCondition = targets.length ? or(...targets.map((name) => sql`not (${readyCondition(name)})`)) : sql`false`;
  }
  const filtered = and(audience, searchCondition, missingCondition);

  const [totalRow] = await db.select({ total: sql<number>`count(*)`.mapWith(Number) }).from(schema.contacts).leftJoin(schema.campaignLeadVariables, join).where(filtered);
  const rows = await db.select({
    id: schema.contacts.id,
    email: schema.contacts.email,
    firstName: schema.contacts.firstName,
    lastName: schema.contacts.lastName,
    customFields: schema.contacts.customFields,
    campaignValues: schema.campaignLeadVariables.values,
  }).from(schema.contacts).leftJoin(schema.campaignLeadVariables, join).where(filtered)
    .orderBy(asc(schema.contacts.email), asc(schema.contacts.id))
    .limit(pageSize).offset((page - 1) * pageSize);

  const leads = rows.map((row) => {
    const values: Record<string, LeadVariableValue | null> = {};
    const missing: string[] = [];
    const lead = row.customFields && typeof row.customFields === "object" && !Array.isArray(row.customFields) ? row.customFields as Record<string, unknown> : {};
    for (const name of names) {
      const campaign = sanitizeVariableValue(row.campaignValues?.[name]);
      const own = campaign === undefined ? sanitizeVariableValue(lead[name]) : undefined;
      values[name] = campaign !== undefined ? { value: campaign, source: "campaign" } : own !== undefined ? { value: own, source: "lead" } : null;
      if (values[name] === null) missing.push(name);
    }
    return { contactId: row.id, email: row.email, firstName: row.firstName || null, lastName: row.lastName || null, values, missing };
  });
  return { variables, audienceTotal, leads, page, pageSize, total: Number(totalRow?.total ?? 0) };
}

// Contacts and campaign-value rows sampled (most recently updated first) when collecting
// variable names, so the scan stays bounded for workspaces with 50k+ leads.
const NAME_SCAN_ROWS = 5_000;

// Distinct custom variable names in use in a workspace: keys of lead custom fields (minus
// internal bookkeeping keys, built-ins and their aliases) plus keys of campaign values.
// Only the most recently updated NAME_SCAN_ROWS contacts and campaign-value rows are scanned.
export async function listLeadVariableNames(db: ViewDb, workspaceId: string, scanRows = NAME_SCAN_ROWS): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT name FROM (
      SELECT DISTINCT jsonb_object_keys(recent.custom_fields) AS name FROM (
        SELECT custom_fields FROM contacts WHERE workspace_id = ${workspaceId}
        ORDER BY updated_at DESC LIMIT ${scanRows}
      ) recent WHERE jsonb_typeof(recent.custom_fields) = 'object'
      UNION
      SELECT DISTINCT jsonb_object_keys(recent."values") AS name FROM (
        SELECT "values" FROM campaign_lead_variables WHERE workspace_id = ${workspaceId}
        ORDER BY updated_at DESC LIMIT ${scanRows}
      ) recent
    ) keys
    WHERE name ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'
    ORDER BY name
    LIMIT 2000
  `);
  const rows = (result as unknown as { rows: Array<{ name: string }> }).rows;
  return rows.map((row) => row.name)
    .filter((name) => VARIABLE_NAME_PATTERN.test(name) && !INTERNAL_CUSTOM_FIELD_KEYS.has(name) && !isBuiltInOrAliasVariable(name))
    .slice(0, NAME_LIMIT);
}

