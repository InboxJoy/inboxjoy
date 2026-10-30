import Link from "next/link";
import { Check } from "lucide-react";
import { planOffers } from "@/lib/plans";
import { PRIMARY_CTA_HREF, PRIMARY_CTA_LABEL } from "@/lib/site-links";
import { SelfHostLink } from "./site";

// Two ways to run the same product.
// Self-host is free and open source; managed is the $79 lifetime license.
const managedPrice = planOffers.find((offer) => offer.key === "lifetime")?.price ?? "79";

const selfHostFeatures = [
  "Every feature, unlimited mailboxes and sends",
  "You run it on your own server",
  "Bring your own SMTP/IMAP mailboxes or Composio key",
  "Bring your own AI key",
  "MCP for Claude and ChatGPT on your own domain",
  "Community support on GitHub",
] as const;

const managedFeatures = [
  "Every feature, unlimited mailboxes and sends",
  "We host it for you",
  "One-click Gmail and Outlook connection",
  "AI drafting included",
  "Updates and backups handled for you",
  "MCP for Claude and ChatGPT at inboxjoy.online/mcp",
  "Email support",
  "30-day money-back guarantee",
] as const;

const featureGroups = [
  {
    label: "Sending",
    id: "pricing-sending",
    items: [
      "Unlimited mailboxes",
      "Unlimited sends",
      "Unlimited campaigns",
      "Mailbox rotation",
      "Connect Gmail or Outlook",
      "Warm-up ramps from 8 a day to your cap",
      "Daily and hourly caps with sending windows",
    ],
  },
  {
    label: "Workflow & data",
    id: "pricing-workflow-and-data",
    items: [
      "AI-drafted sequences",
      "Merge tags",
      "Auto-stop on reply",
      "CSV, API & MCP lead import",
      "Tracks opens & bounce rates",
      "API & MCP access",
      "Analytics & reports",
    ],
  },
] as const;

export function PricingInclusions() {
  return (
    <section className="pricing-inclusions" aria-labelledby="pricing-inclusions-title">
      <header className="pricing-inclusions-heading">
        <h2 id="pricing-inclusions-title">Everything, in both</h2>
        <p>Same features in both. Self-host is free and you run it. Managed is $79 once and we run it.</p>
      </header>

      <div className="pricing-feature-groups">
        {featureGroups.map((group) => (
          <section
            className="pricing-feature-group"
            key={group.label}
            aria-labelledby={group.id}
          >
            <h3 id={group.id}>{group.label}</h3>
            <ul>
              {group.items.map((item) => (
                <li key={item}>
                  <i aria-hidden="true"><Check size={14} strokeWidth={2.75} /></i>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </section>
  );
}

function PlanList({ items }: { items: readonly string[] }) {
  return (
    <ul className="pricing-plan-list">
      {items.map((item) => (
        <li key={item}>
          <i aria-hidden="true"><Check size={14} strokeWidth={2.75} /></i>
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

export function PlanCards() {
  return (
    <div className="pricing-block">
      <div className="pricing-plan-grid">
        <article className="pricing-plan pricing-plan--selfhost">
          <header className="pricing-plan-header">
            <div className="pricing-plan-title"><h3>Self-host</h3></div>
            <p>Free, open source (AGPL-3.0). You run it on your own server.</p>
          </header>

          <div className="pricing-price">
            <span className="pricing-current-price">
              <sup>$</sup>
              <strong>0</strong>
            </span>
            <span className="pricing-period">free, open source</span>
          </div>

          <PlanList items={selfHostFeatures} />

          <SelfHostLink className="pricing-plan-cta" />
        </article>

        <article className="pricing-plan pricing-plan--featured pricing-plan--managed">
          <header className="pricing-plan-header">
            <div className="pricing-plan-title"><h3>Managed</h3></div>
            <p>We host it. Pay once, no subscription, no renewals.</p>
          </header>

          <div className="pricing-price">
            <span className="pricing-current-price">
              <sup>$</sup>
              <strong>{managedPrice}</strong>
            </span>
            <span className="pricing-period">once, lifetime</span>
          </div>

          <PlanList items={managedFeatures} />

          <Link className="pricing-plan-cta pricing-plan-cta--featured" href={PRIMARY_CTA_HREF}>{PRIMARY_CTA_LABEL}</Link>
        </article>
      </div>

      <PricingInclusions />
    </div>
  );
}
