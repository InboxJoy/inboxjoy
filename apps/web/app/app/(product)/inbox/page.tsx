"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, FormEvent, KeyboardEvent } from "react";
import { Ban, ChevronDown, ChevronLeft, Inbox as InboxIcon } from "lucide-react";
import { Button, Card, EmptyState, PageHeader, StatusBadge } from "@inboxjoy/ui";
import { Toast } from "@/components/toast";
import { apiErrorMessage, apiFetch } from "@/lib/api";

type ReplyListItem = {
  id: string;
  contactId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  sequenceId: string | null;
  sequenceName: string | null;
  stepId: string | null;
  stepOrder: number | null;
  subject: string | null;
  snippet: string | null;
  receivedAt: string;
  readAt: string | null;
  intent: string;
  isAutoReply: boolean;
  providerThreadId: string | null;
  emailAccountId: string | null;
  mailboxEmail: string | null;
};

type ThreadEntry = {
  direction: "outbound" | "inbound";
  subject: string | null;
  body: string | null;
  quotedText?: string | null;
  at: string;
  stepOrder?: number | null;
};

type ReplyDetail = ReplyListItem & {
  bodyText: string | null;
  thread: ThreadEntry[];
};

type Pagination = {
  page: number;
  pageSize: number;
  total: number;
  unreadTotal: number;
};

type ReplyFilter = "all" | "unread";

type IntentInfo = { tone: "neutral" | "warning" | "danger"; label: string };

const pageSize = 50;

const footerMarker = "\n\n---\n";
const unsubscribeLinePattern = /^Prefer not to receive these emails\? Unsubscribe: (https?:\/\/\S+)$/m;

// Outbound bodies are our own campaign sends and still carry the plain-text unsubscribe
// footer appended at send time; split it out so it renders as a quiet grey line instead
// of raw footer text.
function EmailBody({ body }: { body: string }) {
  const footerIndex = body.lastIndexOf(footerMarker);
  const footer = footerIndex >= 0 ? body.slice(footerIndex + footerMarker.length) : "";
  const match = footer.match(unsubscribeLinePattern);
  if (!match) return <p className="inbox-thread-body">{body}</p>;
  const address = footer.slice(0, match.index).trim();
  return (
    <>
      <p className="inbox-thread-body">{body.slice(0, footerIndex).trimEnd()}</p>
      <p className="inbox-thread-footer">
        {address ? <>{address}<br /></> : null}
        Prefer not to receive these emails? <a href={match[1]} target="_blank" rel="noreferrer">Unsubscribe</a>
      </p>
    </>
  );
}

function leadName(reply: ReplyListItem) {
  return [reply.firstName, reply.lastName].filter(Boolean).join(" ") || reply.email;
}

function intentInfo(intent: string): IntentInfo | null {
  if (intent === "auto_reply") return { tone: "neutral", label: "Auto-reply" };
  if (intent === "opt_out") return { tone: "danger", label: "Unsubscribed" };
  if (intent === "soft_decline") return { tone: "warning", label: "Not interested" };
  return null;
}

function relativeTime(value: string) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "";
  const elapsed = Date.now() - timestamp;
  const minutes = Math.max(1, Math.round(elapsed / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(value).toLocaleDateString();
}

function fullDateTime(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
}

function daysBetween(a: Date, b: Date) {
  const startA = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const startB = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  return Math.round((startB - startA) / 86_400_000);
}

// List row time: "2:14 PM" today, weekday within 6 days, otherwise "Sep 16".
function listTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const diff = daysBetween(date, new Date());
  if (diff <= 0) return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (diff < 7) return date.toLocaleDateString(undefined, { weekday: "short" });
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Expanded thread entry timestamp: "Sep 16, 4:11 PM".
function threadTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function SkeletonRows() {
  return (
    <div className="inbox-list-skeleton" aria-hidden="true">
      {Array.from({ length: 6 }).map((_, index) => (
        <div className="inbox-skeleton-row" key={index}>
          <span className="inbox-skeleton-bar inbox-skeleton-bar--wide" />
          <span className="inbox-skeleton-bar inbox-skeleton-bar--full" />
          <span className="inbox-skeleton-bar inbox-skeleton-bar--narrow" />
        </div>
      ))}
    </div>
  );
}

export default function InboxPage() {
  const [replies, setReplies] = useState<ReplyListItem[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, pageSize, total: 0, unreadTotal: 0 });
  const [counts, setCounts] = useState<{ total: number; unreadTotal: number }>({ total: 0, unreadTotal: 0 });
  const [campaigns, setCampaigns] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<ReplyFilter>("all");
  const [sequenceId, setSequenceId] = useState("");
  const [page, setPage] = useState(1);
  const [selectedReplyId, setSelectedReplyId] = useState("");
  const [selectedReply, setSelectedReply] = useState<ReplyDetail | null>(null);
  const [replyBody, setReplyBody] = useState("");
  const [threadingNotice, setThreadingNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [suppressing, setSuppressing] = useState(false);
  const [suppressedContactIds, setSuppressedContactIds] = useState<Set<string>>(new Set());
  const [expandedEntries, setExpandedEntries] = useState<Set<number>>(new Set());
  const [expandedQuotes, setExpandedQuotes] = useState<Set<number>>(new Set());
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [paneOffset, setPaneOffset] = useState(220);
  const loadGeneration = useRef(0);
  const selectionGeneration = useRef(0);
  const countsGeneration = useRef(0);
  const replyAttempt = useRef<{ replyId: string; body: string; key: string } | null>(null);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    let active = true;
    void apiFetch<{ sequences: Array<{ id: string; name: string }> }>("/v1/sequences", {}, "Could not load campaign filters.")
      .then((data) => {
        if (active) setCampaigns((current) => ({ ...current, ...Object.fromEntries(data.sequences.map((sequence) => [sequence.id, sequence.name])) }));
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  const loadReplies = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    setError("");
    const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (filter === "unread") query.set("unread", "true");
    if (sequenceId) query.set("sequenceId", sequenceId);

    try {
      const data = await apiFetch<{ replies: ReplyListItem[]; pagination: Pagination }>(`/v1/replies?${query.toString()}`, {}, "Could not load replies.");
      if (generation !== loadGeneration.current) return;
      setReplies(data.replies);
      setPagination(data.pagination);
      setCampaigns((current) => {
        const next = { ...current };
        data.replies.forEach((reply) => {
          if (reply.sequenceId && reply.sequenceName) next[reply.sequenceId] = reply.sequenceName;
        });
        return next;
      });
    } catch (reason) {
      if (generation === loadGeneration.current) setError(apiErrorMessage(reason, "Could not load replies."));
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [filter, page, sequenceId]);

  useEffect(() => { void loadReplies(); }, [loadReplies]);

  // The pills show both the "All" and "Unread" counts at once, regardless of which
  // filter is active, so they need their own request (unscoped by the unread flag)
  // rather than reusing whichever count the active list fetch happened to return.
  const loadCounts = useCallback(async () => {
    const generation = ++countsGeneration.current;
    const query = new URLSearchParams({ page: "1", pageSize: "1" });
    if (sequenceId) query.set("sequenceId", sequenceId);
    try {
      const data = await apiFetch<{ pagination: Pagination }>(`/v1/replies?${query.toString()}`, {}, "");
      if (generation !== countsGeneration.current) return;
      setCounts({ total: data.pagination.total, unreadTotal: data.pagination.unreadTotal });
    } catch {
      // Pill counts are best-effort cosmetic detail; the list itself still loads.
    }
  }, [sequenceId]);

  useEffect(() => { void loadCounts(); }, [loadCounts]);

  const campaignOptions = useMemo(() => Object.entries(campaigns).sort((left, right) => left[1].localeCompare(right[1])), [campaigns]);
  const totalPages = Math.max(1, Math.ceil(pagination.total / pagination.pageSize));
  const showLayout = loading || replies.length > 0 || filter !== "all" || !!sequenceId;

  // Measure the real offset from the viewport top to the split view (page header,
  // any plan banner, main-content padding) so the pane can fill exactly to the fold
  // instead of guessing a fixed pixel value.
  useEffect(() => {
    if (!showLayout) return;
    const el = layoutRef.current;
    if (!el) return;
    function measure() {
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const mainContent = el.closest(".main-content");
      const bottomGutter = mainContent ? parseFloat(window.getComputedStyle(mainContent).paddingBottom) || 32 : 32;
      setPaneOffset(Math.round(rect.top + bottomGutter));
    }
    measure();
    window.addEventListener("resize", measure);
    const timeout = window.setTimeout(measure, 300);
    return () => {
      window.removeEventListener("resize", measure);
      window.clearTimeout(timeout);
    };
  }, [showLayout]);

  async function selectReply(reply: ReplyListItem) {
    const generation = ++selectionGeneration.current;
    setSelectedReplyId(reply.id);
    setSelectedReply(null);
    setReplyBody("");
    setExpandedQuotes(new Set());
    replyAttempt.current = null;
    setDetailLoading(true);
    setError("");
    setThreadingNotice("");

    const detailRequest = apiFetch<{ reply: ReplyDetail }>(`/v1/replies/${reply.id}`, {}, "Could not load this reply.");
    const readRequest = apiFetch<{ reply: ReplyListItem }>(`/v1/replies/${reply.id}/read`, { method: "POST" }, "Could not mark this reply as read.");
    const [detailResult, readResult] = await Promise.allSettled([detailRequest, readRequest] as const);
    if (generation !== selectionGeneration.current) return;

    if (readResult.status === "fulfilled") {
      const markedReply = readResult.value.reply;
      setReplies((current) => current.map((item) => item.id === markedReply.id ? markedReply : item));
      if (!reply.readAt && markedReply.readAt) {
        setPagination((current) => ({ ...current, unreadTotal: Math.max(0, current.unreadTotal - 1) }));
        setCounts((current) => ({ ...current, unreadTotal: Math.max(0, current.unreadTotal - 1) }));
      }
    }

    if (detailResult.status === "fulfilled") {
      const detail = detailResult.value.reply;
      const markedReply = readResult.status === "fulfilled" ? readResult.value.reply : null;
      setSelectedReply(markedReply ? { ...detail, ...markedReply, bodyText: detail.bodyText, thread: detail.thread } : detail);
    } else {
      setError(apiErrorMessage(detailResult.reason, "Could not load this reply."));
    }

    if (readResult.status === "rejected" && detailResult.status === "fulfilled") {
      setError(apiErrorMessage(readResult.reason, "Could not mark this reply as read."));
    }
    setDetailLoading(false);
  }

  function handleListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (!replies.length) return;
    event.preventDefault();
    const currentIndex = replies.findIndex((item) => item.id === selectedReplyId);
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const nextIndex = currentIndex === -1 ? 0 : Math.min(replies.length - 1, Math.max(0, currentIndex + delta));
    const next = replies[nextIndex];
    if (next) {
      void selectReply(next);
      rowRefs.current[nextIndex]?.focus();
    }
  }

  function toggleEntry(index: number) {
    setExpandedEntries((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index); else next.add(index);
      return next;
    });
  }

  function toggleQuote(index: number) {
    setExpandedQuotes((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index); else next.add(index);
      return next;
    });
  }

  async function suppressContact(reply: ReplyDetail) {
    if (!window.confirm(`Stop all emails to ${reply.email}? They'll be added to your suppression list.`)) return;
    setSuppressing(true);
    setError("");
    try {
      await apiFetch("/v1/suppressions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: reply.email, reason: "manual" }),
      }, "Could not suppress this contact.");
      setSuppressedContactIds((current) => new Set(current).add(reply.contactId));
      setNotice("Contact suppressed");
    } catch (reason) {
      setError(apiErrorMessage(reason, "Could not suppress this contact."));
    } finally {
      setSuppressing(false);
    }
  }

  async function sendReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = replyBody.trim();
    if (!selectedReply || !body) return;

    const replyId = selectedReply.id;
    const generation = selectionGeneration.current;
    const isCurrentSelection = () => generation === selectionGeneration.current;
    setSending(true);
    setError("");
    setNotice("");
    setThreadingNotice("");
    const attempt = replyAttempt.current?.replyId === replyId && replyAttempt.current.body === body
      ? replyAttempt.current
      : { replyId, body, key: crypto.randomUUID() };
    replyAttempt.current = attempt;
    try {
      const data = await apiFetch<{ sent: true; providerMessageId: string; threading: "in_thread" | "new_thread" }>("/v1/replies/" + replyId + "/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body, idempotencyKey: attempt.key }),
      }, "Could not send this reply.");
      if (!isCurrentSelection()) return;
      setReplyBody("");
      replyAttempt.current = null;
      setNotice("Reply sent.");
      if (data.threading === "new_thread") {
        setThreadingNotice("This reply was sent as a new email rather than in the existing thread.");
      }
      void apiFetch<{ reply: ReplyDetail }>("/v1/replies/" + replyId, {}, "Could not refresh this conversation.")
        .then(({ reply }) => { if (isCurrentSelection()) setSelectedReply(reply); })
        .catch(() => undefined);
      void loadReplies();
    } catch (reason) {
      if (isCurrentSelection()) setError(apiErrorMessage(reason, "Could not send this reply."));
    } finally {
      setSending(false);
    }
  }
  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  const thread = selectedReply ? [...selectedReply.thread].sort((left, right) => new Date(left.at).getTime() - new Date(right.at).getTime()) : [];
  const threadKey = selectedReply ? `${selectedReply.id}|${thread.length}` : "";

  useEffect(() => {
    if (!selectedReply) return;
    const defaults = new Set<number>();
    thread.forEach((entry, index) => {
      if (entry.direction === "inbound" || index === thread.length - 1) defaults.add(index);
    });
    setExpandedEntries(defaults);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadKey]);

  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [replyBody]);

  const headerBadge = selectedReply ? intentInfo(selectedReply.intent) : null;
  const layoutStyle = { "--inbox-offset": `${paneOffset}px` } as CSSProperties;

  return <div className="page-stack inbox-replies-page dashboard-polish-page">
    <PageHeader eyebrow="Replies" title="Inbox" description="Read campaign replies and continue the conversation." />
    {error ? <Toast tone="error" message={error} onDismiss={() => setError("")} action={<Button variant="ghost" onClick={() => void loadReplies()}>Try again</Button>} /> : null}
    {notice ? <Toast tone="success" message={notice} onDismiss={() => setNotice("")} /> : null}

    {!showLayout ? (
      <EmptyState title="No replies yet" description="Replies to your campaigns land here, and follow-ups stop automatically when someone answers." />
    ) : (
      <div className="inbox-replies-layout" data-mobile-view={selectedReplyId ? "thread" : "list"} ref={layoutRef} style={layoutStyle}>
        <Card className="inbox-list-pane">
          <div className="inbox-list-toolbar">
            <div className="polish-filter-pills" aria-label="Filter replies">
              <button aria-pressed={filter === "all"} type="button" onClick={() => { setFilter("all"); setPage(1); }}>All <span className="inbox-pill-count">{counts.total}</span></button>
              <button aria-pressed={filter === "unread"} type="button" onClick={() => { setFilter("unread"); setPage(1); }}>Unread <span className="inbox-pill-count">{counts.unreadTotal}</span></button>
            </div>
            <label className="inbox-campaign-filter">
              <select aria-label="Filter by campaign" value={sequenceId} onChange={(event) => { setSequenceId(event.target.value); setPage(1); }}>
                <option value="">All campaigns</option>
                {campaignOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>
            </label>
          </div>

          {loading ? <SkeletonRows /> : replies.length === 0 ? (
            <div className="polish-filter-empty">
              <p>No replies match these filters.</p>
              <button type="button" onClick={() => { setFilter("all"); setSequenceId(""); setPage(1); }}>Show all replies</button>
            </div>
          ) : (
            <div className="inbox-list-scroll" aria-label="Campaign replies" onKeyDown={handleListKeyDown}>
              {replies.map((reply, index) => {
                const unread = !reply.readAt;
                const chip = intentInfo(reply.intent);
                return <button
                  aria-current={selectedReplyId === reply.id ? "true" : undefined}
                  aria-label={`Open reply from ${leadName(reply)}`}
                  className={`inbox-row${selectedReplyId === reply.id ? " is-selected" : ""}`}
                  key={reply.id}
                  ref={(el) => { rowRefs.current[index] = el; }}
                  type="button"
                  onClick={() => void selectReply(reply)}
                >
                  <span className="inbox-row-line1">
                    <span className="inbox-row-name-cluster">
                      <span className="inbox-row-dot" data-unread={unread ? "true" : "false"} aria-hidden="true" />
                      <span className={`inbox-row-name${unread ? " is-unread" : ""}`}>{leadName(reply)}</span>
                      {reply.company ? <span className="inbox-row-company">· {reply.company}</span> : null}
                    </span>
                    <time className="inbox-row-time" dateTime={reply.receivedAt} title={fullDateTime(reply.receivedAt)}>{listTime(reply.receivedAt)}</time>
                  </span>
                  <span className="inbox-row-line2">
                    <span className="inbox-row-subject">{reply.subject || "No subject"}</span>
                    <span className="inbox-row-snippet"> — {reply.snippet || "No preview available."}</span>
                  </span>
                  <span className="inbox-row-line3">
                    {chip ? <StatusBadge tone={chip.tone}>{chip.label}</StatusBadge> : null}
                    <span className="inbox-row-meta">{reply.sequenceName ?? "Campaign unavailable"}{reply.stepOrder ? ` · Step ${reply.stepOrder}` : ""}</span>
                  </span>
                </button>;
              })}
            </div>
          )}

          {pagination.total > pagination.pageSize ? <div className="inbox-list-pagination">
            <Button variant="ghost" disabled={page <= 1 || loading} onClick={() => setPage((current) => Math.max(1, current - 1))}>Previous</Button>
            <span className="polish-mono-label">Page {pagination.page} of {totalPages}</span>
            <Button variant="ghost" disabled={page >= totalPages || loading} onClick={() => setPage((current) => Math.min(totalPages, current + 1))}>Next</Button>
          </div> : null}
        </Card>

        <Card className="inbox-thread-pane">
          <button type="button" className="inbox-thread-back" onClick={() => { selectionGeneration.current += 1; replyAttempt.current = null; setSelectedReplyId(""); setSelectedReply(null); }}>
            <ChevronLeft size={16} aria-hidden="true" /> Back to inbox
          </button>

          {detailLoading ? (
            <div className="inbox-thread-empty"><p>Loading conversation…</p></div>
          ) : selectedReply ? (
            <>
              <div className="inbox-thread-header">
                <div className="inbox-thread-header-text">
                  <h2>{selectedReply.subject || "No subject"}</h2>
                  <p>{leadName(selectedReply)} · {selectedReply.email}{selectedReply.company ? ` · ${selectedReply.company}` : ""}</p>
                  <p className="inbox-thread-header-meta">{selectedReply.sequenceName ?? "Campaign unavailable"}{selectedReply.stepOrder ? ` · Step ${selectedReply.stepOrder}` : ""}</p>
                </div>
                <div className="inbox-thread-header-actions">
                  {headerBadge ? <StatusBadge tone={headerBadge.tone}>{headerBadge.label}</StatusBadge> : null}
                  {selectedReply.intent === "opt_out" ? (
                    <span className="inbox-thread-suppress-note">Added to suppression list automatically</span>
                  ) : suppressedContactIds.has(selectedReply.contactId) ? (
                    <span className="inbox-thread-suppress-note">Suppressed</span>
                  ) : (
                    <Button variant="secondary" disabled={suppressing} onClick={() => void suppressContact(selectedReply)}>
                      <Ban size={14} aria-hidden="true" /> {suppressing ? "Suppressing…" : "Suppress contact"}
                    </Button>
                  )}
                </div>
              </div>

              <div className="inbox-thread-entries">
                {thread.map((entry, index) => {
                  const isOutbound = entry.direction === "outbound";
                  const isExpanded = expandedEntries.has(index);
                  const badge = isOutbound ? { tone: "neutral" as const, label: "Sent" } : (intentInfo(selectedReply.intent) ?? { tone: "good" as const, label: "Reply" });
                  const entrySubject = entry.subject || selectedReply.subject || "No subject";

                  if (isOutbound && !isExpanded) {
                    return (
                      <button type="button" key={index} className="inbox-entry-collapsed" onClick={() => toggleEntry(index)}>
                        Sent{entry.stepOrder ? ` · Step ${entry.stepOrder}` : ""} · {relativeTime(entry.at)} — {entrySubject}
                      </button>
                    );
                  }

                  const quoteExpanded = expandedQuotes.has(index);
                  return (
                    <Card className="inbox-thread-entry" key={index}>
                      <div className="inbox-thread-entry-heading">
                        <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
                        <span className="inbox-entry-meta">{entry.stepOrder ? `Step ${entry.stepOrder} · ` : ""}<time dateTime={entry.at} title={fullDateTime(entry.at)}>{threadTime(entry.at)}</time></span>
                      </div>
                      {entry.subject ? <strong className="inbox-entry-subject">{entry.subject}</strong> : null}
                      {isOutbound ? (
                        entry.body ? <EmailBody body={entry.body} /> : <p className="inbox-thread-body">No message body was captured.</p>
                      ) : (
                        <>
                          {entry.body ? <p className="inbox-thread-body">{entry.body}</p> : <p className="inbox-thread-body">No message body was captured.</p>}
                          {entry.quotedText ? (
                            <>
                              <button type="button" className="inbox-quote-toggle" aria-expanded={quoteExpanded} onClick={() => toggleQuote(index)}>
                                <ChevronDown size={14} aria-hidden="true" className={quoteExpanded ? "is-open" : ""} />
                                {quoteExpanded ? "Hide quoted text" : "Show quoted text"}
                              </button>
                              {quoteExpanded ? <p className="inbox-quote-text">{entry.quotedText}</p> : null}
                            </>
                          ) : null}
                        </>
                      )}
                    </Card>
                  );
                })}
              </div>

              <Card className="inbox-composer">
                <form onSubmit={(event) => void sendReply(event)}>
                  <textarea
                    aria-label="Reply"
                    ref={composerRef}
                    placeholder="Write a reply"
                    rows={2}
                    value={replyBody}
                    onChange={(event) => setReplyBody(event.target.value)}
                    onKeyDown={handleComposerKeyDown}
                    disabled={sending}
                  />
                  <div className="inbox-composer-actions">
                    {threadingNotice ? <span className="inbox-composer-hint" role="status">{threadingNotice}</span> : <span className="inbox-composer-hint">⌘ Enter to send</span>}
                    <Button type="submit" disabled={sending || !replyBody.trim()}>{sending ? "Sending…" : "Send reply"}</Button>
                  </div>
                </form>
              </Card>
            </>
          ) : (
            <div className="inbox-thread-empty">
              <InboxIcon size={28} aria-hidden="true" />
              <h2>Select a reply</h2>
              <p>Pick a conversation from the list to read it and reply.</p>
            </div>
          )}
        </Card>
      </div>
    )}
  </div>;
}
