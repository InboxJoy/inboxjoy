import type { ReactNode } from "react";

type Tone = "neutral" | "good" | "warning" | "danger" | "info";

export type CampaignDisplayStatus = "draft" | "active" | "needs_attention" | "paused" | "finished" | "archived";
export type CampaignStatusReason = "sequence_paused" | "mailbox_reconnect_required" | "sending_failed_repeatedly" | "sending_disabled";
export type CampaignStatusFields = {
  status: string;
  displayStatus?: CampaignDisplayStatus | null;
  statusReason?: CampaignStatusReason | null;
  completedAt?: string | null;
};

const campaignStatuses: Record<CampaignDisplayStatus, { label: string; tone: Tone }> = {
  draft: { label: "Draft", tone: "neutral" },
  active: { label: "Active", tone: "good" },
  needs_attention: { label: "Needs attention", tone: "danger" },
  paused: { label: "Paused", tone: "warning" },
  finished: { label: "Finished", tone: "info" },
  archived: { label: "Archived", tone: "neutral" },
};

const campaignStatusReasons: Record<CampaignStatusReason, string> = {
  sending_disabled: "Sending is off for this workspace. Check billing to continue.",
  sequence_paused: "Sending stopped after repeated errors. Resume to continue.",
  mailbox_reconnect_required: "Reconnect your mailbox to continue sending.",
  sending_failed_repeatedly: "Recent sends failed. Check your mailbox connection.",
};

export function campaignDisplayStatus(campaign: CampaignStatusFields): CampaignDisplayStatus {
  if (campaign.displayStatus) return campaign.displayStatus;
  if (campaign.status === "completed") return "finished";
  if (campaign.status === "published") return "active";
  return Object.hasOwn(campaignStatuses, campaign.status) ? campaign.status as CampaignDisplayStatus : "draft";
}

export function campaignStatusLabel(displayStatus: CampaignDisplayStatus): string {
  return campaignStatuses[displayStatus].label;
}

export function campaignStatusTone(displayStatus: CampaignDisplayStatus): Tone {
  return campaignStatuses[displayStatus].tone;
}

export function campaignStatusReasonText(statusReason: CampaignStatusReason | null | undefined): string | null {
  return statusReason ? campaignStatusReasons[statusReason] : null;
}

export function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

// Sentence case, per DESIGN.md: "auth_error" -> "Auth error".
export function labelStatus(status: string) {
  const words = status.replaceAll("_", " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// "Oct 17, 2026".
export function formatDate(value: string | Date | null | undefined, fallback = "—") {
  if (!value) return fallback;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return fallback;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// "Oct 19, 4:02 PM" (year added when it is not this year). No seconds in product UI.
export function formatDateTime(value: string | Date | null | undefined, fallback = "—") {
  if (!value) return fallback;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return fallback;
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), hour: "numeric", minute: "2-digit" });
}

export function Button({
  children,
  className,
  variant = "primary",
  onClick,
  disabled,
  type = "button"
}: {
  children: ReactNode;
  className?: string;
  variant?: "primary" | "secondary" | "ghost";
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  return (
    <button className={cx("ij-button", `ij-button--${variant}`, className)} type={type} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

export function Card({
  children,
  className
}: {
  children: ReactNode;
  className?: string;
}) {
  return <section className={cx("ij-card", className)}>{children}</section>;
}

export function PageHeader({
  eyebrow,
  title,
  description,
  action
}: {
  eyebrow?: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="ij-page-header">
      <div>
        {eyebrow ? <p className="ij-eyebrow">{eyebrow}</p> : null}
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action ? <div className="ij-page-action">{action}</div> : null}
    </div>
  );
}

export function StatusBadge({
  children,
  tone = "neutral"
}: {
  children: ReactNode;
  tone?: Tone;
}) {
  return <span className={cx("ij-badge", `ij-badge--${tone}`)}>{children}</span>;
}

// Stat cards share one treatment app-wide (label, value, helper). `tone` is accepted for
// existing callers but no longer drawn: color stays on status badges, not card chrome.
export function StatCard({
  label,
  value,
  helper
}: {
  label: string;
  value: string;
  helper: string;
  tone?: Tone;
}) {
  return (
    <Card className="ij-stat-card">
      <p>{label}</p>
      <strong>{value}</strong>
      <span>{helper}</span>
    </Card>
  );
}

export function ProgressBar({
  value,
  label
}: {
  value: number;
  label?: string;
}) {
  const safeValue = Math.max(0, Math.min(100, value));

  return (
    <div className="ij-progress-wrap" aria-label={label}>
      <div className="ij-progress-bar" style={{ width: `${safeValue}%` }} />
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <Card className="ij-empty-state">
      <div className="ij-empty-icon" aria-hidden="true" />
      <h2>{title}</h2>
      <p>{description}</p>
      {action ? <div>{action}</div> : null}
    </Card>
  );
}

export function MetricRow({
  label,
  value,
  detail
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="ij-metric-row">
      <div>
        <strong>{label}</strong>
        <span>{detail}</span>
      </div>
      <b>{value}</b>
    </div>
  );
}
