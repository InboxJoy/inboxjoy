import { isReservedVariableName, variableNamesForHeaders } from "@/lib/lead-variables";

export const IMPORT_FIELDS = ["email", "firstName", "lastName", "company", "title", "source"] as const;

export type ImportField = (typeof IMPORT_FIELDS)[number];
export const CUSTOM_TARGET_PREFIX = "custom:";
export type CustomTarget = `custom:${string}`;
export type MappingTarget = ImportField | CustomTarget;
export type FieldMapping = Record<string, MappingTarget>;

export function customTarget(name: string): CustomTarget {
  return `${CUSTOM_TARGET_PREFIX}${name}`;
}

export function isCustomTarget(value: string | undefined): value is CustomTarget {
  return typeof value === "string" && value.startsWith(CUSTOM_TARGET_PREFIX) && value.length > CUSTOM_TARGET_PREFIX.length;
}

export function customTargetName(target: CustomTarget): string {
  return target.slice(CUSTOM_TARGET_PREFIX.length);
}

// Header keys (lowercase letters and digits only) that map to a standard field. Covers every built-in
// alias the server resolves: first_name, name, company_name, job_title, and so on.
const FIELD_ALIASES: Record<ImportField, string[]> = {
  email: ["email", "emailaddress", "workemail"],
  firstName: ["firstname", "first", "givenname", "name"],
  lastName: ["lastname", "last", "surname", "familyname"],
  company: ["company", "companyname", "account", "organization", "organisation"],
  title: ["title", "jobtitle", "role"],
  source: ["source", "leadsource"],
};

// A full name does not fit first or last name on its own, so it is left out unless the user picks a target.
const DO_NOT_IMPORT_KEYS = ["fullname"];

function headerKey(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function parseCsvSample(csv: string, maxRows = 5): string[][] {
  csv = csv.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index]!;
    if (quoted) {
      if (character === '"' && csv[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
      continue;
    }

    if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && csv[index + 1] === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      if (rows.length >= maxRows) return rows;
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }

  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }

  if (rows[0]?.[0]) rows[0][0] = rows[0][0]!.replace(/^\uFEFF/, "");
  return rows;
}

export function csvHeaders(csv: string) {
  return parseCsvSample(csv, 1)[0]?.map((header) => header.trim()).filter(Boolean) ?? [];
}

export function detectFieldMapping(headers: string[]): FieldMapping {
  const mapping: FieldMapping = {};
  const usedFields = new Set<ImportField>();

  for (const header of headers) {
    const normalized = headerKey(header);
    const field = IMPORT_FIELDS.find((candidate) => FIELD_ALIASES[candidate].includes(normalized));
    if (field && !usedFields.has(field)) {
      mapping[header] = field;
      usedFields.add(field);
    }
  }

  return mapping;
}

// Standard columns are detected from common header names; every other column becomes a custom
// variable ("Pain Point" -> {{painPoint}}) so no data is dropped by default. A column whose name
// is a standard variable (or an alias of one) that is already taken stays unmapped, because the
// API rejects those names as custom variables.
export function defaultFieldMapping(headers: string[]): FieldMapping {
  const mapping = detectFieldMapping(headers);
  const names = variableNamesForHeaders(headers);
  for (const header of headers) {
    if (Object.hasOwn(mapping, header) || DO_NOT_IMPORT_KEYS.includes(headerKey(header))) continue;
    const name = names[header];
    if (name) mapping[header] = customTarget(name);
  }
  return mapping;
}

// The variable name suggested for each header (shown as the "Custom: {{name}}" option).
export function suggestedVariableNames(headers: string[]): Record<string, string> {
  return variableNamesForHeaders(headers);
}

// The mapping a displaced column falls back to: its own custom variable when it has a valid one, else none.
export function fallbackTarget(variableName: string | undefined): MappingTarget | undefined {
  return variableName && !isReservedVariableName(variableName) ? customTarget(variableName) : undefined;
}

type PreviewRowLike = { action: string; error: string | null; changedFields?: Record<string, unknown> };

// An existing lead that only receives new custom values: an update with no standard-field changes.
export function isLinesOnlyUpdate(row: PreviewRowLike): boolean {
  return row.action === "update" && !row.error && !(row.changedFields && Object.keys(row.changedFields).length);
}

// Preview note for one CSV row. Says what a lines-only update does instead of showing a bare "Ready";
// any message from the API is shown as written.
export function previewRowNote(row: PreviewRowLike): string {
  if (row.error) return row.error;
  if (row.action === "unchanged") return "No mapped changes";
  if (isLinesOnlyUpdate(row)) return "New lines added to this lead";
  return "Ready";
}

export function customVariablesInMapping(mapping: FieldMapping): string[] {
  const names: string[] = [];
  for (const target of Object.values(mapping)) {
    if (isCustomTarget(target)) {
      const name = customTargetName(target);
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

function safeSpreadsheetCell(value: unknown) {
  const text = value == null ? "" : String(value);
  return /^[\t\r\n]|^\s*[=+\-@]/.test(text) ? `'${text}` : text;
}

function escapeCsvCell(value: unknown) {
  const safe = safeSpreadsheetCell(value);
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function buildErrorCsv(rows: Array<Record<string, unknown>>) {
  const headers = ["rowNumber", "email", "status", "action", "error", "changedFields"];
  const lines = rows.map((row) => headers.map((header) => escapeCsvCell(row[header])).join(","));
  return [headers.join(","), ...lines].join("\r\n");
}

export function csvByteLength(csv: string) {
  return new TextEncoder().encode(csv).byteLength;
}
