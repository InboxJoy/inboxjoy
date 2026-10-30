"use client";

import { useEffect, useMemo, useRef, useState, type Dispatch, type FocusEvent, type FormEvent, type ReactNode, type SetStateAction } from "react";
import { Button, campaignDisplayStatus, campaignStatusLabel, campaignStatusReasonText, campaignStatusTone, Card, labelStatus, PageHeader, StatusBadge, type CampaignStatusFields } from "@inboxjoy/ui";
import { ApiError, apiErrorMessage, apiFetch, isEmailUnverifiedError } from "@/lib/api";
import { Toast } from "@/components/toast";
import { EmailVerificationModal } from "@/components/email-verification";
import { usePlanPicker } from "@/components/plan-picker";
import { extractCustomVariableNames, insertAtCursor, variableToken } from "@/lib/lead-variables";
import { AudiencePicker } from "./new/audience-picker";
import { CUSTOM_VARIABLES_HINT, missingVariablesFromError, type MissingVariablesSummary } from "./new/missing-variables";
import { MissingVariablesBlocker } from "./new/missing-variables-panel";
import { hasMatchingStepSnapshot, normalizeAudienceListIds, syncThreadedFollowUpSubjects, type AudienceList } from "./new/wizard-state";
import { hasUnsavedContent } from "./campaign-data";
import { canSaveCampaignChanges, getMailboxSelectionState, type SenderMode } from "./sender-mailboxes";
import { VariableChips, VariablePicker } from "./variable-tools";

export type CampaignStep = { id: string; delayDays: number; subject: string; body: string };
type Campaign = CampaignStatusFields & { id: string; name: string; description?: string; steps: CampaignStep[]; enrolledCount?: number; queuedCount?: number; mailboxIds?: string[] };
type Inbox = { id: string; email: string | null; provider?: string; status: string };
type Lead = { id: string; email: string; firstName?: string; lastName?: string; company?: string; status?: string };
type ContactList = AudienceList;
type EnrollmentResult = { enrolled: number; queued?: number; skipped?: Record<string, number>; message?: string };
type RefineAction = "shorten" | "lengthen" | "more_direct" | "warmer" | "rewrite_subject" | "fix_formatting" | "custom";
type RefineState = {
  instruction: string;
  loadingAction?: RefineAction;
  error?: string;
  previous?: Pick<CampaignStep, "subject" | "body">;
};

const refineActions: Array<{ action: Exclude<RefineAction, "custom">; label: string }> = [
  { action: "shorten", label: "Shorten" },
  { action: "lengthen", label: "Lengthen" },
  { action: "more_direct", label: "More direct" },
  { action: "warmer", label: "Warmer" },
  { action: "fix_formatting", label: "Fix formatting" },
  { action: "rewrite_subject", label: "New subject" },
];

export function newCampaignStep(delayDays = 0, subject = ""): CampaignStep {
  return { id: `local-${Date.now()}-${Math.random().toString(36).slice(2)}`, delayDays, subject, body: "" };
}

function isActive(status: string) { return status === "active" || status === "published"; }
function editableStatus(status: string) { return status === "draft" || status === "paused" || status === "completed"; }
function dayFor(steps: CampaignStep[], index: number) { return steps.slice(0, index + 1).reduce((total, step) => total + Math.max(0, Number(step.delayDays) || 0), 0) + 1; }

export function CampaignTimeline({
  steps,
  onChange,
  disabled = false,
  selectedStepIndex,
  onSelectStep,
  onFieldFocus,
}: {
  steps: CampaignStep[];
  onChange: Dispatch<SetStateAction<CampaignStep[]>>;
  disabled?: boolean;
  selectedStepIndex?: number;
  onSelectStep?: (index: number) => void;
  onFieldFocus?: (index: number, field: "subject" | "body", element: HTMLInputElement | HTMLTextAreaElement) => void;
}) {
  const [refinements, setRefinements] = useState<Record<string, RefineState>>({});
  const stepsRef = useRef(steps);
  stepsRef.current = steps;
  const [editingNewSubjectIds, setEditingNewSubjectIds] = useState<Set<string>>(() => new Set());
  const [savedVariableNames, setSavedVariableNames] = useState<string[]>([]);
  const fieldRefs = useRef<Record<string, { subject?: HTMLInputElement | null; body?: HTMLTextAreaElement | null }>>({});
  const lastField = useRef<Record<string, "subject" | "body">>({});
  const usedVariableNames = extractCustomVariableNames(...steps.flatMap((step) => [step.subject, step.body]));
  useEffect(() => {
    if (disabled) return;
    let cancelled = false;
    void apiFetch<{ names?: string[] }>("/v1/lead-variables/names", {}, "Could not load variable names.")
      .then((data) => { if (!cancelled) setSavedVariableNames(Array.isArray(data.names) ? data.names : []); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [disabled]);
  const updateRefinement = (stepId: string, patch: Partial<RefineState>) => setRefinements((current) => ({
    ...current,
    [stepId]: { instruction: "", ...current[stepId], ...patch },
  }));
  const updateStep = (index: number, patch: Partial<CampaignStep>) => {
    onChange((current) => {
      const previousFirstSubject = current[0]?.subject ?? "";
      const updated = current.map((step, stepIndex) => stepIndex === index ? { ...step, ...patch } : step);
      return typeof patch.subject === "string"
        ? syncThreadedFollowUpSubjects(updated, index, previousFirstSubject, editingNewSubjectIds)
        : updated;
    });
    const step = steps[index];
    if (step) updateRefinement(step.id, { error: undefined });
  };
  const addStep = (index: number) => onChange((current) => [...current.slice(0, index), newCampaignStep(index === 0 ? 0 : 3, index === 0 ? "" : `Re: ${current[0]?.subject ?? ""}`), ...current.slice(index)]);
  const removeStep = (index: number) => {
    const stepId = steps[index]?.id;
    onChange((current) => current.length === 1 ? current : current.filter((_, stepIndex) => stepIndex !== index));
    if (stepId) setEditingNewSubjectIds((current) => {
      const next = new Set(current);
      next.delete(stepId);
      return next;
    });
  };
  const moveStep = (index: number, direction: -1 | 1) => {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= steps.length) return;
    onChange((current) => {
      const copy = [...current];
      const currentStep = copy[index];
      const nextStep = copy[nextIndex];
      if (!currentStep || !nextStep) return current;
      copy[index] = nextStep;
      copy[nextIndex] = currentStep;
      return copy;
    });
    onSelectStep?.(nextIndex);
  };
  const insertVariable = (index: number, name: string) => {
    const step = steps[index];
    if (!step) return;
    const threaded = index > 0 && step.subject === `Re: ${steps[0]?.subject ?? ""}` && !editingNewSubjectIds.has(step.id);
    const remembered = lastField.current[step.id] ?? "body";
    const field = remembered === "subject" && !threaded ? "subject" : "body";
    const element = fieldRefs.current[step.id]?.[field] ?? null;
    const { value, cursor } = insertAtCursor(step[field], variableToken(name), element?.selectionStart, element?.selectionEnd);
    updateStep(index, { [field]: value });
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(cursor, cursor);
    });
  };
  const focusField = (index: number, field: "subject" | "body") => (event: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const focusedStep = steps[index];
    if (focusedStep) lastField.current[focusedStep.id] = field;
    onSelectStep?.(index);
    onFieldFocus?.(index, field, event.currentTarget);
  };
  const refineStep = async (index: number, action: RefineAction) => {
    const step = steps[index];
    if (!step) return;
    const source = { subject: step.subject, body: step.body };
    const instruction = refinements[step.id]?.instruction.trim();
    if (action === "custom" && !instruction) {
      updateRefinement(step.id, { error: "Tell the AI what you want to change." });
      return;
    }

    updateRefinement(step.id, { loadingAction: action, error: undefined });
    try {
      const refined = await apiFetch<Pick<CampaignStep, "subject" | "body">>("/v1/sequences/refine-step", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...source, action, ...(action === "custom" ? { instruction } : {}) }),
      }, "Could not refine this email. Your draft was not changed.");
      const currentStep = stepsRef.current.find((candidate) => candidate.id === step.id);
      if (!currentStep) {
        // Step was removed while refining — nowhere to show a message, stay silent.
        updateRefinement(step.id, { loadingAction: undefined, error: undefined });
        return;
      }
      if (!hasMatchingStepSnapshot(stepsRef.current, step.id, source)) {
        updateRefinement(step.id, {
          loadingAction: undefined,
          error: "Your latest edit was kept. Run the AI again to refine this version.",
        });
        return;
      }
      onChange((current) => {
        const latestStep = current.find((candidate) => candidate.id === step.id);
        if (!latestStep || !hasMatchingStepSnapshot(current, step.id, source)) return current;
        const refinedIndex = current.findIndex((candidate) => candidate.id === step.id);
        const previousFirstSubject = current[0]?.subject ?? "";
        const updated = current.map((candidate) => candidate.id === step.id ? { ...candidate, ...refined } : candidate);
        return syncThreadedFollowUpSubjects(updated, refinedIndex, previousFirstSubject, editingNewSubjectIds);
      });
      updateRefinement(step.id, { loadingAction: undefined, error: undefined, previous: source });
    } catch (reason) {
      if (stepsRef.current.some((candidate) => candidate.id === step.id)) {
        const current = hasMatchingStepSnapshot(stepsRef.current, step.id, source);
        updateRefinement(step.id, {
          loadingAction: undefined,
          error: current ? apiErrorMessage(reason, "Could not refine this email. Your draft was not changed.") : undefined,
        });
      }
    }
  };
  const submitCustomRefinement = (event: FormEvent, index: number) => {
    event.preventDefault();
    void refineStep(index, "custom");
  };
  const undoRefinement = (index: number, stepId: string) => {
    const previous = refinements[stepId]?.previous;
    if (!previous) return;
    updateStep(index, previous);
    updateRefinement(stepId, { previous: undefined, error: undefined });
  };

  return <section className="campaign-timeline" aria-label="Campaign steps">
    <div className="campaign-section-heading"><div><h2>Email sequence</h2><p>Days are calculated from the cumulative wait time. Variables render with each recipient&apos;s details.</p></div></div>
    {steps.map((step, index) => {
      const refinement = refinements[step.id] ?? { instruction: "" };
      const refining = Boolean(refinement.loadingAction);
      const canRefine = Boolean(step.subject.trim() && step.body.trim());
      const threadedSubject = `Re: ${steps[0]?.subject ?? ""}`;
      const isThreaded = index > 0 && step.subject === threadedSubject && !editingNewSubjectIds.has(step.id);
      const selectThreaded = () => {
        setEditingNewSubjectIds((current) => {
          const next = new Set(current);
          next.delete(step.id);
          return next;
        });
        updateStep(index, { subject: threadedSubject });
      };
      const selectNewSubject = () => setEditingNewSubjectIds((current) => new Set(current).add(step.id));
      const updateSubject = (subject: string) => {
        if (subject !== threadedSubject) {
          setEditingNewSubjectIds((current) => {
            const next = new Set(current);
            next.delete(step.id);
            return next;
          });
        }
        updateStep(index, { subject });
      };
      return <div className="campaign-step-wrap" key={step.id}>
      {index > 0 ? <div className="campaign-wait"><label>Wait <input aria-label={`Wait days before step ${index + 1}`} disabled={disabled} min="0" type="number" value={step.delayDays} onChange={(event) => updateStep(index, { delayDays: Math.max(0, Number(event.target.value) || 0) })} /> days</label>{!disabled ? <button type="button" className="campaign-add-inline" onClick={() => addStep(index)}>+ Add step here</button> : null}</div> : null}
      <Card className={`campaign-step-card${selectedStepIndex === index ? " campaign-step-card--selected" : ""}`}><div className="campaign-step-header"><div><span className="campaign-day">Day {dayFor(steps, index)}</span><h3>Email {index + 1}</h3>{step.subject ? <p className="thread-step-summary">{isThreaded ? <><span className="thread-summary-glyph" aria-hidden="true">↩</span>{" "}</> : null}{step.subject}</p> : null}</div>{!disabled ? <div className="campaign-step-controls"><button aria-label={`Move email ${index + 1} up`} title={`Move email ${index + 1} up`} disabled={index === 0} onClick={() => moveStep(index, -1)} type="button">↑</button><button aria-label={`Move email ${index + 1} down`} title={`Move email ${index + 1} down`} disabled={index === steps.length - 1} onClick={() => moveStep(index, 1)} type="button">↓</button><button aria-label={`Remove email ${index + 1}`} disabled={steps.length === 1} onClick={() => removeStep(index)} type="button">Remove</button></div> : null}</div>
        {index === 0 ? <label className="campaign-input-label">Subject<input disabled={disabled} ref={(element) => { (fieldRefs.current[step.id] ??= {}).subject = element; }} value={step.subject} onChange={(event) => updateStep(index, { subject: event.target.value })} onFocus={focusField(index, "subject")} placeholder="A quick idea for {{company}}" /></label> : <div className="thread-subject-field">
          <span className="thread-subject-label">Subject</span>
          <div className="thread-subject-control" role="group" aria-label={`Subject mode for email ${index + 1}`}>
            <button aria-pressed={isThreaded} className={isThreaded ? "is-active" : ""} disabled={disabled} onClick={selectThreaded} type="button">↩ Same thread</button>
            <button aria-pressed={!isThreaded} className={!isThreaded ? "is-active" : ""} disabled={disabled} onClick={selectNewSubject} type="button">New subject</button>
          </div>
          {isThreaded ? <p className="thread-subject-value"><span aria-hidden="true">↳</span>{" "}{threadedSubject}</p> : <input aria-label={`Subject for email ${index + 1}`} autoFocus={editingNewSubjectIds.has(step.id)} disabled={disabled} ref={(element) => { (fieldRefs.current[step.id] ??= {}).subject = element; }} value={step.subject} onChange={(event) => updateSubject(event.target.value)} onFocus={focusField(index, "subject")} placeholder="A quick idea for {{company}}" />}
          {isThreaded ? <p className="thread-subject-helper">Same-thread follow-ups get more replies — mailboxes group them under your first email.</p> : null}
        </div>}
        <label className="campaign-input-label">Email body<textarea disabled={disabled} ref={(element) => { (fieldRefs.current[step.id] ??= {}).body = element; }} value={step.body} onChange={(event) => updateStep(index, { body: event.target.value })} onFocus={focusField(index, "body")} placeholder={"Hi {{firstName}},\n\nI noticed {{company}} is growing..."} rows={8} /></label>
        {!disabled ? <VariablePicker stepLabel={`email ${index + 1}`} saved={savedVariableNames} used={usedVariableNames} onInsert={(name) => insertVariable(index, name)} /> : null}
        <VariableChips body={step.body} stepLabel={`email ${index + 1}`} subject={step.subject} />
        {!disabled ? <div className="campaign-refine-panel">
          <div className="campaign-refine-toolbar" aria-label={`Refine email ${index + 1}`}>
            <span>Refine</span>
            {refineActions.map(({ action, label }) => <button disabled={refining || !canRefine} key={action} onClick={() => void refineStep(index, action)} type="button">{refinement.loadingAction === action ? "Working…" : label}</button>)}
            {refinement.previous ? <button className="campaign-refine-undo" disabled={refining} onClick={() => undoRefinement(index, step.id)} type="button">Undo</button> : null}
          </div>
          <form className="campaign-refine-custom" onSubmit={(event) => submitCustomRefinement(event, index)}>
            <input aria-label={`Custom refinement for email ${index + 1}`} disabled={refining} maxLength={500} onChange={(event) => updateRefinement(step.id, { instruction: event.target.value, error: undefined })} placeholder="Tell it what to change" value={refinement.instruction} />
            <button disabled={refining || !canRefine || !refinement.instruction.trim()} type="submit">{refinement.loadingAction === "custom" ? "Working…" : "Apply"}</button>
          </form>
          {refinement.error ? <p className="campaign-refine-error" role="alert">{refinement.error}</p> : null}
        </div> : null}
        <p className="campaign-variable-hint">Personalize with <code>{"{{firstName}}"}</code>, <code>{"{{lastName}}"}</code>, <code>{"{{company}}"}</code>, <code>{"{{title}}"}</code>, or <code>{"{{email}}"}</code>. {CUSTOM_VARIABLES_HINT}</p>
      </Card>
    </div>;
    })}
    {!disabled ? <button className="campaign-add-step" onClick={() => addStep(steps.length)} type="button">+ Add another email</button> : null}
  </section>;
}

// Lifecycle buttons in the action bar remount the editor when they finish, which used to drop
// edits that were never saved (edit a paused campaign, click Resume, the copy reverts). They get
// this so they can save pending edits first and stop if the save fails.
export type EditorLifecycle = { unsavedChanges: boolean; saveChanges: () => Promise<boolean> };

export function CampaignEditor({ campaignId, statusFields, lifecycleActions, onSaved }: { campaignId?: string; statusFields?: CampaignStatusFields & { sequenceStatus?: string }; lifecycleActions?: ReactNode | ((editor: EditorLifecycle) => ReactNode); onSaved?: (campaign: Campaign) => void | Promise<void> }) {
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [steps, setSteps] = useState<CampaignStep[]>([newCampaignStep()]);
  const [inboxes, setInboxes] = useState<Inbox[]>([]);
  const [lists, setLists] = useState<ContactList[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(Boolean(campaignId));
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [testEmail, setTestEmail] = useState("");
  const [testStep, setTestStep] = useState("1");
  const [senderMode, setSenderMode] = useState<SenderMode>("all");
  const [mailboxIds, setMailboxIds] = useState<string[]>([]);
  const [listIds, setListIds] = useState<string[]>([]);
  const [leadIds, setLeadIds] = useState<string[]>([]);
  const [readyCount, setReadyCount] = useState(0);
  const [enrollment, setEnrollment] = useState<EnrollmentResult | null>(null);
  const [missingBlocker, setMissingBlocker] = useState<MissingVariablesSummary | null>(null);
  const [verificationOpen, setVerificationOpen] = useState(false);
  const { nudgeIfUnpaid } = usePlanPicker();

  const syncMailboxSelection = (sequence: Campaign, savedMailboxIds = sequence.mailboxIds ?? []) => {
    setCampaign({ ...sequence, mailboxIds: savedMailboxIds });
    setSenderMode(savedMailboxIds.length > 0 ? "selected" : "all");
    setMailboxIds(savedMailboxIds);
  };

  const reloadDetails = async (id: string) => {
    const [sequenceData, inboxData, leadData, listResult]: [
      { sequences: Campaign[] }, { inboxes: Inbox[] }, { leads: Lead[]; pagination?: { total: number } }, { lists?: ContactList[]; contactLists?: ContactList[] },
    ] = await Promise.all([
      apiFetch<{ sequences: Campaign[] }>("/v1/sequences", {}, "Could not load campaigns."),
      apiFetch<{ inboxes: Inbox[] }>("/v1/inboxes", {}, "Could not load sender mailboxes."),
      apiFetch<{ leads: Lead[]; pagination?: { total: number } }>("/v1/leads?status=active&page=1&pageSize=100", {}, "Could not load leads."),
      apiFetch<{ lists?: ContactList[]; contactLists?: ContactList[] }>("/v1/lists", {}, "Could not load contact lists.").catch(() => ({ lists: [] })),
    ]);
    const found = sequenceData.sequences.find((item) => item.id === id);
    if (!found) throw new Error("Campaign not found.");
    syncMailboxSelection(found);
    setName(found.name);
    setDescription(found.description ?? "");
    setSteps(found.steps);
    setInboxes(inboxData.inboxes);
    setLeads(leadData.leads);
    setReadyCount(leadData.pagination?.total ?? leadData.leads.length);
    const nextLists = listResult.lists ?? listResult.contactLists ?? [];
    setLists(nextLists);
    setListIds((current) => normalizeAudienceListIds(current, undefined, new Set(nextLists.map((list) => list.id))));
  };

  useEffect(() => {
    if (!campaignId) return;
    void (async () => {
      setLoading(true);
      setError("");
      try { await reloadDetails(campaignId); } catch (reason) { setError(apiErrorMessage(reason, "Could not load campaign.")); } finally { setLoading(false); }
    })();
  }, [campaignId]);

  const storedStatus = statusFields?.sequenceStatus === "paused" ? "paused" : statusFields?.status ?? campaign?.status;
  const displayStatus = campaignDisplayStatus(statusFields ?? campaign ?? { status: "draft" });
  const reasonText = campaignStatusReasonText((statusFields ?? campaign)?.statusReason);
  const canEdit = storedStatus === undefined || editableStatus(storedStatus);
  const active = storedStatus ? isActive(storedStatus) : false;
  const selectedLeads = useMemo(() => new Set(leadIds), [leadIds]);
  const mailboxSelection = getMailboxSelectionState(campaign?.mailboxIds, senderMode, mailboxIds);
  const canSave = canSaveCampaignChanges(storedStatus, mailboxSelection, Boolean(busy));
  const unsavedChanges = (canEdit && hasUnsavedContent(campaign, { name, description, steps })) || (mailboxSelection.dirty && mailboxSelection.valid);

  const save = async (): Promise<boolean> => {
    if (!canSave) return false;
    if (canEdit && (!name.trim() || steps.some((step) => !step.subject.trim() || !step.body.trim()))) {
      setError("Add a campaign name plus a subject and body for every step.");
      return false;
    }
    setBusy("save"); setError(""); setNotice("");
    let contentSaved = false;
    try {
      let savedCampaign = campaign;
      if (canEdit) {
        const payload = { name: name.trim(), description: description.trim(), steps: steps.map((step) => ({ ...step, delayDays: Math.max(0, Number(step.delayDays) || 0) })) };
        const data = await apiFetch<{ sequence: Campaign }>(campaignId ? `/v1/sequences/${campaignId}` : "/v1/sequences", { method: campaignId ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }, "Could not save campaign.");
        if (!campaignId) { window.location.assign(`/app/sequences/${data.sequence.id}`); return true; }
        savedCampaign = { ...data.sequence, mailboxIds: data.sequence.mailboxIds ?? campaign?.mailboxIds ?? [] };
        setCampaign(savedCampaign); setName(savedCampaign.name); setDescription(savedCampaign.description ?? ""); setSteps(savedCampaign.steps);
        contentSaved = true;
      }
      if (!savedCampaign || !campaignId) return true;
      let savedNotice = "Campaign saved.";
      if (mailboxSelection.dirty && mailboxSelection.valid) {
        const data = await apiFetch<{ sequence: Campaign; mailboxIds: string[]; reassigned: number }>(`/v1/sequences/${campaignId}/mailboxes`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ mailboxIds: mailboxSelection.mailboxIds }) }, "Could not save sender mailboxes.");
        savedCampaign = { ...data.sequence, mailboxIds: data.mailboxIds };
        savedNotice = `Sender mailboxes saved.${data.reassigned > 0 ? ` ${data.reassigned} contacts waiting for their first email moved to the selected mailboxes.` : ""}`;
      }
      syncMailboxSelection(savedCampaign);
      setNotice(savedNotice);
      await onSaved?.(savedCampaign);
      return true;
    } catch (reason) {
      setError(contentSaved ? `Campaign saved. ${apiErrorMessage(reason, "Sender mailboxes could not be saved.")} Save sender mailboxes again to apply them.` : apiErrorMessage(reason, "Could not save campaign."));
      return false;
    } finally { setBusy(""); }
  };

  const sendTest = async () => {
    if (!campaignId || !testEmail.trim()) return;
    setBusy("test"); setError(""); setNotice("");
    try {
      await apiFetch(`/v1/sequences/${campaignId}/test-send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stepOrder: Number(testStep), to: testEmail.trim() }) }, "Could not send test email.");
      setNotice(`Test email sent to ${testEmail.trim()}.`);
    } catch (reason) {
      if (isEmailUnverifiedError(reason)) setVerificationOpen(true);
      else setError(apiErrorMessage(reason, "Could not send test email."));
    } finally { setBusy(""); }
  };

  const enroll = async () => {
    const usingLists = lists.length > 0;
    if (!campaignId || busy || mailboxSelection.dirty || !mailboxSelection.valid || (usingLists ? listIds.length === 0 : leadIds.length === 0)) return;
    setBusy("enroll"); setError(""); setEnrollment(null); setMissingBlocker(null);
    try {
      const data = await apiFetch<EnrollmentResult>(`/v1/sequences/${campaignId}/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(usingLists ? { listIds } : { leadIds }) }, "Could not enroll contacts.");
      setEnrollment(data); setNotice(data.message ?? `${data.enrolled} contacts enrolled.`);
      if (data.enrolled > 0) nudgeIfUnpaid("leads");
      await reloadDetails(campaignId);
    } catch (reason) {
      const missing = missingVariablesFromError(reason);
      if (isEmailUnverifiedError(reason)) setVerificationOpen(true);
      else if (missing) setMissingBlocker(missing);
      else setError(apiErrorMessage(reason, "Could not enroll contacts."));
    } finally { setBusy(""); }
  };

  if (loading) return <div className="page-stack"><PageHeader eyebrow="Campaigns" title="Loading campaign" description="Retrieving your campaign and its delivery details." /><Card className="campaign-loading"><p>Loading campaign…</p></Card></div>;
  if (error && campaignId && !campaign) return <div className="page-stack"><PageHeader eyebrow="Campaigns" title="Campaign unavailable" description="We could not retrieve this campaign." /><Card className="campaign-message campaign-message--error"><p role="alert">{error}</p><Button variant="ghost" onClick={() => void reloadDetails(campaignId).catch((reason) => setError(apiErrorMessage(reason, "Could not load campaign.")))}>Try again</Button></Card></div>;

  return <div className="page-stack campaign-editor-shell">
    <EmailVerificationModal open={verificationOpen} onClose={() => setVerificationOpen(false)} />
    <PageHeader eyebrow="Campaigns" title={campaign ? campaign.name : "New campaign"} description={campaign ? "Compose steps, review performance, and manage enrollment from one workspace." : "Start with a first email, then add follow-ups at the right cadence."} />
    {error ? <Toast tone="error" message={error} onDismiss={() => setError("")} /> : null}
    {notice ? <Toast tone="success" message={notice} onDismiss={() => setNotice("")} /> : null}
    {active ? <Card className="campaign-active-banner"><div><StatusBadge tone={campaignStatusTone(displayStatus)}>{campaignStatusLabel(displayStatus)}</StatusBadge><strong>Pause to edit</strong><p>Pause this campaign below before changing its steps.</p></div></Card> : null}
    {campaign && !canEdit && !active ? <Card className="campaign-active-banner"><div><StatusBadge tone={campaignStatusTone(displayStatus)}>{campaignStatusLabel(displayStatus)}</StatusBadge><strong>This campaign is read-only</strong><p>Draft, paused, and finished campaigns can be edited.</p></div></Card> : null}
    <Card className="campaign-composer">
      <div className="card-header"><div><h2>Campaign details</h2><p>Use a clear internal name and context for your team.</p></div><div><StatusBadge tone={campaignStatusTone(displayStatus)}>{campaignStatusLabel(displayStatus)}</StatusBadge>{reasonText ? <p className="campaign-muted">{reasonText}</p> : null}</div></div>
      <div className="campaign-field-grid"><label>Campaign name<input disabled={!canEdit} value={name} onChange={(event) => setName(event.target.value)} placeholder="Q4 founder outreach" /></label><label>Description<textarea disabled={!canEdit} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Who this campaign is for and what it should achieve." rows={3} /></label></div>
    </Card>
    {campaign && (canEdit || active) ? <SenderMailboxes inboxes={inboxes} senderMode={senderMode} setSenderMode={setSenderMode} mailboxIds={mailboxIds} setMailboxIds={setMailboxIds} busy={Boolean(busy)} valid={mailboxSelection.valid} /> : null}
    <CampaignTimeline disabled={!canEdit} steps={steps} onChange={setSteps} />
    <nav className="campaign-action-bar" aria-label="Campaign actions">
      <div className="campaign-action-bar__context"><a className="ij-button ij-button--ghost" href="/app/sequences" aria-label="Back to all campaigns">← Campaigns</a><StatusBadge tone={campaignStatusTone(displayStatus)}>{campaignStatusLabel(displayStatus)}</StatusBadge></div>
      <div className="campaign-action-bar__actions"><Button variant="secondary" className="campaign-save-outline" aria-describedby={!mailboxSelection.valid ? "sender-mailboxes-hint" : undefined} disabled={!canSave} onClick={() => void save()}>{busy === "save" ? "Saving…" : campaignId ? "Save changes" : "Create campaign"}</Button>{typeof lifecycleActions === "function" ? lifecycleActions({ unsavedChanges, saveChanges: save }) : lifecycleActions}</div>
    </nav>
    {missingBlocker ? <MissingVariablesBlocker summary={missingBlocker} /> : null}
    {campaignId && campaign ? <CampaignDetails campaign={campaign} inboxes={inboxes} lists={lists} leads={leads} readyCount={readyCount} mailboxChangesUnsaved={mailboxSelection.dirty} listIds={listIds} setListIds={setListIds} selectedLeads={selectedLeads} setLeadIds={setLeadIds} testEmail={testEmail} setTestEmail={setTestEmail} testStep={testStep} setTestStep={setTestStep} busy={busy} enrollment={enrollment} onSendTest={sendTest} onEnroll={enroll} /> : null}
  </div>;
}

function SenderMailboxes({ inboxes, senderMode, setSenderMode, mailboxIds, setMailboxIds, busy, valid }: {
  inboxes: Inbox[]; senderMode: SenderMode; setSenderMode: (mode: SenderMode) => void; mailboxIds: string[]; setMailboxIds: (ids: string[]) => void; busy: boolean; valid: boolean;
}) {
  const selectedMailboxIds = new Set(mailboxIds);
  return <Card className="campaign-detail-card">
    <div className="card-header"><div><h2>Sender mailboxes</h2><p>Save the mailboxes this campaign uses for new contacts.</p></div></div>
    <label className="campaign-input-label">Sender mode<select aria-describedby="sender-mailboxes-hint" disabled={busy} value={senderMode} onChange={(event) => setSenderMode(event.target.value as SenderMode)}><option value="all">Rotate across all healthy mailboxes (recommended)</option><option value="selected">Choose specific mailboxes</option></select></label>
    {senderMode === "selected" ? <div className="campaign-lead-picker"><p className="campaign-input-label" id="sender-mailboxes-label">Sender mailboxes <small>({mailboxIds.filter((id) => inboxes.some((inbox) => inbox.id === id)).length} selected)</small></p>{inboxes.length ? <div className="campaign-lead-list ph-mask" role="group" aria-labelledby="sender-mailboxes-label">{inboxes.map((inbox) => { const available = inbox.status === "active" && Boolean(inbox.email); const checked = selectedMailboxIds.has(inbox.id); return <label key={inbox.id}><input checked={checked} disabled={busy || (!available && !checked)} type="checkbox" onChange={() => setMailboxIds(checked ? mailboxIds.filter((id) => id !== inbox.id) : [...mailboxIds, inbox.id])} /><span>{inbox.email ?? "Address pending — reconnect"}<small>{!inbox.email ? "Address pending" : inbox.status === "expired" ? "Reconnect needed" : labelStatus(inbox.status)}</small></span></label>; })}</div> : <p className="campaign-muted">No mailboxes available. Connect a mailbox first.</p>}</div> : null}
    <p className="campaign-muted" id="sender-mailboxes-hint" aria-live="polite">{!valid ? "Choose at least one mailbox to save." : "Each contact keeps the same sender for every follow-up."}</p>
  </Card>;
}

function CampaignDetails({ campaign, inboxes, lists, leads, readyCount, mailboxChangesUnsaved, listIds, setListIds, selectedLeads, setLeadIds, testEmail, setTestEmail, testStep, setTestStep, busy, enrollment, onSendTest, onEnroll }: {
  campaign: Campaign; inboxes: Inbox[]; lists: ContactList[]; leads: Lead[]; readyCount: number; mailboxChangesUnsaved: boolean; listIds: string[]; setListIds: (ids: string[]) => void; selectedLeads: Set<string>; setLeadIds: (ids: string[]) => void; testEmail: string; setTestEmail: (email: string) => void; testStep: string; setTestStep: (step: string) => void; busy: string; enrollment: EnrollmentResult | null; onSendTest: () => Promise<void>; onEnroll: () => Promise<void>;
}) {
  const showLists = lists.length > 0;
  const availableInboxes = inboxes.filter((inbox) => inbox.status === "active" && inbox.email);
  const savedMailboxIds = campaign.mailboxIds ?? [];
  const hasSender = availableInboxes.some((inbox) => savedMailboxIds.length === 0 || savedMailboxIds.includes(inbox.id));
  // A saved list can still hold a deleted mailbox (it is kept so the list never turns into "all mailboxes").
  const listedSenderCount = savedMailboxIds.filter((id) => inboxes.some((inbox) => inbox.id === id)).length;
  const isDraft = campaign.status === "draft";
  const canEnroll = (isActive(campaign.status) || isDraft) && hasSender && !mailboxChangesUnsaved && (showLists ? listIds.length > 0 : selectedLeads.size > 0);
  const queuedCount = campaign.queuedCount ?? 0;
  return <>
    <div className="two-column campaign-tools-row"><Card className="campaign-detail-card campaign-test-card"><div className="card-header"><div><h2>Send a test</h2><p>Send one email to any address to check it. No lead is enrolled.</p></div></div><div className="campaign-test-grid"><label>Step<select value={testStep} onChange={(event) => setTestStep(event.target.value)}>{campaign.steps.map((_, index) => <option key={index + 1} value={index + 1}>Email {index + 1}</option>)}</select></label><label>Recipient email<input type="email" value={testEmail} onChange={(event) => setTestEmail(event.target.value)} placeholder="you@company.com" /></label></div><div className="campaign-test-actions"><Button disabled={busy === "test" || !testEmail.trim()} onClick={() => void onSendTest()}>{busy === "test" ? "Sending…" : "Send test"}</Button></div></Card>
      <Card className="campaign-detail-card">
        <div className="card-header"><div><h2>Enroll contacts</h2><p>Choose your audience to queue their first emails.</p></div></div>
        <p className="campaign-muted">{!savedMailboxIds.length ? "Sends from all healthy mailboxes" : listedSenderCount ? `Sends from ${listedSenderCount} selected ${listedSenderCount === 1 ? "mailbox" : "mailboxes"}` : "Its sender mailboxes were deleted. Choose a mailbox above to keep sending."}</p>
        {showLists ? <AudiencePicker legend="Contact lists" lists={lists} listIds={listIds} onChange={(nextListIds) => { setListIds(nextListIds); setLeadIds([]); }} readyCount={readyCount} showAllReady={false} /> : <div className="campaign-lead-picker"><p className="campaign-input-label">Choose leads <small>({selectedLeads.size} selected)</small></p>{leads.length ? <div className="campaign-lead-list ph-mask">{leads.slice(0, 12).map((lead) => <label key={lead.id}><input checked={selectedLeads.has(lead.id)} type="checkbox" onChange={() => setLeadIds(selectedLeads.has(lead.id) ? [...selectedLeads].filter((id) => id !== lead.id) : [...selectedLeads, lead.id])} /><span>{[lead.firstName, lead.lastName].filter(Boolean).join(" ") || lead.email}<small>{lead.email}{lead.company ? ` · ${lead.company}` : ""}</small></span></label>)}</div> : <p className="campaign-muted">No leads available. Import leads first.</p>}</div>}
        {isDraft
          ? <p className="campaign-muted">{queuedCount > 0 ? `${queuedCount} queued — they start sending once you publish.` : "Queue contacts now. They start sending once you publish."}</p>
          : queuedCount > 0
            ? <p className="campaign-muted">{queuedCount} queued {queuedCount === 1 ? "contact hasn't" : "contacts haven't"} started sending yet. Publish again once that's resolved.</p>
            : !isActive(campaign.status) ? <p className="campaign-muted">Publish this campaign before enrolling contacts.</p> : null}
        <div className="campaign-enroll-actions">
          <Button aria-describedby={mailboxChangesUnsaved ? "enroll-mailboxes-hint" : undefined} disabled={Boolean(busy) || !canEnroll} onClick={() => void onEnroll()}>{busy === "enroll" ? (isDraft ? "Queueing…" : "Enrolling…") : isDraft ? "Queue contacts" : "Enroll contacts"}</Button>
          <p className="campaign-muted" id="enroll-mailboxes-hint" aria-live="polite">{mailboxChangesUnsaved ? "Save your mailbox changes first." : ""}</p>
        </div>
        {enrollment ? <div className="campaign-enrollment-result">{typeof enrollment.queued === "number" ? <strong>{enrollment.queued} queued</strong> : <strong>{enrollment.enrolled} enrolled</strong>}{enrollment.skipped && Object.values(enrollment.skipped).some(Boolean) ? <p>Skipped: {Object.entries(enrollment.skipped).filter(([, count]) => count).map(([reason, count]) => `${count} ${labelStatus(reason)}`).join(" · ")}</p> : null}</div> : null}
      </Card></div>
  </>;
}
