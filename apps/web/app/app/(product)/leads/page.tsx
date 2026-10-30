"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Card, EmptyState, labelStatus, PageHeader, StatusBadge } from "@inboxjoy/ui";
import { apiErrorMessage, apiFetch, isEmailUnverifiedError } from "@/lib/api";
import { EmailVerificationModal } from "@/components/email-verification";
import { usePlanPicker } from "@/components/plan-picker";
import { AddLeadsModal } from "./add-leads-modal";
import { campaignLeadFeedback, type CampaignUpdate } from "./campaign-feedback";

type Lead = { id: string; email: string; firstName: string; lastName: string; company: string; title: string; status: string; source: string; lastTouchAt: string | null };
type LeadDetail = Lead & { listName: string; importedAt: string; lists: Array<{ id: string; name: string }>; enrollments: Array<{ id: string; sequenceId: string; sequenceName: string | null; status: string; startedAt: string | null; stoppedAt: string | null }> };
type ContactList = { id: string; name: string; count: number; leadCount: number; repliedCount: number; bouncedCount: number };
type SequenceOption = { id: string; name: string; status: string };
type Pagination = { page: number; pageSize: number; total: number };

const PAGE_SIZE = 50;
const STATUS_FILTERS = [
  ["", "All"],
  ["active", "Ready"],
  ["enrolled", "Enrolled"],
  ["replied", "Replied"],
  ["bounced", "Bounced"],
  ["suppressed", "Suppressed"],
] as const;

function leadTone(status: string): "neutral" | "good" | "danger" | "info" {
  const normalized = status.toLowerCase();
  if (normalized === "suppressed" || normalized === "bounced") return "danger";
  if (normalized === "replied") return "good";
  if (normalized === "enrolled") return "info";
  return "neutral";
}

function initials(lead: Lead) {
  const parts = [lead.firstName, lead.lastName].filter(Boolean);
  if (parts.length) return parts.map((part) => part[0]!.toUpperCase()).join("").slice(0, 2);
  return lead.email.slice(0, 2).toUpperCase();
}

function formatLastTouch(value: string | null) {
  if (!value) return "—";
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "—";
  const minutes = Math.max(1, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(value).toLocaleDateString();
}

export default function LeadsPage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [lists, setLists] = useState<ContactList[]>([]);
  const [allLeadCount, setAllLeadCount] = useState(0);
  const [activeListId, setActiveListId] = useState("");
  const [pagination, setPagination] = useState<Pagination>({ page: 1, pageSize: PAGE_SIZE, total: 0 });
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<LeadDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [sequences, setSequences] = useState<SequenceOption[]>([]);
  const [enrollTarget, setEnrollTarget] = useState("");
  const [listTarget, setListTarget] = useState("");
  const [creatingList, setCreatingList] = useState(false);
  const [newListName, setNewListName] = useState("");
  const [editingListId, setEditingListId] = useState("");
  const [editingListName, setEditingListName] = useState("");
  const [openListMenuId, setOpenListMenuId] = useState("");
  const [editingLead, setEditingLead] = useState(false);
  const [editLeadForm, setEditLeadForm] = useState({ firstName: "", lastName: "", company: "", title: "" });
  const [editLeadBusy, setEditLeadBusy] = useState(false);
  const [editLeadError, setEditLeadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showAddLeads, setShowAddLeads] = useState(false);
  const [verificationOpen, setVerificationOpen] = useState(false);
  const { nudgeIfUnpaid } = usePlanPicker();
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadGeneration = useRef(0);
  const listMenuRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async (page: number, q: string, status: string, listId: string) => {
    const generation = ++loadGeneration.current;
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (q.trim()) params.set("q", q.trim());
    if (status) params.set("status", status);
    if (listId) params.set("listId", listId);
    try {
      const data = await apiFetch<{ leads: Lead[]; pagination?: Pagination }>(`/v1/leads?${params}`, {}, "Could not load leads.");
      if (generation !== loadGeneration.current) return;
      setLeads(data.leads);
      setPagination(data.pagination ?? { page: 1, pageSize: PAGE_SIZE, total: data.leads.length });
      setSelected(new Set());
    } catch (reason) {
      if (generation === loadGeneration.current) setError(apiErrorMessage(reason, "Could not load leads."));
    }
  }, []);

  const loadLists = useCallback(async () => {
    const data = await apiFetch<{ lists: ContactList[] }>("/v1/lists", {}, "Could not load lists.");
    setLists(data.lists.map((list) => ({ ...list, count: list.count ?? list.leadCount ?? 0, leadCount: list.leadCount ?? list.count ?? 0, repliedCount: list.repliedCount ?? 0, bouncedCount: list.bouncedCount ?? 0 })));
  }, []);

  const loadAllLeadCount = useCallback(async () => {
    const data = await apiFetch<{ leads: Lead[]; pagination?: Pagination }>("/v1/leads?page=1&pageSize=1", {}, "Could not load lead count.");
    setAllLeadCount(data.pagination?.total ?? data.leads.length);
  }, []);

  useEffect(() => {
    void load(1, "", "", "").catch((reason) => setError(apiErrorMessage(reason, "Could not load leads."))).finally(() => setLoading(false));
    void loadLists().catch((reason) => setError(apiErrorMessage(reason, "Could not load lists.")));
    void loadAllLeadCount().catch(() => undefined);
    void apiFetch<{ sequences: SequenceOption[] }>("/v1/sequences", {}, "Could not load campaigns.").then((data) => {
      setSequences(data.sequences.filter((sequence) => sequence.status !== "archived"));
    }).catch(() => undefined);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [load, loadAllLeadCount, loadLists]);

  useEffect(() => {
    if (!openListMenuId) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (listMenuRef.current?.contains(event.target as Node)) return;
      setOpenListMenuId("");
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenListMenuId("");
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [openListMenuId]);

  const search = (value: string) => {
    setQuery(value);
    loadGeneration.current += 1;
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => { void load(1, value, statusFilter, activeListId).catch((reason) => setError(apiErrorMessage(reason, "Could not load leads."))); }, 300);
  };

  const filterBy = (status: string) => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    setStatusFilter(status);
    void load(1, query, status, activeListId).catch((reason) => setError(apiErrorMessage(reason, "Could not load leads.")));
  };

  const filterByList = (listId: string) => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    setActiveListId(listId);
    setOpenListMenuId("");
    void load(1, query, statusFilter, listId).catch((reason) => setError(apiErrorMessage(reason, "Could not load leads.")));
  };

  const goToPage = (page: number) => {
    void load(page, query, statusFilter, activeListId).catch((reason) => setError(apiErrorMessage(reason, "Could not load leads.")));
  };

  const createList = async (name: string) => {
    const trimmedName = name.trim();
    if (!trimmedName) return null;
    setBusy(true); setError(""); setNotice("");
    try {
      const data = await apiFetch<{ list: ContactList }>("/v1/lists", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: trimmedName }) }, "Could not create this list.");
      await loadLists();
      setNotice(`Created ${data.list.name}.`);
      return data.list;
    } catch (reason) {
      setError(apiErrorMessage(reason, "Could not create this list."));
      return null;
    } finally { setBusy(false); }
  };

  const saveNewList = async () => {
    const list = await createList(newListName);
    if (!list) return;
    setNewListName("");
    setCreatingList(false);
    filterByList(list.id);
  };

  const saveRename = async (list: ContactList) => {
    const name = editingListName.trim();
    if (!name) return;
    if (name === list.name) { setEditingListId(""); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      await apiFetch(`/v1/lists/${list.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }, "Could not rename this list.");
      setEditingListId("");
      await loadLists();
      setNotice(`Renamed list to ${name}.`);
    } catch (reason) { setError(apiErrorMessage(reason, "Could not rename this list.")); } finally { setBusy(false); }
  };

  const deleteList = async (list: ContactList) => {
    if (!window.confirm(`Delete “${list.name}”? The ${list.leadCount} leads in it will stay in your workspace.`)) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await apiFetch(`/v1/lists/${list.id}`, { method: "DELETE" }, "Could not delete this list.");
      setOpenListMenuId("");
      if (activeListId === list.id) {
        setActiveListId("");
        await load(1, query, statusFilter, "");
      }
      await loadLists();
      setNotice(`Deleted ${list.name}. Its leads were kept.`);
    } catch (reason) { setError(apiErrorMessage(reason, "Could not delete this list.")); } finally { setBusy(false); }
  };

  const enrollList = async (list: ContactList, sequenceId: string) => {
    if (!sequenceId) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await apiFetch<{ enrolled?: number }>(`/v1/sequences/${sequenceId}/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ listId: list.id }) }, "Could not enroll this list.");
      setOpenListMenuId("");
      setNotice(`Enrolled ${result.enrolled ?? 0} leads from ${list.name}.`);
      if (result.enrolled) nudgeIfUnpaid("leads");
      await load(pagination.page, query, statusFilter, activeListId);
    } catch (reason) {
      if (isEmailUnverifiedError(reason)) setVerificationOpen(true);
      else setError(apiErrorMessage(reason, "Could not enroll this list."));
    } finally { setBusy(false); }
  };

  const addSelectedToList = async () => {
    if (!listTarget || !selected.size) return;
    let targetId = listTarget;
    if (targetId === "new") {
      const name = window.prompt("Name this new list:")?.trim();
      if (!name) { setListTarget(""); return; }
      const list = await createList(name);
      if (!list) return;
      targetId = list.id;
    }
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await apiFetch<{ added: number; campaignUpdates?: CampaignUpdate[] }>(`/v1/lists/${targetId}/leads`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ leadIds: [...selected] }) }, "Could not add these leads to the list.");
      setListTarget("");
      setNotice(campaignLeadFeedback(result.added, result.campaignUpdates, `Added ${result.added} lead${result.added === 1 ? "" : "s"} to the list.`));
      await loadLists();
    } catch (reason) { setError(apiErrorMessage(reason, "Could not add these leads to the list.")); } finally { setBusy(false); }
  };

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((current) => current.size === leads.length ? new Set() : new Set(leads.map((lead) => lead.id)));
  };

  const openDetail = async (id: string) => {
    setDetailLoading(true); setEditingLead(false); setEditLeadError(""); setError("");
    try {
      const data = await apiFetch<LeadDetail>(`/v1/leads/${id}`, {}, "Could not load this lead.");
      setDetail(data);
    } catch (reason) { setError(apiErrorMessage(reason, "Could not load this lead.")); } finally { setDetailLoading(false); }
  };

  const startEditingLead = () => {
    if (!detail) return;
    setEditLeadForm({ firstName: detail.firstName, lastName: detail.lastName, company: detail.company, title: detail.title });
    setEditLeadError("");
    setEditingLead(true);
  };

  const saveLead = async () => {
    if (!detail || editLeadBusy) return;
    setEditLeadBusy(true); setEditLeadError("");
    try {
      const data = await apiFetch<{ lead: Lead }>(`/v1/leads/${detail.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ firstName: editLeadForm.firstName, lastName: editLeadForm.lastName, company: editLeadForm.company, title: editLeadForm.title }) }, "Could not update this lead.");
      setDetail((current) => current ? { ...current, ...data.lead } : current);
      setEditingLead(false);
      setNotice(`Updated ${data.lead.email}.`);
      await load(pagination.page, query, statusFilter, activeListId);
    } catch (reason) {
      setEditLeadError(apiErrorMessage(reason, "Could not update this lead."));
    } finally { setEditLeadBusy(false); }
  };

  const refreshAfterLeadChange = async (message: string) => {
    setError("");
    const refreshes = await Promise.allSettled([load(1, query, statusFilter, activeListId), loadLists(), loadAllLeadCount()]);
    setNotice(message);
    if (refreshes.some((refresh) => refresh.status === "rejected")) setError("The lead change was saved, but some counts could not be refreshed. Reload the page to update them.");
  };

  const bulkEnroll = async () => {
    if (!enrollTarget || !selected.size) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await apiFetch<{ enrolled?: number }>(`/v1/sequences/${enrollTarget}/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ leadIds: [...selected] }) }, "Could not enroll these leads.");
      setNotice(`Enrolled ${result.enrolled ?? selected.size} leads.`);
      if (result.enrolled ?? selected.size) nudgeIfUnpaid("leads");
      await load(pagination.page, query, statusFilter, activeListId);
    } catch (reason) {
      if (isEmailUnverifiedError(reason)) setVerificationOpen(true);
      else setError(apiErrorMessage(reason, "Could not enroll these leads."));
    } finally { setBusy(false); }
  };

  const bulkSuppress = async () => {
    if (!selected.size) return;
    if (!window.confirm(`Suppress ${selected.size} leads? They will never be emailed again until removed from the suppression list.`)) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const emails = leads.filter((lead) => selected.has(lead.id)).map((lead) => lead.email);
      for (const email of emails) {
        await apiFetch("/v1/suppressions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, reason: "Bulk suppression from leads page" }) }, "Could not suppress a lead.");
      }
      setNotice(`Suppressed ${emails.length} leads.`);
      await Promise.all([load(pagination.page, query, statusFilter, activeListId), loadLists()]);
    } catch (reason) { setError(apiErrorMessage(reason, "Could not suppress these leads.")); } finally { setBusy(false); }
  };

  const bulkDelete = async () => {
    if (!selected.size) return;
    if (!window.confirm(`Delete ${selected.size} leads? Leads with campaign history are kept.`)) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await apiFetch<{ deleted: number; skipped: number }>("/v1/leads/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [...selected] }) }, "Could not delete these leads.");
      setNotice(`Deleted ${result.deleted} leads${result.skipped ? `, kept ${result.skipped} with campaign history` : ""}.`);
      await Promise.all([load(pagination.page, query, statusFilter, activeListId), loadLists(), loadAllLeadCount()]);
    } catch (reason) { setError(apiErrorMessage(reason, "Could not delete these leads.")); } finally { setBusy(false); }
  };

  const activeList = lists.find((list) => list.id === activeListId);
  const totalPages = Math.max(1, Math.ceil(pagination.total / pagination.pageSize));
  const hasFilters = Boolean(query || statusFilter || activeListId);

  return <div className="page-stack leads-page dashboard-polish-page">
    <EmailVerificationModal open={verificationOpen} onClose={() => setVerificationOpen(false)} />
    <PageHeader eyebrow="Contacts" title="Leads" description="Add, import, review, deduplicate, and enroll leads." action={<Button onClick={() => setShowAddLeads(true)}>Add leads</Button>} />
    {error ? <Card className="page-message page-message--error"><p role="alert">{error}</p></Card> : null}
    {notice ? <Card className="page-message page-message--success"><p role="status">{notice}</p></Card> : null}

    {loading ? <Card className="campaign-loading"><p>Loading leads…</p></Card> : <div className="leads-workspace">
      <Card className="leads-list-rail">
        <div className="leads-list-rail-head"><strong>Lists</strong></div>
        <div className="leads-list-items">
          <button className={activeListId ? "leads-list-row" : "leads-list-row is-active"} type="button" onClick={() => filterByList("")}>
            <span>All leads</span><small>{allLeadCount}</small>
          </button>
          {lists.map((list) => <div className={activeListId === list.id ? "leads-list-row is-active" : "leads-list-row"} key={list.id}>
            {editingListId === list.id ? <input autoFocus aria-label={`Rename ${list.name}`} maxLength={80} value={editingListName} onBlur={() => { if (editingListName.trim()) void saveRename(list); else setEditingListId(""); }} onChange={(event) => setEditingListName(event.target.value)} onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); void saveRename(list); }
              if (event.key === "Escape") setEditingListId("");
            }} /> : <button className="leads-list-main" type="button" onClick={() => filterByList(list.id)}><span>{list.name}</span><small>{list.leadCount}</small></button>}
            <div className="leads-list-actions" ref={openListMenuId === list.id ? listMenuRef : undefined}>
              <button aria-expanded={openListMenuId === list.id} aria-haspopup="menu" aria-label={`Actions for ${list.name}`} title={`Actions for ${list.name}`} type="button" onClick={() => setOpenListMenuId((current) => current === list.id ? "" : list.id)}>⋯</button>
              {openListMenuId === list.id ? <div className="leads-list-menu" role="menu">
                <button role="menuitem" type="button" onClick={() => { setEditingListId(list.id); setEditingListName(list.name); setOpenListMenuId(""); }}>Rename</button>
                <label><span>Enroll list in campaign…</span><select aria-label={`Enroll ${list.name} in campaign`} defaultValue="" disabled={busy} onChange={(event) => void enrollList(list, event.target.value)}><option value="" disabled>Select campaign</option>{sequences.map((sequence) => <option key={sequence.id} value={sequence.id}>{sequence.name}</option>)}</select></label>
                <button className="is-danger" role="menuitem" type="button" onClick={() => void deleteList(list)}>Delete</button>
              </div> : null}
            </div>
          </div>)}
        </div>
        <div className="leads-list-rail-foot">
          {creatingList ? <input autoFocus aria-label="New list name" maxLength={80} placeholder="List name" value={newListName} onChange={(event) => setNewListName(event.target.value)} onBlur={() => { if (!newListName.trim()) setCreatingList(false); }} onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); void saveNewList(); }
            if (event.key === "Escape") { setCreatingList(false); setNewListName(""); }
          }} /> : <button type="button" onClick={() => setCreatingList(true)}>+ New list</button>}
        </div>
      </Card>

      <Card className="polish-table-card leads-workspace-card">
        <div className="leads-active-list">
          <h2>{activeList?.name ?? "All leads"}</h2>
          <p>{activeList ? `${activeList.leadCount} leads · ${activeList.repliedCount} replied · ${activeList.bouncedCount} bounced` : `${allLeadCount} leads across your workspace`}</p>
        </div>
        <div className="leads-toolbar">
          <input aria-label="Search leads" className="leads-search" placeholder="Search leads…" value={query} onChange={(event) => search(event.target.value)} />
          <div className="leads-filters" role="group" aria-label="Filter by status">
            {STATUS_FILTERS.map(([value, label]) => <button className={statusFilter === value ? "leads-filter is-active" : "leads-filter"} key={value || "all"} type="button" onClick={() => filterBy(value)}>{label}</button>)}
          </div>
        </div>

        {selected.size ? <div className="leads-bulk-bar" role="toolbar" aria-label="Bulk actions">
          <span>{selected.size} selected</span>
          <select aria-label="List to add leads to" value={listTarget} onChange={(event) => setListTarget(event.target.value)}>
            <option value="">Add to list…</option>
            {lists.map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}
            <option value="new">New list…</option>
          </select>
          <Button variant="secondary" disabled={busy || !listTarget} onClick={() => void addSelectedToList()}>Add</Button>
          <select aria-label="Campaign to enroll into" value={enrollTarget} onChange={(event) => setEnrollTarget(event.target.value)}>
            <option value="">Enroll in campaign…</option>
            {sequences.map((sequence) => <option key={sequence.id} value={sequence.id}>{sequence.name}</option>)}
          </select>
          <Button disabled={busy || !enrollTarget} onClick={() => void bulkEnroll()}>Enroll</Button>
          <Button variant="secondary" disabled={busy} onClick={() => void bulkSuppress()}>Suppress</Button>
          <Button variant="ghost" disabled={busy} onClick={() => void bulkDelete()}>Delete</Button>
        </div> : null}

        {leads.length ? <>
          <div className="table-like leads-table" role="table" aria-label="Leads">
            <div className="table-row table-head" role="row">
              <span><input aria-label="Select all leads on this page" checked={selected.size === leads.length && leads.length > 0} type="checkbox" onChange={toggleAll} /></span>
              <span>Lead</span><span>Company</span><span>Source</span><span>Status</span><span>Last touch</span>
            </div>
            {leads.map((lead) => <div className={selected.has(lead.id) ? "table-row is-selected" : "table-row"} key={lead.id} role="row">
              <span><input aria-label="Select this lead" checked={selected.has(lead.id)} type="checkbox" onChange={() => toggle(lead.id)} /></span>
              <span className="leads-identity">
                <i aria-hidden="true" className="leads-avatar">{initials(lead)}</i>
                <button className="leads-name" type="button" onClick={() => void openDetail(lead.id)}>
                  <strong>{[lead.firstName, lead.lastName].filter(Boolean).join(" ") || lead.email}</strong>
                  <small>{lead.email}</small>
                </button>
              </span>
              <span data-label="Company">{lead.company || "—"}{lead.title ? <small>{lead.title}</small> : null}</span>
              <span data-label="Source">{lead.source || "—"}</span>
              <span data-label="Status"><StatusBadge tone={leadTone(lead.status)}>{labelStatus(lead.status)}</StatusBadge></span>
              <span data-label="Last touch">{formatLastTouch(lead.lastTouchAt)}</span>
            </div>)}
          </div>
          <div className="leads-pagination">
            <span>{pagination.total} leads · page {pagination.page} of {totalPages}</span>
            <div>
              <Button variant="ghost" disabled={pagination.page <= 1} onClick={() => goToPage(pagination.page - 1)}>Previous</Button>
              <Button variant="ghost" disabled={pagination.page >= totalPages} onClick={() => goToPage(pagination.page + 1)}>Next</Button>
            </div>
          </div>
        </> : <EmptyState title={hasFilters ? "No leads match" : "No leads yet"} description={hasFilters ? "Try a different list, search, or status filter." : "Add a lead individually, upload a CSV, or connect an AI agent in Settings → MCP."} action={hasFilters ? undefined : <Button onClick={() => setShowAddLeads(true)}>Add your first leads</Button>} />}
      </Card>
    </div>}

    {detail || detailLoading ? <>
      <button aria-label="Close lead details" className="leads-drawer-backdrop" title="Close lead details" type="button" onClick={() => setDetail(null)} />
      <aside aria-label="Lead details" className="leads-drawer ph-mask" role="dialog">
        {detailLoading ? <p className="leads-drawer-loading">Loading…</p> : detail ? <>
          <header>
            <i aria-hidden="true" className="leads-avatar leads-avatar--lg">{initials(detail)}</i>
            <div>
              <h2>{[detail.firstName, detail.lastName].filter(Boolean).join(" ") || detail.email}</h2>
              <p>{detail.email}</p>
            </div>
            <div className="leads-drawer-actions">
              {!editingLead ? <button type="button" onClick={startEditingLead}>Edit</button> : null}
              <button aria-label="Close lead details" title="Close lead details" type="button" onClick={() => setDetail(null)}>✕</button>
            </div>
          </header>
          {editingLead ? <form className="leads-drawer-edit" onSubmit={(event) => { event.preventDefault(); void saveLead(); }}>
            <label className="leads-field leads-field--wide"><span>Email</span><input aria-describedby="lead-email-help" readOnly value={detail.email} /></label>
            <small id="lead-email-help">Email is the lead identity and cannot be changed.</small>
            <label className="leads-field"><span>First name</span><input autoFocus value={editLeadForm.firstName} onChange={(event) => setEditLeadForm((current) => ({ ...current, firstName: event.target.value }))} /></label>
            <label className="leads-field"><span>Last name</span><input value={editLeadForm.lastName} onChange={(event) => setEditLeadForm((current) => ({ ...current, lastName: event.target.value }))} /></label>
            <label className="leads-field"><span>Company</span><input value={editLeadForm.company} onChange={(event) => setEditLeadForm((current) => ({ ...current, company: event.target.value }))} /></label>
            <label className="leads-field"><span>Title</span><input value={editLeadForm.title} onChange={(event) => setEditLeadForm((current) => ({ ...current, title: event.target.value }))} /></label>
            {editLeadError ? <p className="leads-modal-error leads-field--wide" role="alert">{editLeadError}</p> : null}
            <div className="leads-modal-actions leads-field--wide"><Button variant="ghost" disabled={editLeadBusy} onClick={() => setEditingLead(false)}>Cancel</Button><Button disabled={editLeadBusy} type="submit">{editLeadBusy ? "Saving…" : "Save changes"}</Button></div>
          </form> : <div className="leads-drawer-facts">
              <div><small>Status</small><StatusBadge tone={leadTone(detail.status)}>{labelStatus(detail.status)}</StatusBadge></div>
              <div><small>Company</small><span>{detail.company || "—"}</span></div>
              <div><small>Title</small><span>{detail.title || "—"}</span></div>
              <div><small>Source</small><span>{detail.source || "—"}</span></div>
              <div><small>List</small><span>{detail.listName}</span></div>
              <div><small>Imported</small><span>{new Date(detail.importedAt).toLocaleDateString()}</span></div>
            </div>}
          <section>
            <h3>Campaign history</h3>
            {detail.enrollments.length ? <ul className="leads-drawer-enrollments">
              {detail.enrollments.map((enrollment) => <li key={enrollment.id}>
                <strong>{enrollment.sequenceName ?? "Campaign"}</strong>
                <span><StatusBadge tone={enrollment.status === "replied" ? "good" : enrollment.status === "active" ? "info" : "neutral"}>{labelStatus(enrollment.status)}</StatusBadge></span>
                <small>{enrollment.startedAt ? new Date(enrollment.startedAt).toLocaleDateString() : "—"}{enrollment.stoppedAt ? ` → ${new Date(enrollment.stoppedAt).toLocaleDateString()}` : ""}</small>
              </li>)}
            </ul> : <p className="leads-drawer-empty">Never enrolled in a campaign.</p>}
          </section>
        </> : null}
      </aside>
    </> : null}

    {showAddLeads ? <AddLeadsModal defaultListId={activeListId} lists={lists} onChanged={refreshAfterLeadChange} onClose={() => setShowAddLeads(false)} /> : null}
  </div>;
}
