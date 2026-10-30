export const BUILT_IN_VARIABLES = ["firstName", "lastName", "company", "title", "email"] as const;
export type BuiltInVariable = (typeof BUILT_IN_VARIABLES)[number];

export const VARIABLE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
export const MAX_VARIABLE_VALUE_LENGTH = 1000;

// Only exact {{name}} tokens are variables; anything else stays literal text.
const TOKEN_PATTERN = /\{\{\s*([A-Za-z][A-Za-z0-9_]{0,63})\s*\}\}/g;

export type LeadVariableSource = {
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  title?: string | null;
  email?: string | null;
  customFields?: Record<string, unknown> | null;
  campaignVariables?: Record<string, unknown> | null;
};

export function isBuiltInVariable(name: string): name is BuiltInVariable {
  return (BUILT_IN_VARIABLES as readonly string[]).includes(name);
}

// Spellings that older sequences used for the built-in fields (first_name, FirstName,
// company_name, ...). They resolve case-insensitively, ignoring underscores, and render
// like the built-in they point at, so they are never treated as custom variables.
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
  if (isBuiltInVariable(name)) return name;
  return BUILT_IN_ALIASES[name.toLowerCase().replace(/_/g, "")];
}

export function isBuiltInOrAliasVariable(name: string): boolean {
  return resolveBuiltInVariable(name) !== undefined;
}

export function extractCustomVariables(...templates: Array<string | null | undefined>): string[] {
  const names = new Set<string>();
  for (const template of templates) {
    if (!template) continue;
    for (const match of template.matchAll(TOKEN_PATTERN)) {
      const name = match[1]!;
      if (!isBuiltInOrAliasVariable(name)) names.add(name);
    }
  }
  return [...names].sort();
}

export function sanitizeVariableValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).replace(/[\r\n\0]/g, " ").trim().slice(0, MAX_VARIABLE_VALUE_LENGTH);
  return text ? text : undefined;
}

export function resolveCustomVariable(name: string, lead: LeadVariableSource): string | undefined {
  return sanitizeVariableValue(lead.campaignVariables?.[name]) ?? sanitizeVariableValue(lead.customFields?.[name]);
}

export function missingCustomVariables(templates: Array<string | null | undefined>, lead: LeadVariableSource): string[] {
  return extractCustomVariables(...templates).filter((name) => resolveCustomVariable(name, lead) === undefined);
}

export type RenderOptions = {
  // false renders like sequences published before custom variables existed: only the
  // built-ins (and their aliases) resolve and every other {{token}} stays literal text.
  // Defaults to true.
  enforceCustom?: boolean;
};

// Built-ins fall back to blank (existing behavior). Custom variables resolve
// campaign value -> lead custom field; unresolved ones render blank and are
// reported in `missing` so callers can refuse to send.
export function renderTemplate(template: string, lead: LeadVariableSource, options: RenderOptions = {}): { text: string; missing: string[] } {
  const enforceCustom = options.enforceCustom !== false;
  const missing = new Set<string>();
  const text = template.replace(TOKEN_PATTERN, (match, name: string) => {
    const builtIn = resolveBuiltInVariable(name);
    if (builtIn) return String(lead[builtIn] ?? "").replace(/[\r\n]/g, "");
    if (!enforceCustom) return match;
    const value = resolveCustomVariable(name, lead);
    if (value === undefined) {
      missing.add(name);
      return "";
    }
    return value;
  });
  return { text, missing: [...missing].sort() };
}
