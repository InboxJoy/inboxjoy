"use client";

import { useEffect, useMemo, useState } from "react";
import { Button, Card, EmptyState, formatDate, PageHeader, StatCard, StatusBadge } from "@inboxjoy/ui";
import { apiErrorMessage, apiFetch } from "@/lib/api";
import { Toast } from "@/components/toast";

type Affiliate = {
  code: string;
  commissionPercent: number;
  commissionMonths: number;
  holdDays: number;
  clicks: number;
  signups: number;
  paidCustomers: number;
  currency: string;
  earnedCents: number;
  pendingCents: number;
  availableCents: number;
  paidCents: number;
};

type Referral = { id: string; createdAt: string; status: "signed_up" | "paid"; earnedCents: number };

const referralStatusLabel: Record<Referral["status"], string> = { signed_up: "Signed up", paid: "Paying" };
const referralStatusTone: Record<Referral["status"], "neutral" | "good"> = { signed_up: "neutral", paid: "good" };

function formatMoney(cents: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "USD" }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

export default function AffiliatePage() {
  const [affiliate, setAffiliate] = useState<Affiliate | null>(null);
  const [referrals, setReferrals] = useState<Referral[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    Promise.all([
      apiFetch<Affiliate>("/v1/affiliate", {}, "Could not load your affiliate stats."),
      apiFetch<{ referrals: Referral[] }>("/v1/affiliate/referrals?limit=50", {}, "Could not load your referrals."),
    ])
      .then(([affiliateData, referralsData]) => {
        if (!active) return;
        setAffiliate(affiliateData);
        setReferrals(referralsData.referrals ?? []);
      })
      .catch((reason) => { if (active) setError(apiErrorMessage(reason, "Could not load your affiliate stats.")); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const referralLink = useMemo(() => {
    if (!affiliate || typeof window === "undefined") return "";
    return `${window.location.origin}/?ref=${affiliate.code}`;
  }, [affiliate]);

  const currency = affiliate?.currency || "USD";

  async function copyLink() {
    if (!referralLink) return;
    try {
      await navigator.clipboard.writeText(referralLink);
      setCopied(true);
    } catch {
      setError("Could not copy the link. Select and copy it manually.");
    }
  }

  const description = affiliate
    ? `Earn ${affiliate.commissionPercent}% of every payment your referrals make for ${affiliate.commissionMonths} months.`
    : "Earn a share of every payment your referrals make.";

  return <div className="page-stack affiliate-page">
    <PageHeader eyebrow="Refer & earn" title="Refer & earn" description={description} />
    {error ? <Card className="page-message page-message--error"><p role="alert">{error}</p></Card> : null}

    <Card className="settings-card">
      <span className="polish-mono-label">Your link</span>
      <div className="settings-card-heading"><div><h2>Share your link</h2><p>Anyone who signs up through this link is tracked as your referral for 60 days.</p></div></div>
      <div className="settings-secret settings-secret--inline">
        <code>{loading ? "Loading your link…" : referralLink || "Your link will appear here"}</code>
        <Button disabled={loading || !referralLink} onClick={() => void copyLink()}>Copy link</Button>
      </div>
    </Card>

    <div className="stat-grid affiliate-stat-grid">
      <StatCard label="Clicks" value={loading ? "—" : String(affiliate?.clicks ?? 0)} helper="People who opened your link" tone="neutral" />
      <StatCard label="Signups" value={loading ? "—" : String(affiliate?.signups ?? 0)} helper="Accounts created from your link" tone="info" />
      <StatCard label="Paying customers" value={loading ? "—" : String(affiliate?.paidCustomers ?? 0)} helper="Referrals who have paid" tone="good" />
      <StatCard label="Earned" value={loading ? "—" : formatMoney(affiliate?.earnedCents ?? 0, currency)} helper="Total commissions earned" tone="good" />
      <StatCard label="Available to pay out" value={loading ? "—" : formatMoney(affiliate?.availableCents ?? 0, currency)} helper="Cleared and ready for payout" tone="info" />
      <StatCard label="Paid" value={loading ? "—" : formatMoney(affiliate?.paidCents ?? 0, currency)} helper="Already paid out to you" tone="neutral" />
    </div>

    <p className="dashboard-panel-copy">Commissions become available {affiliate?.holdDays ?? 30} days after each payment and are paid out monthly.</p>

    <Card className="settings-card settings-table-card">
      <div className="settings-card-heading"><div><span className="polish-mono-label">Referrals</span><h2>Your referrals</h2><p>Everyone who signed up through your link.</p></div><StatusBadge tone="neutral">{referrals.length}</StatusBadge></div>
      {loading ? <EmptyState title="Loading your referrals…" description="This will only take a moment." /> : referrals.length ? <div className="settings-table">
        <div className="settings-table-row settings-table-row--affiliate settings-table-head" role="row"><span>Date</span><span>Status</span><span>Earned</span></div>
        {referrals.map((referral) => <div className="settings-table-row settings-table-row--affiliate" key={referral.id} role="row">
          <span>{formatDate(referral.createdAt)}</span>
          <span data-label="Status"><StatusBadge tone={referralStatusTone[referral.status]}>{referralStatusLabel[referral.status]}</StatusBadge></span>
          <span data-label="Earned">{formatMoney(referral.earnedCents, currency)}</span>
        </div>)}
      </div> : <EmptyState title="No referrals yet" description="Share your link above and your referrals will show up here." />}
    </Card>

    {copied ? <Toast tone="success" message="Link copied" onDismiss={() => setCopied(false)} /> : null}
  </div>;
}
