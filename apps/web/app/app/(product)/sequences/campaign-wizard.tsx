"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, labelStatus, PageHeader, StatusBadge } from "@inboxjoy/ui";
import { apiErrorMessage, apiFetch, isEmailUnverifiedError } from "@/lib/api";
import { EmailVerificationModal } from "@/components/email-verification";
import { usePlanPicker } from "@/components/plan-picker";
import { Toast } from "@/components/toast";
import { track } from "@/lib/analytics";
import { Mail } from "lucide-react";
import { mailboxProviderLabels, type MailboxProvider } from "@/lib/smtp-mailbox-form";

import { extractCustomVariableNames, fillSampleVariables, markCustomPlaceholders, splitMissingPlaceholders } from "@/lib/lead-variables";
import { CampaignTimeline, newCampaignStep, type CampaignStep } from "./campaign-editor";
import { LeadVariablesDialog } from "./lead-variables-dialog";
import { PreviewAsLead, type PreviewLead } from "./preview-as-lead";
import { AudiencePicker } from "./new/audience-picker";
import { fillMissingValuesAccess, missingVariablesFromError, readMissingVariables, type MissingVariablesSummary } from "./new/missing-variables";
import { MissingVariablesBlocker, MissingVariablesWarning } from "./new/missing-variables-panel";
import { audienceNames, buildWizardDraftRequest, buildWizardLaunchRequest, getLaunchBlocker, hasEditedWizardSteps, localizeWizardSteps, normalizeAudienceListIds, restoreWizardMailboxIds, wizardStepsFingerprint, type AudienceList } from "./new/wizard-state";

const STORAGE_KEY_PREFIX = "inboxjoy.campaign-wizard.v2";

type ContactList = AudienceList;
type Lead = { id: string; status?: string };
type Template = { key: string; name: string; description: string; steps: Array<{ delayDays: number; subject: string; body: string }> };
type Inbox = { id: string; email: string | null; displayName?: string; provider?: MailboxProvider; status: string; warmupPercent?: number };
type DraftResponse = { name: string; steps: Array<{ delayDays: number; subject: string; body: string }> };
type Sequence = { id: string; name: string; description?: string; steps: CampaignStep[]; mailboxIds?: string[] };
type SequenceResponse = { sequence: Sequence };
type Preview = { contactId?: string | null; steps: Array<{ stepId: string; stepOrder: number; subject: string; body: string }> };
type WorkspaceIdentity = { workspace: { id: string; postalAddress?: string | null }; user: { email: string } };
type SkipReason = "suppressed" | "already_enrolled" | "replied" | "bounced" | "unsubscribed" | "missing_variables";
type AudiencePreview = { eligible: number; total: number; skipped: Partial<Record<SkipReason, number>>; missingVariables?: unknown };
type AudiencePreviewState = { signature: string; status: "loading" | "ready" | "error"; data?: AudiencePreview; error?: string };
type LaunchResult = { enrolled: number; skipped?: Partial<Record<SkipReason | "no_candidates", number>>; message?: string };
type CampaignLaunchResponse = LaunchResult | { enrollment: LaunchResult };
type EntryMode = "template" | "ai" | "scratch";
type SavedWizard = {
  currentStep: number;
  listIds: string[];
  audience?: string;
  entryMode: EntryMode;
  name: string;
  description: string;
  aiDescription: string;
  tone: "direct" | "friendly";
  stepCount: number;
  steps: CampaignStep[];
  selectedStepIndex: number;
  senderId: string;
  mailboxIds?: string[];
  sequenceId: string;
  campaignId: string;
  savedFingerprint: string;
  sourceStepsFingerprint: string;
};

function fingerprint(name: string, description: string, steps: CampaignStep[]) {
  return JSON.stringify({ name: name.trim(), description: description.trim(), steps: steps.map(({ delayDays, subject, body }) => ({ delayDays, subject, body })) });
}

// Sample preview: standard variables get sample data, custom ones read as [name] like a lead with no value.
function renderSamplePreview(value: string) {
  return markCustomPlaceholders(fillSampleVariables(value));
}

function PreviewText({ text, names }: { text: string; names: string[] }) {
  return <>{splitMissingPlaceholders(text, names).map((segment, index) => segment.missing ? <mark className="lead-var-missing" key={index} title="This lead has no value for this variable">{segment.text}</mark> : <span key={index}>{segment.text}</span>)}</>;
}

const skipLabels: Record<SkipReason, string> = {
  suppressed: "suppressed",
  already_enrolled: "already enrolled",
  replied: "already replied",
  bounced: "previously bounced",
  unsubscribed: "unsubscribed",
  missing_variables: "waiting for custom variable lines (they join once the lines are added)",
};

function skippedRows(skipped: LaunchResult["skipped"]) {
  return (Object.keys(skipLabels) as SkipReason[]).flatMap((reason) => {
    const count = skipped?.[reason] ?? 0;
    return count > 0 ? [{ reason, label: skipLabels[reason], count }] : [];
  });
}

export function CampaignWizard() {
  const router = useRouter();
  const [currentStep, setCurrentStep] = useState(0);
  const [lists, setLists] = useState<ContactList[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [inboxes, setInboxes] = useState<Inbox[]>([]);
  const [smtpEnabled, setSmtpEnabled] = useState(false);
  const [readyCount, setReadyCount] = useState(0);
  const [audiencePreview, setAudiencePreview] = useState<AudiencePreviewState>({ signature: "", status: "loading" });
  const [audiencePreviewRetry, setAudiencePreviewRetry] = useState(0);
  const [listIds, setListIds] = useState<string[]>([]);
  const [entryMode, setEntryMode] = useState<EntryMode>("template");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [aiDescription, setAiDescription] = useState("");
  const [tone, setTone] = useState<"direct" | "friendly">("direct");
  const [stepCount, setStepCount] = useState(4);
  const [steps, setSteps] = useState<CampaignStep[]>([newCampaignStep()]);
  const [selectedStepIndex, setSelectedStepIndex] = useState(0);
  const [postalAddress, setPostalAddress] = useState<string | null>(null);
  const [senderId, setSenderId] = useState("");
  const [restoredMailboxIds, setRestoredMailboxIds] = useState<string[] | null>(null);
  const [sequenceId, setSequenceId] = useState("");
  const [campaignId, setCampaignId] = useState("");
  const [savedFingerprint, setSavedFingerprint] = useState("");
  const [sourceStepsFingerprint, setSourceStepsFingerprint] = useState(() => wizardStepsFingerprint([{ delayDays: 0, subject: "", body: "" }]));
  const [serverPreview, setServerPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [missingBlocker, setMissingBlocker] = useState<MissingVariablesSummary | null>(null);
  const [notice, setNotice] = useState("");
  const [storageKey, setStorageKey] = useState("");
  const [restored, setRestored] = useState(false);
  const [persistWizard, setPersistWizard] = useState(true);
  const [launchResult, setLaunchResult] = useState<LaunchResult | null>(null);
  const [launchedSequenceId, setLaunchedSequenceId] = useState("");
  const [verificationOpen, setVerificationOpen] = useState(false);
  const { nudgeIfUnpaid } = usePlanPicker();
  const [previewLead, setPreviewLead] = useState<PreviewLead | null>(null);
  const [variablesOpen, setVariablesOpen] = useState(false);
  const audiencePreviewGeneration = useRef(0);

  useEffect(() => {
    void Promise.all([
      apiFetch<{ lists?: ContactList[]; contactLists?: ContactList[] }>("/v1/lists", {}, "Could not load contact lists."),
      apiFetch<{ templates: Template[] }>("/v1/templates", {}, "Could not load campaign templates."),
      apiFetch<{ inboxes: Inbox[]; features?: { smtp?: boolean } }>("/v1/inboxes", {}, "Could not load sender mailboxes."),
      apiFetch<{ leads: Lead[]; pagination?: { page: number; pageSize: number; total: number } }>("/v1/leads?status=active&page=1&pageSize=1", {}, "Could not load leads."),
      apiFetch<WorkspaceIdentity>("/v1/workspace", {}, "Could not identify this workspace."),
    ]).then(async ([listData, templateData, inboxData, leadData, identity]) => {
      setLists(listData.lists ?? listData.contactLists ?? []);
      setTemplates(templateData.templates);
      setInboxes(inboxData.inboxes);
      setSmtpEnabled(inboxData.features?.smtp === true);
      setReadyCount(leadData.pagination?.total ?? leadData.leads.filter((lead) => lead.status === "Ready" || lead.status === "active").length);
      setPostalAddress(identity.workspace.postalAddress ?? null);

      const nextStorageKey = `${STORAGE_KEY_PREFIX}:${identity.workspace.id}:${identity.user.email.toLowerCase()}`;
      setStorageKey(nextStorageKey);
      const raw = window.localStorage.getItem(nextStorageKey);
      const defaultSenderId = inboxData.inboxes.find((inbox) => inbox.status === "active" && inbox.email)?.id;
      if (!raw) {
        setSenderId(defaultSenderId ?? "");
        return;
      }

      let restoredSequenceId = "";
      try {
        const saved = JSON.parse(raw) as Partial<SavedWizard>;
        if (typeof saved.currentStep === "number") setCurrentStep(Math.max(0, Math.min(2, saved.currentStep)));
        setListIds(normalizeAudienceListIds(saved.listIds, saved.audience, new Set((listData.lists ?? listData.contactLists ?? []).map((list) => list.id))));
        if (saved.entryMode === "template" || saved.entryMode === "ai" || saved.entryMode === "scratch") setEntryMode(saved.entryMode);
        if (typeof saved.name === "string") setName(saved.name);
        if (typeof saved.description === "string") setDescription(saved.description);
        if (typeof saved.aiDescription === "string") setAiDescription(saved.aiDescription);
        if (saved.tone === "direct" || saved.tone === "friendly") setTone(saved.tone);
        if (typeof saved.stepCount === "number") setStepCount(saved.stepCount);
        if (Array.isArray(saved.steps) && saved.steps.length) {
          setSteps(saved.steps);
          setSourceStepsFingerprint(typeof saved.sourceStepsFingerprint === "string" ? saved.sourceStepsFingerprint : wizardStepsFingerprint(saved.steps));
        }
        if (typeof saved.selectedStepIndex === "number") setSelectedStepIndex(saved.selectedStepIndex);
        if (typeof saved.senderId === "string") setSenderId(saved.senderId);
        if (Array.isArray(saved.mailboxIds)) setRestoredMailboxIds(restoreWizardMailboxIds(saved.mailboxIds));
        if (typeof saved.sequenceId === "string") { setSequenceId(saved.sequenceId); restoredSequenceId = saved.sequenceId; }
        if (typeof saved.campaignId === "string") setCampaignId(saved.campaignId);
        if (typeof saved.savedFingerprint === "string") setSavedFingerprint(saved.savedFingerprint);
      } catch {
        window.localStorage.removeItem(nextStorageKey);
        setSenderId(defaultSenderId ?? "");
      }
      if (restoredSequenceId) {
        // A draft whose sequence is gone must still open; the mailbox restore is best-effort.
        const sequence = await apiFetch<Sequence>(`/v1/sequences/${restoredSequenceId}`, {}, "Could not restore campaign sender mailboxes.").catch(() => null);
        if (sequence && Array.isArray(sequence.mailboxIds) && sequence.mailboxIds.length) {
          const savedMailboxIds = restoreWizardMailboxIds(sequence.mailboxIds);
          setRestoredMailboxIds(savedMailboxIds);
          setSenderId(savedMailboxIds[0] ?? defaultSenderId ?? "");
        }
      }
    }).catch((reason) => setError(apiErrorMessage(reason, "Could not load campaign options."))).finally(() => {
      setRestored(true);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    const refreshPostalAddress = () => {
      void apiFetch<WorkspaceIdentity>("/v1/workspace", {}, "Could not refresh workspace settings.")
        .then((identity) => setPostalAddress(identity.workspace.postalAddress ?? null))
        .catch(() => {});
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshPostalAddress();
    };
    window.addEventListener("focus", refreshPostalAddress);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", refreshPostalAddress);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    if (!restored || !storageKey || !persistWizard || launchResult?.enrolled) return;
    const saved: SavedWizard = { currentStep, listIds, entryMode, name, description, aiDescription, tone, stepCount, steps, selectedStepIndex, senderId, mailboxIds: restoredMailboxIds ?? restoreWizardMailboxIds(undefined, senderId), sequenceId, campaignId, savedFingerprint, sourceStepsFingerprint };
    window.localStorage.setItem(storageKey, JSON.stringify(saved));
  }, [aiDescription, campaignId, currentStep, description, entryMode, launchResult?.enrolled, listIds, name, persistWizard, restored, restoredMailboxIds, savedFingerprint, selectedStepIndex, senderId, sequenceId, sourceStepsFingerprint, stepCount, steps, storageKey, tone]);

  useEffect(() => {
    if (!sequenceId || !savedFingerprint || savedFingerprint !== fingerprint(name, description, steps)) {
      setServerPreview(null);
      return;
    }
    void apiFetch<Preview>(`/v1/sequences/${sequenceId}/preview`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(previewLead ? { contactId: previewLead.id } : {}) }, "Could not refresh the campaign preview.").then((data) => setServerPreview({ ...data, contactId: previewLead?.id ?? null })).catch(() => setServerPreview(null));
  }, [description, name, previewLead?.id, savedFingerprint, sequenceId, steps]);

  useEffect(() => {
    if (selectedStepIndex >= steps.length) setSelectedStepIndex(Math.max(0, steps.length - 1));
  }, [selectedStepIndex, steps.length]);

  const audienceSignature = JSON.stringify([sequenceId, [...listIds].sort()]);
  useEffect(() => {
    if (currentStep !== 2) return;
    const generation = ++audiencePreviewGeneration.current;
    const signature = audienceSignature;
    setAudiencePreview({ signature, status: "loading" });
    void apiFetch<AudiencePreview>("/v1/campaigns/audience-preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...(sequenceId ? { sequenceId } : {}), listIds: [...listIds].sort() }),
    }, "Could not check eligible contacts.")
      .then((data) => {
        if (generation === audiencePreviewGeneration.current) setAudiencePreview({ signature, status: "ready", data });
      })
      .catch((reason) => {
        if (generation === audiencePreviewGeneration.current) setAudiencePreview({ signature, status: "error", error: apiErrorMessage(reason, "Could not check eligible contacts.") });
      });
    return () => {
      if (generation === audiencePreviewGeneration.current) audiencePreviewGeneration.current += 1;
    };
  }, [audiencePreviewRetry, audienceSignature, currentStep, listIds, sequenceId]);

  const selectedInbox = inboxes.find((inbox) => inbox.id === senderId);
  const launchMailboxIds = restoredMailboxIds ?? restoreWizardMailboxIds(undefined, senderId);
  const senderReady = restoredMailboxIds !== null
    ? inboxes.some((inbox) => inbox.status === "active" && inbox.email && (launchMailboxIds.length === 0 || launchMailboxIds.includes(inbox.id)))
    : Boolean(selectedInbox?.email && selectedInbox.status === "active");
  const senderSummary = restoredMailboxIds?.length === 0 ? "All healthy mailboxes" : launchMailboxIds.length > 1 ? `${launchMailboxIds.length} selected mailboxes` : selectedInbox?.email;
  const hasActiveInbox = inboxes.some((inbox) => inbox.status === "active" && inbox.email);
  const audienceName = audienceNames(listIds, lists);
  const currentAudiencePreview = audiencePreview.signature === audienceSignature ? audiencePreview : null;
  const fillMissingValues = fillMissingValuesAccess({ sequenceId, campaignId });
  const previewMissingVariables = currentAudiencePreview?.status === "ready" ? readMissingVariables(currentAudiencePreview.data?.missingVariables) : null;
  const audienceCount = currentAudiencePreview?.status === "ready" ? currentAudiencePreview.data?.eligible ?? 0 : -1;
  const currentFingerprint = fingerprint(name, description, steps);
  const customVariableNames = extractCustomVariableNames(...steps.flatMap((step) => [step.subject, step.body]));
  const previewFromServer = savedFingerprint === currentFingerprint && (serverPreview?.contactId ?? null) === (previewLead?.id ?? null) ? serverPreview?.steps[selectedStepIndex] : undefined;
  const selectedStep = steps[selectedStepIndex] ?? steps[0];
  const validSequence = Boolean(name.trim()) && steps.length > 0 && steps.every((step) => step.subject.trim() && step.body.trim());
  const hasPostalAddress = Boolean(postalAddress?.trim());
  const launchBlocker = currentAudiencePreview?.status === "error"
    ? "Could not check eligible contacts — try again"
    : currentAudiencePreview?.status !== "ready"
      ? "Checking eligible contacts…"
      : getLaunchBlocker(audienceCount, senderReady, validSequence);
  const canContinue = currentStep === 0 ? true : currentStep === 1 ? validSequence : !launchBlocker;
  const launchSkippedRows = skippedRows(launchResult?.skipped);
  const totalSkipped = launchSkippedRows.reduce((total, item) => total + item.count, 0);

  const startOver = () => {
    if (storageKey) window.localStorage.removeItem(storageKey);
    const nextSteps = [newCampaignStep()];
    setPersistWizard(true);
    setMissingBlocker(null);
    setCurrentStep(0);
    setListIds([]);
    setEntryMode("template");
    setName("");
    setDescription("");
    setAiDescription("");
    setTone("direct");
    setStepCount(4);
    setSteps(nextSteps);
    setSourceStepsFingerprint(wizardStepsFingerprint(nextSteps));
    setSelectedStepIndex(0);
    setSenderId(inboxes.find((inbox) => inbox.status === "active" && inbox.email)?.id ?? "");
    setRestoredMailboxIds(null);
    setSequenceId("");
    setCampaignId("");
    setSavedFingerprint("");
    setServerPreview(null);
    setError("");
    setNotice("");
    setLaunchResult(null);
    setLaunchedSequenceId("");
  };

  const confirmStepReplacement = () => !hasEditedWizardSteps(steps, sourceStepsFingerprint) || window.confirm("Replace your edited steps?");

  const selectTemplate = (template: Template) => {
    if (!confirmStepReplacement()) return;
    const nextSteps = localizeWizardSteps(template.steps);
    setEntryMode("template");
    setName(template.name);
    setDescription(template.description);
    setSteps(nextSteps);
    setSourceStepsFingerprint(wizardStepsFingerprint(nextSteps));
    setSelectedStepIndex(0);
    setError("");
    setNotice("Template applied.");
  };

  const startScratch = () => {
    if (!confirmStepReplacement()) return;
    const nextSteps = [newCampaignStep()];
    setEntryMode("scratch");
    if (!name.trim()) setName("New outbound campaign");
    setDescription("");
    setSteps(nextSteps);
    setSourceStepsFingerprint(wizardStepsFingerprint(nextSteps));
    setSelectedStepIndex(0);
    setError("");
    setNotice("");
  };

  const generateDraft = async () => {
    if (aiDescription.trim().length < 10) {
      setError("Describe the audience, offer, and desired outcome in at least 10 characters.");
      setNotice("");
      return;
    }
    if (!confirmStepReplacement()) return;
    const request = buildWizardDraftRequest(aiDescription, tone, stepCount);
    setBusy("ai");
    setError("");
    setNotice("");
    try {
      const draft = await apiFetch<DraftResponse>("/v1/sequences/draft", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) }, "AI could not draft this campaign.");
      if (draft.steps.length !== request.stepCount) throw new Error(`AI returned ${draft.steps.length} steps instead of ${request.stepCount}.`);
      const nextSteps = localizeWizardSteps(draft.steps);
      setEntryMode("ai");
      setName(draft.name);
      setDescription(request.description);
      setSteps(nextSteps);
      setSourceStepsFingerprint(wizardStepsFingerprint(nextSteps));
      setSelectedStepIndex(0);
      setNotice("Draft ready.");
    } catch (reason) {
      setError(apiErrorMessage(reason, "AI could not draft this campaign."));
    } finally {
      setBusy("");
    }
  };

  const saveDraft = async () => {
    if (!validSequence) throw new Error("Add a campaign name plus a subject and body for every step.");
    const isNewCampaign = !sequenceId;
    const payload = { name: name.trim(), description: description.trim(), steps: steps.map(({ delayDays, subject, body }) => ({ delayDays: Math.max(0, Number(delayDays) || 0), subject: subject.trim(), body: body.trim() })) };
    const data = await apiFetch<SequenceResponse>(sequenceId ? `/v1/sequences/${sequenceId}` : "/v1/sequences", { method: sequenceId ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }, "Could not save this campaign draft.");
    setSequenceId(data.sequence.id);
    setSteps(data.sequence.steps);
    setSavedFingerprint(fingerprint(data.sequence.name, data.sequence.description ?? "", data.sequence.steps));
    if (isNewCampaign) {
      track("campaign_created");
      setNotice("Campaign created.");
      setPersistWizard(false);
      if (storageKey) window.localStorage.removeItem(storageKey);
    }
    return data.sequence.id;
  };

  const launch = async () => {
    if (launchBlocker) {
      setNotice("");
      setError(launchBlocker);
      return;
    }
    setBusy("launch");
    setError("");
    setMissingBlocker(null);
    setNotice("");
    setLaunchResult(null);
    try {
      const savedSequenceId = await saveDraft();
      let nextCampaignId = campaignId;
      const campaignSenderId = inboxes.find((inbox) => inbox.status === "active" && inbox.email && (launchMailboxIds.length === 0 || launchMailboxIds.includes(inbox.id)))?.id;
      const campaignSettings = { name: name.trim(), sequenceId: savedSequenceId, listIds, inboxId: campaignSenderId };
      if (!nextCampaignId) {
        const created = await apiFetch<{ campaign: { id: string } }>("/v1/campaigns", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(campaignSettings) }, "Could not create this campaign.");
        nextCampaignId = created.campaign.id;
        setCampaignId(nextCampaignId);
      } else await apiFetch(`/v1/campaigns/${nextCampaignId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(campaignSettings) }, "Could not update this campaign.");
      await apiFetch(`/v1/sequences/${savedSequenceId}/mailboxes`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(buildWizardLaunchRequest(launchMailboxIds)) }, "Could not save campaign sender mailboxes.");
      const response = await apiFetch<CampaignLaunchResponse>(`/v1/campaigns/${nextCampaignId}/launch`, { method: "POST" }, "Could not launch this campaign.");
      const result = "enrollment" in response ? response.enrollment : response;
      setLaunchResult(result);
      track("campaign_launched", { step_count: steps.length, contact_count: result.enrolled });
      if (result.enrolled === 0) return;
      nudgeIfUnpaid("campaign");
      setLaunchedSequenceId(savedSequenceId);
      setPersistWizard(false);
      if (storageKey) window.localStorage.removeItem(storageKey);
    } catch (reason) {
      setNotice("");
      const missing = missingVariablesFromError(reason);
      if (isEmailUnverifiedError(reason)) setVerificationOpen(true);
      else if (missing) setMissingBlocker(missing);
      else setError(apiErrorMessage(reason, "Could not launch this campaign."));
    } finally {
      setBusy("");
    }
  };

  const connectInbox = async (provider: MailboxProvider) => {
    if (provider === "smtp") {
      router.push("/app/inboxes");
      return;
    }
    setBusy(`connect-${provider}`);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch<{ connectUrl: string }>("/v1/inboxes/connect-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider }),
      }, "Could not start the mailbox connection.");
      track("mailbox_connect_started");
      window.location.assign(data.connectUrl);
    } catch (reason) {
      track("mailbox_connect_failed");
      setError(apiErrorMessage(reason, "Could not start the mailbox connection."));
      setBusy("");
    }
  };

  const advance = async () => {
    if (currentStep === 0) {
      setCurrentStep(1);
      return;
    }
    if (currentStep === 1) {
      setBusy("save");
      setError("");
      try {
        await saveDraft();
        setCurrentStep(2);
      } catch (reason) {
        setNotice("");
        setError(apiErrorMessage(reason, "Could not save this draft."));
      } finally {
        setBusy("");
      }
      return;
    }
    await launch();
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        if (canContinue && !busy && !launchResult) void advance();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  return <div className="page-stack campaign-wizard-page">
    <EmailVerificationModal open={verificationOpen} onClose={() => setVerificationOpen(false)} />
    <PageHeader title="New campaign" description="Audience, message, sender." />
    <div className="campaign-wizard-progress" aria-label="Campaign setup progress">
      {["Audience", "Message", "Sender"].map((label, index) => <button aria-current={currentStep === index ? "step" : undefined} className={index < currentStep ? "is-complete" : ""} key={label} onClick={() => index <= currentStep && setCurrentStep(index)} type="button"><span aria-hidden="true">{index < currentStep ? "✓" : index + 1}</span>{label}</button>)}
    </div>
    {error ? <Toast tone="error" message={error} onDismiss={() => setError("")} /> : null}
    {notice ? <Toast tone="success" message={notice} onDismiss={() => setNotice("")} /> : null}
    {missingBlocker && !launchResult ? <MissingVariablesBlocker summary={missingBlocker} onReview={fillMissingValues.canFill ? () => setVariablesOpen(true) : undefined} reviewHint={fillMissingValues.hint} /> : null}
    {variablesOpen && fillMissingValues.canFill ? <LeadVariablesDialog sequenceId={sequenceId} initialView={{ filter: "missing" }} onClose={() => setVariablesOpen(false)} onChanged={() => setAudiencePreviewRetry((retry) => retry + 1)} /> : null}

    {launchResult?.enrolled === 0 ? <Card className="campaign-launch-result campaign-launch-result--error">
      <div><strong>No emails were scheduled</strong><p role="alert">No eligible leads were found for this audience, so scheduling did not continue.</p></div>
      {launchSkippedRows.length ? <ul>{launchSkippedRows.map((item) => <li key={item.reason}><strong>{item.count}</strong> {item.label}</li>)}</ul> : <p>The selected audience does not contain any leads that are ready to contact.</p>}
      <p>Add new leads or return to the Audience step and choose a list with eligible contacts. Suppressed, unsubscribed, replied, bounced, and already-enrolled leads are intentionally excluded.</p>
      <div className="campaign-launch-result-actions"><a className="ij-button ij-button--primary" href="/app/leads">Add eligible leads</a><Button variant="secondary" onClick={() => { setCurrentStep(0); setLaunchResult(null); }}>Review audience</Button></div>
    </Card> : null}
    {launchResult && launchResult.enrolled > 0 ? <Card className="campaign-launch-result campaign-launch-result--success">
      <div><strong>Campaign launched</strong><p role="status">{launchResult.enrolled} {launchResult.enrolled === 1 ? "lead was" : "leads were"} enrolled and scheduled.</p></div>
      <p>{totalSkipped ? `${totalSkipped} ${totalSkipped === 1 ? "lead was" : "leads were"} skipped by the safety checks.` : "No leads were skipped."}</p>
      {launchSkippedRows.length ? <ul>{launchSkippedRows.map((item) => <li key={item.reason}><strong>{item.count}</strong> {item.label}</li>)}</ul> : null}
      <Button onClick={() => router.push(`/app/sequences/${launchedSequenceId}`)}>View campaign</Button>
    </Card> : null}
    {loading ? <Card className="campaign-loading"><p>Loading lists, templates, and sender mailboxes…</p></Card> : null}

    {!loading && currentStep === 0 ? <Card className="campaign-wizard-card">
      <div className="card-header"><div><h2>Who should receive this campaign?</h2><p>Choose a saved list or include every lead currently ready to contact.</p></div></div>
      <AudiencePicker lists={lists} listIds={listIds} onChange={setListIds} readyCount={readyCount} legend="Choose an audience" />
      <p className="campaign-eligible-note">Eligibility is checked again at launch. Suppressed, replied, bounced, or already-enrolled contacts are skipped automatically.</p>
    </Card> : null}

    {!loading && currentStep === 1 ? <div className="campaign-wizard-compose">
      <div className="campaign-wizard-main">
        <Card className="campaign-wizard-card">
          <div className="card-header"><div><h2>How do you want to start?</h2><p>Pick a proven template, ask AI for a draft, or build the sequence yourself.</p></div></div>
          <div className="campaign-entry-modes">
            {([[
              "template",
              "Template gallery",
              "Start from a proven sequence.",
              <svg aria-hidden="true" fill="none" viewBox="0 0 24 24"><path d="M4 5.5h6v5H4zM14 5.5h6v5h-6zM4 14h6v4.5H4zM14 14h6v4.5h-6z" stroke="currentColor" strokeWidth="1.7" /></svg>,
            ], [
              "ai",
              "AI drafts it",
              "Describe the audience and offer.",
              <svg aria-hidden="true" fill="none" viewBox="0 0 24 24"><path d="m12 3 1.25 4.15L17.5 8.5l-4.25 1.35L12 14l-1.25-4.15L6.5 8.5l4.25-1.35L12 3Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.7" /><path d="m18.5 14 .65 2.1 2.1.65-2.1.65-.65 2.1-.65-2.1-2.1-.65 2.1-.65.65-2.1Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.5" /></svg>,
            ], [
              "scratch",
              "Start from scratch",
              "Write every message yourself.",
              <svg aria-hidden="true" fill="none" viewBox="0 0 24 24"><path d="m5 19 3.6-.8L19 7.8 16.2 5 5.8 15.4 5 19Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.7" /><path d="m14.8 6.4 2.8 2.8M5.8 15.4l2.8 2.8" stroke="currentColor" strokeWidth="1.7" /></svg>,
            ]] as const).map(([mode, label, helper, icon]) => <button className={entryMode === mode ? "is-selected" : ""} disabled={busy === "ai"} key={mode} onClick={() => mode === "scratch" ? startScratch() : setEntryMode(mode)} type="button"><span className="campaign-entry-icon">{icon}</span><strong>{label}</strong><span>{helper}</span><span className="campaign-choice-dot" aria-hidden="true" /></button>)}
          </div>
          {entryMode === "template" ? <div className="campaign-template-grid">{templates.map((template) => <button className={name === template.name && description === template.description ? "is-selected" : ""} key={template.key} onClick={() => selectTemplate(template)} type="button"><span className="campaign-template-count">{template.steps.length} steps</span><strong>{template.name}</strong><p>{template.description}</p></button>)}</div> : null}
          {entryMode === "ai" ? <div className="campaign-ai-panel"><label>Describe this campaign<textarea disabled={busy === "ai"} value={aiDescription} onChange={(event) => setAiDescription(event.target.value)} placeholder="Reach operations leaders at Series B SaaS companies about reducing manual lead routing and ask for a 15-minute call." rows={5} /></label><div className="campaign-ai-controls"><div><span>Tone</span><div className="segmented-control"><button aria-pressed={tone === "direct"} disabled={busy === "ai"} onClick={() => setTone("direct")} type="button">Direct</button><button aria-pressed={tone === "friendly"} disabled={busy === "ai"} onClick={() => setTone("friendly")} type="button">Friendly</button></div></div><label>Steps<input disabled={busy === "ai"} max="8" min="2" type="number" value={stepCount} onChange={(event) => setStepCount(Math.max(2, Math.min(8, Number(event.target.value) || 2)))} /></label><Button variant="secondary" disabled={busy === "ai"} onClick={() => void generateDraft()}>{busy === "ai" ? "Drafting…" : "Generate draft"}</Button></div></div> : null}
        </Card>
        <Card className="campaign-wizard-card campaign-name-card"><div className="campaign-field-grid"><label>Campaign name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Q4 founder outreach" /></label><label>Internal description<textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Who this campaign is for and what it should achieve." rows={3} /></label></div></Card>
        <CampaignTimeline steps={steps} onChange={setSteps} selectedStepIndex={selectedStepIndex} onSelectStep={setSelectedStepIndex} />
      </div>
      <aside className="campaign-live-preview"><Card><div className="card-header"><div><h2>Email {selectedStepIndex + 1}</h2><p>{previewFromServer ? (previewLead ? "Rendered for the selected lead." : "Rendered from the saved draft.") : "Rendered with sample contact data."}</p></div></div><PreviewAsLead sequenceId={sequenceId || undefined} value={previewLead} onChange={setPreviewLead} />{previewLead && !previewFromServer ? <p className="campaign-muted" role="status">Your latest edits are not saved yet. The lead preview refreshes once the draft saves.</p> : null}{selectedStep ? <article><div className="campaign-preview-meta"><span>To</span><strong className={previewLead ? "ph-mask" : undefined}>{previewLead && previewFromServer ? previewLead.label : "Ada Lovelace · ada@example.com"}</strong></div><div className="campaign-preview-meta"><span>Subject</span><strong><PreviewText names={customVariableNames} text={previewFromServer?.subject ?? (renderSamplePreview(selectedStep.subject) || "Your subject appears here")} /></strong></div><pre className={previewLead ? "ph-mask" : undefined}><PreviewText names={customVariableNames} text={previewFromServer?.body ?? (renderSamplePreview(selectedStep.body) || "Your email body appears here.")} /></pre></article> : <p className="campaign-muted">Add an email step to preview it.</p>}<div className="campaign-preview-step-list">{steps.map((step, index) => <button aria-label={`Preview email ${index + 1}`} title={`Preview email ${index + 1}`} className={selectedStepIndex === index ? "is-selected" : ""} key={step.id} onClick={() => setSelectedStepIndex(index)} type="button">{index + 1}</button>)}</div></Card></aside>
    </div> : null}

    {!loading && currentStep === 2 ? <div className="campaign-wizard-review-grid">
      <Card className="campaign-wizard-card"><div className="card-header"><div><h2>Choose the sender mailbox</h2><p>Your mailbox choice is saved when you launch.</p></div></div>{inboxes.length ? <div className="campaign-choice-list ph-mask" role="group" aria-label="Sender mailbox">{inboxes.map((inbox) => { const unavailable = inbox.status !== "active" || !inbox.email; const selected = restoredMailboxIds !== null ? restoredMailboxIds.includes(inbox.id) : senderId === inbox.id; return <button aria-pressed={selected} className={selected ? "is-selected" : ""} disabled={Boolean(busy) || unavailable} key={inbox.id} onClick={() => { setSenderId(inbox.id); setRestoredMailboxIds(null); }} type="button"><span className="ph-mask"><strong>{inbox.displayName || inbox.email || "Address pending — reconnect"}</strong><small>{inbox.email ?? "Address pending — reconnect"} · {inbox.provider ? mailboxProviderLabels[inbox.provider] : "email"}</small></span><span className="campaign-inbox-badges"><StatusBadge tone="neutral">{Math.round(inbox.warmupPercent ?? 0)}% warm</StatusBadge>{unavailable ? <StatusBadge tone="warning">{inbox.email ? labelStatus(inbox.status) : "Address Pending"}</StatusBadge> : null}</span><span className="campaign-choice-dot" aria-hidden="true" /></button>; })}</div> : null}{!hasActiveInbox ? <div className="campaign-sender-connect-actions"><button className="ij-button ij-button--secondary" disabled={busy.startsWith("connect-")} onClick={() => void connectInbox("gmail")} type="button"><img alt="" height="14" src="/brand/gmail.svg" width="18" />{busy === "connect-gmail" ? "Connecting…" : "Connect Gmail"}</button><button className="ij-button ij-button--secondary" disabled={busy.startsWith("connect-")} onClick={() => void connectInbox("outlook")} type="button"><img alt="" height="17" src="/brand/outlook.svg" width="17" />{busy === "connect-outlook" ? "Connecting…" : "Connect Outlook"}</button>{smtpEnabled ? <button className="ij-button ij-button--secondary" disabled={busy.startsWith("connect-")} onClick={() => void connectInbox("smtp")} type="button"><Mail aria-hidden="true" size={18} />SMTP/IMAP</button> : null}</div> : null}</Card>
      <Card className="campaign-review-card"><div className="card-header"><div><h2>Review</h2></div></div><dl><div><dt>Audience</dt><dd>{audienceName}</dd></div><div className={currentAudiencePreview?.status === "ready" && audienceCount <= 0 ? "is-attention" : undefined}><dt>Eligible now</dt><dd>{currentAudiencePreview?.status === "ready" ? audienceCount.toLocaleString() + " of " + (currentAudiencePreview.data?.total ?? 0).toLocaleString() + " contacts" : currentAudiencePreview?.status === "error" ? <span role="alert">{currentAudiencePreview.error} <button className="ij-button ij-button--ghost" onClick={() => setAudiencePreviewRetry((retry) => retry + 1)} type="button">Retry</button></span> : "Checking…"}</dd></div>{currentAudiencePreview?.status === "ready" && Object.values(currentAudiencePreview.data?.skipped ?? {}).some(Boolean) ? <div><dt>Excluded</dt><dd>{Object.entries(currentAudiencePreview.data?.skipped ?? {}).filter(([, count]) => count).map(([reason, count]) => count + " " + skipLabels[reason as SkipReason]).join(" · ")}</dd></div> : null}<div><dt>Sequence</dt><dd>{steps.length} steps</dd></div><div className={!senderReady ? "is-attention" : undefined}><dt>Sender</dt><dd className="ph-mask">{senderReady ? senderSummary : "Choose a mailbox"}</dd></div><div><dt>First send</dt><dd>Today, after launch and safety checks</dd></div></dl>{previewMissingVariables ? <MissingVariablesWarning summary={previewMissingVariables} onReview={fillMissingValues.canFill ? () => setVariablesOpen(true) : undefined} reviewHint={fillMissingValues.hint} /> : null}</Card>
    </div> : null}

    {!loading && currentStep === 2 && !hasPostalAddress ? <p className="campaign-sender-address-note">Optional: include a postal address in every email footer. <a href="/app/settings/workspace" target="_blank" rel="noopener noreferrer">Add sender address</a></p> : null}

    {!loading && !launchResult ? <div className="campaign-wizard-footer"><div className="campaign-wizard-footer-left"><Button variant="ghost" onClick={startOver}>Start over</Button><a className="ij-button ij-button--ghost" href="/app/sequences">Save and exit</a></div><span>⌘⏎ to continue</span><div className="campaign-wizard-footer-right"><Button variant="ghost" onClick={() => currentStep === 0 ? router.push("/app/sequences") : setCurrentStep((step) => step - 1)}>Back</Button><button className="ij-button ij-button--primary" disabled={!canContinue || Boolean(busy)} onClick={() => void advance()} title={currentStep === 2 && launchBlocker ? launchBlocker : undefined} type="button">{busy === "save" ? "Saving draft…" : busy === "launch" ? "Launching…" : currentStep === 2 ? "Launch campaign" : "Continue"}</button></div></div> : null}
  </div>;
}
