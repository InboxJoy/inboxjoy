// Pure helpers for per-lead, per-campaign custom variables ({{icebreaker}} and friends).
// Mirrors the API's rules in packages/core/src/template-variables.ts: built-ins first,
// then the campaign value, then the lead's custom field.

export const BUILT_IN_VARIABLES = ["firstName", "lastName", "company", "title", "email"] as const;
export const VARIABLE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
export const MAX_VARIABLE_NAME_LENGTH = 64;
export const MAX_VARIABLE_VALUE_LENGTH = 1000;

const TOKEN_PATTERN = /\{\{\s*([A-Za-z][A-Za-z0-9_]{0,63})\s*\}\}/g;
export type BuiltInVariable = (typeof BUILT_IN_VARIABLES)[number];

// Spellings that resolve to a built-in (first_name, FirstName, company_name, {{name}}, ...). Keys are
// lowercase with underscores removed, matching packages/core/src/template-variables.ts.
const BUILT_IN_ALIASES: Record<string, BuiltInVariable> = {
  firstname: "firstName",
  name: "firstName",
  lastname: "lastName",
  company: "company",
  companyname: "company",
  jobtitle: "title",
  title: "title",
  email: "email",
};

export function resolveBuiltInVariable(name: string): BuiltInVariable | undefined {
  if ((BUILT_IN_VARIABLES as readonly string[]).includes(name)) return name as BuiltInVariable;
  return BUILT_IN_ALIASES[name.toLowerCase().replace(/_/g, "")];
}

// Names the CSV mapper must never hand out as custom variables: built-ins, their aliases, and the import's source field.
export function isReservedVariableName(name: string): boolean {
  return resolveBuiltInVariable(name) !== undefined || name.toLowerCase().replace(/_/g, "") === "source";
}

export type VariableSource = "campaign" | "lead";
export type VariableCoverage = { name: string; ready: number; missing: number };
export type LeadVariableValue = { value: string; source: VariableSource } | null;
export type LeadVariableRow = {
  contactId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  values: Record<string, LeadVariableValue>;
  missing: string[];
};
export type LeadVariablesResponse = {
  variables: VariableCoverage[];
  audienceTotal: number;
  leads: LeadVariableRow[];
  page: number;
  pageSize: number;
  total: number;
};
export type LeadVariablesFilter = "all" | "missing";

// True for built-ins and every alias of them. Aliases are never custom variables.
export function isBuiltInVariable(name: string): boolean {
  return resolveBuiltInVariable(name) !== undefined;
}

export function isValidVariableName(name: string): boolean {
  return VARIABLE_NAME_PATTERN.test(name);
}

export function variableToken(name: string): string {
  return `{{${name.replace(/^\{\{\s*|\s*\}\}$/g, "").trim()}}}`;
}

// Every {{name}} token in the given texts, in order of first appearance.
export function extractVariableNames(...texts: Array<string | null | undefined>): string[] {
  const names: string[] = [];
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(TOKEN_PATTERN)) {
      const name = match[1]!;
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

export function extractCustomVariableNames(...texts: Array<string | null | undefined>): string[] {
  return extractVariableNames(...texts).filter((name) => !isBuiltInVariable(name));
}

export function stepVariables(step: { subject?: string | null; body?: string | null }): { builtIn: string[]; custom: string[] } {
  const names = extractVariableNames(step.subject, step.body);
  return { builtIn: names.filter(isBuiltInVariable), custom: names.filter((name) => !isBuiltInVariable(name)) };
}

// Camel-cased variable name from a free-text label: "Pain Point" -> painPoint. Returns "" when nothing usable is left.
export function camelCaseVariableName(label: string): string {
  const trimmed = label.trim();
  if (VARIABLE_NAME_PATTERN.test(trimmed) && /^[a-z]/.test(trimmed)) return trimmed;
  const words = trimmed.split(/[^A-Za-z0-9]+/).filter(Boolean);
  let result = "";
  words.forEach((word, index) => {
    const lower = word === word.toUpperCase() ? word.toLowerCase() : word;
    const first = lower.charAt(0);
    result += index === 0 ? first.toLowerCase() + lower.slice(1) : first.toUpperCase() + lower.slice(1);
  });
  result = result.replace(/^[^A-Za-z]+/, "");
  return result.slice(0, MAX_VARIABLE_NAME_LENGTH);
}

// Adds a numeric suffix until the name is free: painPoint, painPoint2, painPoint3.
export function uniqueVariableName(base: string, taken: ReadonlySet<string>): string {
  const root = base || "field";
  if (!taken.has(root) && !isReservedVariableName(root)) return root;
  for (let suffix = 2; ; suffix += 1) {
    const tail = String(suffix);
    const candidate = `${root.slice(0, MAX_VARIABLE_NAME_LENGTH - tail.length)}${tail}`;
    if (!taken.has(candidate) && !isReservedVariableName(candidate)) return candidate;
  }
}

// One variable name per CSV header, de-duplicated across the whole header row. A header whose name is a
// built-in, an alias, or "source" gets "" (no variable): it maps to the standard field or is not imported.
export function variableNamesForHeaders(headers: string[]): Record<string, string> {
  const taken = new Set<string>();
  const names: Record<string, string> = {};
  for (const header of headers) {
    if (Object.hasOwn(names, header)) continue;
    const base = camelCaseVariableName(header);
    if (base && isReservedVariableName(base)) {
      names[header] = "";
      continue;
    }
    const name = uniqueVariableName(base, taken);
    taken.add(name);
    names[header] = name;
  }
  return names;
}

export type VariableNameCheck = { ok: true; name: string } | { ok: false; error: string };

// Validates a name typed into "New variable…". Accepts a bare name or a {{token}}.
export function validateNewVariableName(input: string): VariableNameCheck {
  const name = input.trim().replace(/^\{\{\s*|\s*\}\}$/g, "").trim();
  if (!name) return { ok: false, error: "Enter a variable name." };
  if (!/^[A-Za-z]/.test(name)) return { ok: false, error: "Start the name with a letter." };
  if (!/^[A-Za-z0-9_]+$/.test(name)) return { ok: false, error: "Use letters, numbers, and underscores only." };
  if (name.length > MAX_VARIABLE_NAME_LENGTH) return { ok: false, error: `Keep the name under ${MAX_VARIABLE_NAME_LENGTH + 1} characters.` };
  const builtIn = resolveBuiltInVariable(name);
  if (builtIn) return { ok: false, error: `${variableToken(name)} is a standard variable (${variableToken(builtIn)}). Pick it from the Standard list or choose a new name.` };
  return { ok: true, name };
}

export type InsertResult = { value: string; cursor: number };

// Inserts text at the caret (replacing any selection) and reports where the caret should land.
export function insertAtCursor(value: string, insertion: string, selectionStart: number | null | undefined, selectionEnd?: number | null): InsertResult {
  const start = clamp(selectionStart ?? value.length, value.length);
  const end = clamp(selectionEnd ?? start, value.length);
  const from = Math.min(start, end);
  const to = Math.max(start, end);
  return { value: `${value.slice(0, from)}${insertion}${value.slice(to)}`, cursor: from + insertion.length };
}

function clamp(position: number, max: number) {
  return Math.max(0, Math.min(position, max));
}

// Picker entries: built-ins, saved names, and names already used in this sequence, without repeats.
export function variableOptions(saved: string[], used: string[]): { builtIn: string[]; custom: string[] } {
  const custom: string[] = [];
  for (const name of [...used, ...saved]) {
    if (!isBuiltInVariable(name) && isValidVariableName(name) && !custom.includes(name)) custom.push(name);
  }
  return { builtIn: [...BUILT_IN_VARIABLES], custom: custom.sort((a, b) => a.localeCompare(b)) };
}

export function coverageLabel(ready: number, total: number): string {
  return `${ready.toLocaleString()} / ${total.toLocaleString()} ${total === 1 ? "lead" : "leads"} ready`;
}

export function coveragePercent(ready: number, total: number): number {
  if (!Number.isFinite(ready) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((ready / total) * 100)));
}

export function coverageStatus(missing: number): { label: string; tone: "good" | "warning" } {
  return missing > 0 ? { label: `${missing.toLocaleString()} missing`, tone: "warning" } : { label: "Ready", tone: "good" };
}

export function sourceLabel(source: VariableSource): string {
  return source === "campaign" ? "This campaign" : "Lead field";
}

export function truncateValue(value: string, max = 60): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…` : value;
}

export function leadDisplayName(lead: Pick<LeadVariableRow, "email" | "firstName" | "lastName">): string {
  return [lead.firstName, lead.lastName].filter(Boolean).join(" ") || lead.email;
}

export function leadVariablesQuery(options: { filter?: LeadVariablesFilter; variable?: string; page?: number; pageSize?: number; search?: string }): string {
  const params = new URLSearchParams();
  params.set("filter", options.filter ?? "all");
  if (options.variable) params.set("variable", options.variable);
  params.set("page", String(Math.max(1, options.page ?? 1)));
  params.set("pageSize", String(options.pageSize ?? 50));
  if (options.search?.trim()) params.set("search", options.search.trim());
  return params.toString();
}

// An empty edit removes the campaign value (null), as the API expects.
export function variableUpdateValue(text: string): string | null {
  const trimmed = text.trim();
  return trimmed ? trimmed.slice(0, MAX_VARIABLE_VALUE_LENGTH) : null;
}

// Local copy of a row after a cell edit, so the table can update before the API answers.
export function withEditedVariable(row: LeadVariableRow, name: string, text: string, variableNames: string[]): LeadVariableRow {
  const next = variableUpdateValue(text);
  const values: Record<string, LeadVariableValue> = { ...row.values, [name]: next === null ? null : { value: next, source: "campaign" } };
  return { ...row, values, missing: variableNames.filter((variable) => !values[variable]) };
}

// Recomputes the coverage counts after one lead's missing list changes.
export function adjustCoverage(variables: VariableCoverage[], before: LeadVariableRow, after: LeadVariableRow): VariableCoverage[] {
  return variables.map((entry) => {
    const wasMissing = before.missing.includes(entry.name);
    const isMissing = after.missing.includes(entry.name);
    if (wasMissing === isMissing) return entry;
    return isMissing ? { ...entry, ready: Math.max(0, entry.ready - 1), missing: entry.missing + 1 } : { ...entry, ready: entry.ready + 1, missing: Math.max(0, entry.missing - 1) };
  });
}

// Undoes an optimistic edit after a failed save: the counts move from `edited` back to `original`.
export function rollbackCoverage(variables: VariableCoverage[], original: LeadVariableRow, edited: LeadVariableRow): VariableCoverage[] {
  return adjustCoverage(variables, edited, original);
}

export type TextSegment = { text: string; missing: boolean };

// Splits rendered preview text so the API's `[name]` placeholders for missing values can be highlighted.
export function splitMissingPlaceholders(text: string, names: string[]): TextSegment[] {
  if (!names.length || !text) return [{ text, missing: false }];
  const pattern = new RegExp(`\\[(${names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\]`, "g");
  const segments: TextSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) segments.push({ text: text.slice(last, index), missing: false });
    segments.push({ text: match[0], missing: true });
    last = index + match[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last), missing: false });
  return segments.length ? segments : [{ text, missing: false }];
}

const SAMPLE_VALUES: Record<BuiltInVariable, string> = {
  firstName: "Ada",
  lastName: "Lovelace",
  company: "Example Co",
  title: "Founder",
  email: "ada@example.com",
};

// Fills built-ins and their aliases ({{first_name}}, {{name}}, ...) with sample data for the wizard preview.
export function fillSampleVariables(text: string): string {
  return text.replace(TOKEN_PATTERN, (match, name: string) => {
    const builtIn = resolveBuiltInVariable(name);
    return builtIn ? SAMPLE_VALUES[builtIn] : match;
  });
}

// Sample previews have no lead, so every custom {{name}} reads as [name], matching what the API renders for a missing value.
export function markCustomPlaceholders(text: string): string {
  return text.replace(TOKEN_PATTERN, (match, name: string) => (isBuiltInVariable(name) ? match : `[${name}]`));
}
