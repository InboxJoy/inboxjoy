export type MissingVariablesSummary = {
  total: number;
  variables: string[];
  byVariable: Record<string, number>;
  sampleEmails: string[];
};

export const MISSING_VARIABLES_CODE = "missing_variables";
export const MISSING_VARIABLES_NEXT_STEP =
  "Fill in the missing values, add the column to your lead import, or ask your AI assistant (MCP) to run campaigns.setLeadVariables, then launch again.";
export const MISSING_VARIABLES_JOIN_NOTE = "Leads join this campaign automatically once their lines are added.";
export const CUSTOM_VARIABLES_HINT =
  "Custom {{anyName}} variables are filled per lead from your lead import, the Variables card, or your AI assistant (MCP).";
export const MAX_SAMPLE_EMAILS = 5;
export const SAVE_AUDIENCE_HINT = "Save your audience to fill in missing values.";

// The values editor loads leads from the audience saved on the campaign (its selected lists), so it
// has nothing to show until the campaign exists. Returns the action to offer: open it, or a hint.
export function fillMissingValuesAccess(state: { sequenceId?: string; campaignId?: string }): { canFill: boolean; hint: string } {
  const canFill = Boolean(state.sequenceId && state.campaignId);
  return { canFill, hint: canFill ? "" : SAVE_AUDIENCE_HINT };
}

export function variableTag(name: string) {
  const bare = name.replace(/^\{\{\s*|\s*\}\}$/g, "").trim();
  return `{{${bare}}}`;
}

// Reads the `{ total, variables, byVariable, sampleEmails }` shape the API returns on a launch
// failure and on the audience preview. Returns null when nothing is missing or the shape is absent.
export function readMissingVariables(value: unknown): MissingVariablesSummary | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const total = typeof source.total === "number" && Number.isFinite(source.total) ? Math.max(0, Math.floor(source.total)) : 0;
  if (total <= 0) return null;
  const variables = Array.isArray(source.variables) ? source.variables.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
  const byVariable: Record<string, number> = {};
  if (source.byVariable && typeof source.byVariable === "object") {
    for (const [name, count] of Object.entries(source.byVariable as Record<string, unknown>)) {
      if (typeof count === "number" && Number.isFinite(count) && count > 0) byVariable[name] = Math.floor(count);
    }
  }
  const names = variables.length ? variables : Object.keys(byVariable);
  if (!names.length) return null;
  const sampleEmails = Array.isArray(source.sampleEmails) ? source.sampleEmails.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
  return { total, variables: names, byVariable, sampleEmails };
}

// Reads a launch/publish failure (an ApiError carrying `code` and `details`).
export function missingVariablesFromError(reason: unknown): MissingVariablesSummary | null {
  if (!reason || typeof reason !== "object") return null;
  const { code, details } = reason as { code?: unknown; details?: unknown };
  const detailCode = details && typeof details === "object" ? (details as { code?: unknown }).code : undefined;
  if (code !== MISSING_VARIABLES_CODE && detailCode !== MISSING_VARIABLES_CODE) return null;
  return readMissingVariables(details);
}

export function missingVariablesHeadline(summary: MissingVariablesSummary) {
  const leads = `${summary.total.toLocaleString()} ${summary.total === 1 ? "lead is" : "leads are"}`;
  if (summary.variables.length === 1) return `${leads} missing ${variableTag(summary.variables[0] as string)}`;
  return `${leads} missing custom variables`;
}

// One line per variable ("{{icebreaker}} · 12 leads"), only when several variables are involved.
export function missingVariablesBreakdown(summary: MissingVariablesSummary): string[] {
  if (summary.variables.length < 2) return [];
  return summary.variables.map((name) => {
    const count = summary.byVariable[name] ?? summary.total;
    return `${variableTag(name)} · ${count.toLocaleString()} ${count === 1 ? "lead" : "leads"}`;
  });
}

export function missingVariablesSamples(summary: MissingVariablesSummary, max = MAX_SAMPLE_EMAILS) {
  const emails = summary.sampleEmails.slice(0, max);
  const more = Math.max(0, summary.total - emails.length);
  return { emails, more, moreLabel: more > 0 ? `+${more.toLocaleString()} more` : "" };
}
