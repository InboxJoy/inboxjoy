"use client";

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Button, labelStatus, StatusBadge } from "@inboxjoy/ui";
import { ApiError, apiErrorMessage, apiFetch } from "@/lib/api";
import { track } from "@/lib/analytics";
import { variableToken } from "@/lib/lead-variables";
import { campaignLeadFeedback, type CampaignUpdate } from "./campaign-feedback";
import {
  IMPORT_FIELDS,
  buildErrorCsv,
  csvByteLength,
  csvHeaders,
  customTarget,
  customTargetName,
  customVariablesInMapping,
  fallbackTarget,
  isLinesOnlyUpdate,
  previewRowNote,
  defaultFieldMapping,
  isCustomTarget,
  parseCsvSample,
  suggestedVariableNames,
  type FieldMapping,
  type ImportField,
  type MappingTarget,
} from "./csv-import";

type ContactListOption = { id: string; name: string };
type Lead = { id: string; email: string; firstName: string; lastName: string; company: string; title: string };
type ImportMode = "add_only" | "update_only" | "add_and_update";
type ImportStats = {
  totalRows: number;
  readyRows: number;
  createRows: number;
  updateRows: number;
  unchangedRows: number;
  duplicateRows: number;
  suppressedRows: number;
  rejectedRows: number;
  skippedRows: number;
  createdRows?: number;
  updatedRows?: number;
};
type ChangedField = { before: unknown; after: unknown };
type ImportRow = {
  rowNumber: number;
  email: string;
  status: string;
  error: string | null;
  action: string;
  changedFields?: Record<string, ChangedField>;
};
type ImportRecord = { id: string; stats: ImportStats; rows: ImportRow[]; customFields?: string[] };
type CampaignOption = { id: string; name: string };

const MAX_CSV_BYTES = 5_000_000;
const NEW_LIST_VALUE = "__new__";
const FIELD_LABELS: Record<ImportField, string> = {
  email: "Email",
  firstName: "First name",
  lastName: "Last name",
  company: "Company",
  title: "Title",
  source: "Source",
};

function downloadText(fileName: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function previewTone(row: ImportRow): "neutral" | "good" | "danger" | "info" {
  if (row.action === "create") return "good";
  if (row.action === "update") return "info";
  if (row.action === "unchanged" || row.action === "duplicate") return "neutral";
  return "danger";
}

function rowLabel(row: ImportRow) {
  if (isLinesOnlyUpdate(row)) return "Lines added";
  return row.action ? labelStatus(row.action) : labelStatus(row.status);
}

export function AddLeadsModal({
  lists,
  defaultListId,
  onClose,
  onChanged,
}: {
  lists: ContactListOption[];
  defaultListId: string;
  onClose: () => void;
  onChanged: (message: string) => Promise<void>;
}) {
  const [tab, setTab] = useState<"individual" | "csv">("individual");
  const [individual, setIndividual] = useState({ email: "", firstName: "", lastName: "", company: "", title: "" });
  const [individualListId, setIndividualListId] = useState(defaultListId);
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("leads.csv");
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<FieldMapping>({});
  const [variablesSequenceId, setVariablesSequenceId] = useState("");
  const [campaignOptions, setCampaignOptions] = useState<CampaignOption[]>([]);
  const campaignsRequested = useRef(false);
  const [mode, setMode] = useState<ImportMode>("add_only");
  const [listSelection, setListSelection] = useState(defaultListId);
  const [listName, setListName] = useState("");
  const [csvStep, setCsvStep] = useState<"source" | "map" | "preview" | "result">("source");
  const [preview, setPreview] = useState<ImportRecord | null>(null);
  const [result, setResult] = useState<ImportRecord | null>(null);
  const [individualSuccess, setIndividualSuccess] = useState("");
  const [importSuccess, setImportSuccess] = useState("");
  const [busy, setBusy] = useState<"individual" | "preview" | "commit" | null>(null);
  const [readingFile, setReadingFile] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLElement | null>(null);
  const firstTabRef = useRef<HTMLButtonElement | null>(null);
  const csvTabRef = useRef<HTMLButtonElement | null>(null);
  const emailRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const previewGeneration = useRef(0);
  const acceptedPreviewGeneration = useRef<number | null>(null);
  const workingRef = useRef(false);
  const onCloseRef = useRef(onClose);

  const isWorking = busy !== null || readingFile;

  useEffect(() => {
    workingRef.current = isWorking;
    onCloseRef.current = onClose;
  }, [isWorking, onClose]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    firstTabRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !workingRef.current) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')];
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);

  const chooseTab = (nextTab: "individual" | "csv") => {
    if (workingRef.current) return;
    setTab(nextTab);
    setError("");
  };

  const handleTabKey = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (workingRef.current) return;
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextTab = event.key === "ArrowRight" || event.key === "End" ? "csv" : "individual";
    chooseTab(nextTab);
    (nextTab === "csv" ? csvTabRef : firstTabRef).current?.focus();
  };

  const invalidatePreview = (nextStep: "source" | "map" = "map") => {
    previewGeneration.current += 1;
    acceptedPreviewGeneration.current = null;
    setPreview(null);
    setResult(null);
    setCsvStep(nextStep);
  };

  const updateSource = (value: string, nextFileName = fileName) => {
    setCsv(value);
    setFileName(nextFileName);
    setHeaders([]);
    setMapping({});
    setError("");
    invalidatePreview("source");
  };

  const selectFile = async (event: ChangeEvent<HTMLInputElement>) => {
    if (workingRef.current) return;
    const file = event.target.files?.[0];
    if (!file) return;
    setError("");
    if (file.size > MAX_CSV_BYTES) {
      updateSource("", "leads.csv");
      event.target.value = "";
      setError("That CSV is too large. Choose a file no larger than 5 MB.");
      return;
    }
    workingRef.current = true;
    setReadingFile(true);
    try {
      updateSource(await file.text(), file.name || "leads.csv");
    } catch {
      setError("Could not read that CSV file. Choose another file or paste the CSV instead.");
    } finally {
      workingRef.current = false;
      setReadingFile(false);
    }
  };

  const startMapping = () => {
    setError("");
    if (!csv.trim()) {
      setError("Upload a CSV or paste its contents first.");
      return;
    }
    if (csvByteLength(csv) > MAX_CSV_BYTES) {
      setError("That CSV is too large. Keep pasted CSV content at or below 5 MB.");
      return;
    }
    const nextHeaders = csvHeaders(csv);
    if (!nextHeaders.length) {
      setError("CSV needs a header row.");
      return;
    }
    setHeaders(nextHeaders);
    setMapping(defaultFieldMapping(nextHeaders));
    setVariablesSequenceId("");
    invalidatePreview("map");
  };

  const changeMapping = (header: string, field: string) => {
    setMapping((current) => {
      const next: FieldMapping = {};
      for (const [mappedHeader, mappedField] of Object.entries(current)) {
        if (mappedHeader === header) continue;
        // A column displaced by this choice goes back to its own custom variable instead of being dropped.
        if (mappedField === field) {
          const fallback = fallbackTarget(variableNames[mappedHeader]);
          if (fallback) next[mappedHeader] = fallback;
        } else next[mappedHeader] = mappedField;
      }
      if (field) next[header] = field as MappingTarget;
      return next;
    });
    invalidatePreview("map");
  };

  const changeVariablesSequence = (value: string) => {
    setVariablesSequenceId(value);
    invalidatePreview("map");
  };

  useEffect(() => {
    if (csvStep !== "map" || campaignsRequested.current) return;
    campaignsRequested.current = true;
    void apiFetch<{ sequences: Array<CampaignOption & { status?: string }> }>("/v1/sequences", {}, "Could not load campaigns.")
      .then((data) => setCampaignOptions(data.sequences.filter((sequence) => sequence.status !== "archived").map(({ id, name }) => ({ id, name }))))
      .catch(() => { campaignsRequested.current = false; });
  }, [csvStep]);

  const saveIndividual = async (addAnother: boolean) => {
    if (workingRef.current) return;
    const email = individual.email.trim();
    if (!email) {
      setError("Email is required.");
      emailRef.current?.focus();
      return;
    }
    workingRef.current = true;
    setBusy("individual");
    setError("");
    setIndividualSuccess("");
    try {
      const body = {
        email,
        firstName: individual.firstName.trim(),
        lastName: individual.lastName.trim(),
        company: individual.company.trim(),
        title: individual.title.trim(),
        ...(individualListId ? { listId: individualListId } : {}),
      };
      const data = await apiFetch<{ lead: Lead; campaignUpdates?: CampaignUpdate[] }>("/v1/leads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, "Could not add this lead.");
      const message = campaignLeadFeedback(1, data.campaignUpdates, "Lead added.");
      setIndividualSuccess(message);
      await onChanged(message);
      if (addAnother) {
        setIndividual({ email: "", firstName: "", lastName: "", company: "", title: "" });
        window.setTimeout(() => emailRef.current?.focus(), 0);
      } else {
        onClose();
      }
    } catch (reason) {
      setError(reason instanceof ApiError && reason.status === 409 ? "A lead with this email already exists." : apiErrorMessage(reason, "Could not add this lead."));
    } finally {
      workingRef.current = false;
      setBusy(null);
    }
  };

  const previewCsv = async () => {
    if (workingRef.current) return;
    if (!Object.values(mapping).includes("email")) {
      setError("Map one CSV column to Email before previewing.");
      return;
    }
    if (listSelection === NEW_LIST_VALUE && !listName.trim()) {
      setError("Enter a name for the new list.");
      return;
    }
    const requestGeneration = previewGeneration.current + 1;
    previewGeneration.current = requestGeneration;
    workingRef.current = true;
    setBusy("preview");
    setError("");
    try {
      const body = {
        csv,
        fileName,
        fieldMapping: mapping,
        mode,
        ...(customNames.length && variablesSequenceId ? { variablesSequenceId } : {}),
        ...(listSelection === NEW_LIST_VALUE ? { listName: listName.trim() } : listSelection ? { listId: listSelection } : {}),
      };
      const data = await apiFetch<{ import: ImportRecord }>("/v1/imports/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, "Could not preview this CSV.");
      if (previewGeneration.current !== requestGeneration) return;
      acceptedPreviewGeneration.current = requestGeneration;
      setPreview(data.import);
      setCsvStep("preview");
    } catch (reason) {
      if (previewGeneration.current === requestGeneration) setError(apiErrorMessage(reason, "Could not preview this CSV."));
    } finally {
      workingRef.current = false;
      setBusy(null);
    }
  };

  const commit = async () => {
    if (workingRef.current || !preview || acceptedPreviewGeneration.current !== previewGeneration.current) {
      if (!busy) setError("This preview is out of date. Preview the CSV again before importing.");
      return;
    }
    workingRef.current = true;
    setBusy("commit");
    setError("");
    try {
      const data = await apiFetch<{ import: ImportRecord; campaignUpdates?: CampaignUpdate[] }>(`/v1/imports/${preview.id}/commit`, { method: "POST", ...(customNames.length && variablesSequenceId ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ variablesSequenceId }) } : {}) }, "Could not import these leads.");
      setResult(data.import);
      setCsvStep("result");
      const added = (data.import.stats.createdRows ?? 0) + (data.import.stats.updatedRows ?? 0);
      const message = campaignLeadFeedback(added, data.campaignUpdates, "Lead import complete.");
      setImportSuccess(data.campaignUpdates?.length ? message : "");
      track("leads_imported", { count: added });
      await onChanged(message);
    } catch (reason) {
      setError(apiErrorMessage(reason, "Could not import these leads."));
    } finally {
      workingRef.current = false;
      setBusy(null);
    }
  };

  const changeMode = (nextMode: ImportMode) => {
    setMode(nextMode);
    invalidatePreview("map");
  };

  const changeListSelection = (value: string) => {
    setListSelection(value);
    if (value !== NEW_LIST_VALUE) setListName("");
    invalidatePreview("map");
  };

  const issueRows = preview?.rows.filter((row) => row.error || row.status !== "ready" || ["duplicate", "suppressed", "rejected", "not_found"].includes(row.action)) ?? [];
  const resultIssueRows = result?.rows.filter((row) => row.error || ["skipped", "invalid", "suppressed", "duplicate"].includes(row.status)) ?? [];
  const sampleRows = parseCsvSample(csv, 4).slice(1);
  const variableNames = suggestedVariableNames(headers);
  const customNames = customVariablesInMapping(mapping);
  const previewCustomNames = preview?.customFields ?? customNames;
  const variablesCampaignName = campaignOptions.find((option) => option.id === variablesSequenceId)?.name;
  const resultStats = result?.stats;
  const linesOnlyCount = preview?.rows.filter(isLinesOnlyUpdate).length ?? 0;

  return <div className="leads-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !isWorking) onClose(); }}>
    <section aria-busy={isWorking} aria-labelledby="add-leads-title" aria-modal="true" className={`leads-modal leads-modal--${tab}`} ref={dialogRef} role="dialog">
      <header className="leads-modal-header">
        <div><p className="ij-eyebrow">Contacts</p><h2 id="add-leads-title">Add leads</h2><p>Add one lead or import a CSV with a review step.</p></div>
        <button aria-label="Close add leads" disabled={isWorking} type="button" onClick={onClose}>✕</button>
      </header>

      <div aria-label="Add leads method" className="leads-modal-tabs" role="tablist">
        <button aria-controls="individual-lead-panel" aria-selected={tab === "individual"} id="individual-lead-tab" disabled={isWorking} ref={firstTabRef} role="tab" tabIndex={tab === "individual" ? 0 : -1} type="button" onClick={() => chooseTab("individual")} onKeyDown={handleTabKey}>Individual lead</button>
        <button aria-controls="csv-lead-panel" aria-selected={tab === "csv"} id="csv-lead-tab" disabled={isWorking} ref={csvTabRef} role="tab" tabIndex={tab === "csv" ? 0 : -1} type="button" onClick={() => chooseTab("csv")} onKeyDown={handleTabKey}>Upload CSV</button>
      </div>

      {error ? <p className="leads-modal-error" role="alert">{error}</p> : null}

      {tab === "individual" ? <form aria-labelledby="individual-lead-tab" className="leads-modal-panel leads-individual-form" id="individual-lead-panel" role="tabpanel" onSubmit={(event: FormEvent) => { event.preventDefault(); void saveIndividual(false); }}>
        {individualSuccess ? <div className="leads-import-success leads-field--wide" role="status"><span aria-hidden="true">✓</span><div><p>{individualSuccess}</p></div></div> : null}
        <label className="leads-field leads-field--wide"><span>Email <strong aria-hidden="true">*</strong></span><input autoComplete="email" disabled={isWorking} maxLength={320} name="email" ref={emailRef} required type="email" value={individual.email} onChange={(event) => setIndividual((current) => ({ ...current, email: event.target.value }))} /></label>
        <label className="leads-field"><span>First name</span><input autoComplete="given-name" disabled={isWorking} maxLength={120} name="firstName" value={individual.firstName} onChange={(event) => setIndividual((current) => ({ ...current, firstName: event.target.value }))} /></label>
        <label className="leads-field"><span>Last name</span><input autoComplete="family-name" disabled={isWorking} maxLength={120} name="lastName" value={individual.lastName} onChange={(event) => setIndividual((current) => ({ ...current, lastName: event.target.value }))} /></label>
        <label className="leads-field"><span>Company</span><input autoComplete="organization" disabled={isWorking} maxLength={180} name="company" value={individual.company} onChange={(event) => setIndividual((current) => ({ ...current, company: event.target.value }))} /></label>
        <label className="leads-field"><span>Title</span><input autoComplete="organization-title" disabled={isWorking} maxLength={180} name="title" value={individual.title} onChange={(event) => setIndividual((current) => ({ ...current, title: event.target.value }))} /></label>
        <label className="leads-field leads-field--wide"><span>List</span><select disabled={isWorking} name="listId" value={individualListId} onChange={(event) => setIndividualListId(event.target.value)}><option value="">No list</option>{lists.map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}</select></label>
        <div className="leads-modal-actions leads-field--wide">
          <Button variant="secondary" disabled={isWorking} onClick={() => void saveIndividual(true)}>Save and add another</Button>
          <Button disabled={isWorking} type="submit">{busy === "individual" ? "Saving…" : "Save lead"}</Button>
        </div>
      </form> : <div aria-labelledby="csv-lead-tab" className="leads-modal-panel leads-csv-panel" id="csv-lead-panel" role="tabpanel">
        <ol aria-label="CSV import progress" className="leads-import-steps">
          {["Upload", "Map columns", "Preview", "Complete"].map((label, index) => {
            const currentIndex = ["source", "map", "preview", "result"].indexOf(csvStep);
            return <li className={index === currentIndex ? "is-current" : index < currentIndex ? "is-complete" : ""} key={label}><span>{index + 1}</span>{label}</li>;
          })}
        </ol>

        {csvStep === "source" ? <div className="leads-import-source">
          <div className="leads-upload-box">
            <input accept=".csv,text/csv" id="leads-csv-file" disabled={isWorking} ref={fileInputRef} type="file" onChange={(event) => void selectFile(event)} />
            <label htmlFor="leads-csv-file"><strong>{readingFile ? "Reading file…" : "Choose a CSV file"}</strong><span>Up to 5 MB, or paste CSV content below.</span></label>
          </div>
          <div className="leads-import-source-head"><label htmlFor="leads-csv-content">CSV content</label><Button variant="secondary" onClick={() => downloadText("inboxjoy-leads-template.csv", "email,firstName,lastName,company,title,source\r\nada@example.com,Ada,Lovelace,Analytical Engines,Founder,Conference")}>Download template</Button></div>
          <textarea disabled={isWorking} id="leads-csv-content" placeholder="email,firstName,lastName,company,title,source" rows={8} value={csv} onChange={(event) => updateSource(event.target.value, fileName === "leads.csv" ? "pasted-leads.csv" : fileName)} />
          <div className="leads-modal-actions"><Button disabled={readingFile || !csv.trim()} onClick={startMapping}>Continue to mapping</Button></div>
        </div> : null}

        {csvStep === "map" ? <div className="leads-import-map">
          <div className="leads-import-options">
            <fieldset><legend>Import mode</legend>
              <label><input checked={mode === "add_only"} name="importMode" type="radio" value="add_only" onChange={() => changeMode("add_only")} /><span><strong>Add new leads</strong><small>Add new email addresses. Existing leads receive new custom variable lines and keep their other details.</small></span></label>
              <label><input checked={mode === "update_only"} name="importMode" type="radio" value="update_only" onChange={() => changeMode("update_only")} /><span><strong>Update existing leads</strong><small>Skip email addresses that are not already present.</small></span></label>
              <label><input checked={mode === "add_and_update"} name="importMode" type="radio" value="add_and_update" onChange={() => changeMode("add_and_update")} /><span><strong>Add and update</strong><small>Create new leads and update mapped fields on matches.</small></span></label>
            </fieldset>
            <div className="leads-import-destination">
              <label className="leads-field"><span>Destination list</span><select value={listSelection} onChange={(event) => changeListSelection(event.target.value)}><option value="">Imported leads (default)</option>{lists.map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}<option value={NEW_LIST_VALUE}>Create a new list…</option></select></label>
              {listSelection === NEW_LIST_VALUE ? <label className="leads-field"><span>New list name</span><input autoFocus maxLength={80} value={listName} onChange={(event) => { setListName(event.target.value); invalidatePreview("map"); }} /></label> : null}
              {customNames.length ? <label className="leads-field"><span>Save lines for</span><select value={variablesSequenceId} onChange={(event) => changeVariablesSequence(event.target.value)}><option value="">Every campaign (on the lead)</option>{campaignOptions.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select><small className="leads-import-help">{variablesSequenceId ? "These values are used by this campaign only." : "Every campaign that uses these variables reads the values saved on the lead."}</small></label> : null}
            </div>
          </div>
          <div className="leads-mapping-table">
            <div className="leads-mapping-row leads-mapping-head"><span>CSV column</span><span>Example</span><span>InboxJoy field</span></div>
            {headers.map((header, index) => <div className="leads-mapping-row" key={`${header}-${index}`}><strong>{header}</strong><span className="ph-mask">{sampleRows[0]?.[index] || "—"}</span><div className="leads-mapping-target"><select aria-label={`Map ${header}`} value={mapping[header] ?? ""} onChange={(event) => changeMapping(header, event.target.value)}><option value="">Do not import</option><optgroup label="Standard fields">{IMPORT_FIELDS.map((field) => <option key={field} value={field}>{FIELD_LABELS[field]}{field === "email" ? " (required)" : ""}</option>)}</optgroup><optgroup label="Custom variable">{variableNames[header] ? <option value={customTarget(variableNames[header]!)}>{`Custom: ${variableToken(variableNames[header]!)}`}</option> : null}</optgroup></select>{isCustomTarget(mapping[header]) ? <code className="lead-var-chip lead-var-chip--custom">{variableToken(customTargetName(mapping[header] as `custom:${string}`))}</code> : null}</div></div>)}
          </div>
          {customNames.length ? <p className="leads-import-help">Custom columns become variables you can use in any email step, like {customNames.slice(0, 3).map((name) => <code className="lead-var-chip" key={name}>{variableToken(name)}</code>)}. Blank update cells never erase existing lead data. Email identifies the lead and cannot be changed.</p> : <p className="leads-import-help">Blank update cells never erase existing lead data. Email identifies the lead and cannot be changed.</p>}
          <div className="leads-modal-actions"><Button variant="ghost" onClick={() => invalidatePreview("source")}>Back</Button><Button disabled={busy === "preview" || !Object.values(mapping).includes("email")} onClick={() => void previewCsv()}>{busy === "preview" ? "Building preview…" : "Preview import"}</Button></div>
        </div> : null}

        {csvStep === "preview" && preview ? <div className="leads-import-preview">
          <div className="leads-import-stats" aria-label="Import preview totals">
            <div><strong>{preview.stats.totalRows}</strong><span>Total</span></div><div><strong>{preview.stats.createRows}</strong><span>Create</span></div><div><strong>{preview.stats.updateRows}</strong><span>Update</span></div><div><strong>{preview.stats.unchangedRows}</strong><span>Unchanged</span></div><div><strong>{preview.stats.readyRows}</strong><span>Ready</span></div><div><strong>{preview.stats.duplicateRows}</strong><span>Duplicate</span></div><div><strong>{preview.stats.suppressedRows}</strong><span>Suppressed</span></div><div><strong>{preview.stats.rejectedRows}</strong><span>Invalid</span></div><div><strong>{preview.stats.skippedRows}</strong><span>Skipped</span></div>
          </div>
          {preview.stats.suppressedRows || preview.stats.rejectedRows || preview.stats.duplicateRows || preview.stats.skippedRows ? <p className="leads-import-feedback">Suppressed addresses will never be imported. Duplicate file rows, invalid emails, unchanged matches, and mode mismatches are skipped.</p> : null}
          {previewCustomNames.length && linesOnlyCount > 0 ? <p className="leads-import-help">{linesOnlyCount.toLocaleString()} existing {linesOnlyCount === 1 ? "lead gets" : "leads get"} new lines for {previewCustomNames.slice(0, 3).map((name) => <code className="lead-var-chip lead-var-chip--custom" key={name}>{variableToken(name)}</code>)}. Their other details stay as they are.</p> : null}
          {previewCustomNames.length ? <div className="lead-var-import-summary" aria-label="Custom variables being imported"><span className="polish-mono-label">Custom variables</span><div>{previewCustomNames.map((name) => <code className="lead-var-chip lead-var-chip--custom" key={name}>{variableToken(name)}</code>)}</div><p className="leads-import-help">{variablesCampaignName ? `Saved for ${variablesCampaignName} only.` : "Saved on each lead, so every campaign can use them."}</p></div> : null}
          <div className="leads-preview-head"><h3>Row preview</h3>{issueRows.length ? <Button variant="secondary" onClick={() => downloadText("inboxjoy-import-errors.csv", buildErrorCsv(issueRows.map((row) => ({ rowNumber: row.rowNumber, email: row.email, status: row.status, action: row.action, error: row.error ?? "", changedFields: row.changedFields ? JSON.stringify(row.changedFields) : "" }))))}>Download error CSV</Button> : null}</div>
          <div className="leads-preview-table" role="table" aria-label="CSV import preview">
            {preview.rows.slice(0, 50).map((row) => <div className="leads-preview-row ph-mask" key={row.rowNumber} role="row"><span>Row {row.rowNumber}</span><span>{row.email || "(missing email)"}</span><StatusBadge tone={previewTone(row)}>{rowLabel(row)}</StatusBadge><span>{previewRowNote(row)}</span>{row.changedFields && Object.keys(row.changedFields).length ? <dl>{Object.entries(row.changedFields).map(([field, change]) => <div key={field}><dt>{FIELD_LABELS[field as ImportField] ?? labelStatus(field)}</dt><dd><s>{String(change.before ?? "—")}</s> → <strong>{String(change.after ?? "—")}</strong></dd></div>)}</dl> : null}</div>)}
          </div>
          {preview.rows.length > 50 ? <p className="leads-import-help">Showing the first 50 of {preview.rows.length} preview rows.</p> : null}
          <div className="leads-modal-actions"><Button variant="ghost" disabled={busy === "commit"} onClick={() => invalidatePreview("map")}>Back to mapping</Button><Button disabled={busy === "commit" || preview.stats.readyRows === 0} onClick={() => void commit()}>{busy === "commit" ? "Importing…" : `Confirm ${preview.stats.readyRows} ready row${preview.stats.readyRows === 1 ? "" : "s"}`}</Button></div>
        </div> : null}

        {csvStep === "result" && resultStats ? <div className="leads-import-result">
          <div className="leads-import-success" role="status"><span aria-hidden="true">✓</span><div><h3>Import complete</h3><p>{importSuccess || "Your leads and list counts have been refreshed."}</p></div></div>
          <div className="leads-import-stats" aria-label="Import result totals"><div><strong>{resultStats.createdRows ?? 0}</strong><span>Created</span></div><div><strong>{resultStats.updatedRows ?? 0}</strong><span>Updated</span></div><div><strong>{resultStats.unchangedRows}</strong><span>Unchanged</span></div><div><strong>{resultStats.skippedRows}</strong><span>Skipped</span></div></div>
          {resultIssueRows.length ? <Button variant="secondary" onClick={() => downloadText("inboxjoy-import-errors.csv", buildErrorCsv(resultIssueRows.map((row) => ({ ...row, changedFields: row.changedFields ? JSON.stringify(row.changedFields) : "" }))))}><svg aria-hidden="true" className="leads-download-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4" /></svg>Download skipped rows and errors</Button> : null}
          <div className="leads-modal-actions"><Button variant="secondary" onClick={() => { updateSource("", "leads.csv"); setListSelection(defaultListId); setListName(""); if (fileInputRef.current) fileInputRef.current.value = ""; }}>Import another CSV</Button><Button onClick={onClose}>Done</Button></div>
        </div> : null}
      </div>}
    </section>
  </div>;
}
