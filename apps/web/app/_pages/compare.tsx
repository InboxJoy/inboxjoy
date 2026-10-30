import Link from "next/link";
import { ArrowLeftRight, BadgeCheck, Scale } from "lucide-react";
import { PRIMARY_CTA_HREF, PRIMARY_CTA_LABEL } from "@/lib/site-links";
import { CheckList } from "./site";

type CompareRow = readonly [string, string, string];

/** Feature table for /alternatives/* pages. The starting-price row sits last, set larger. */
export function CompareTable({ competitor, rows, price, footer }: { competitor: string; rows: readonly CompareRow[]; price: readonly [string, string]; footer: string }) {
  return (
    <div className="v2-compare-table">
      <div className="v2-compare-row v2-compare-head"><span>Area</span><span><b><img alt="" className="v2-logo-mark" height={18} src="/brand/icon-64x64.png" width={18} />InboxJoy</b></span><span>{competitor}</span></div>
      {rows.map((row) => <div className="v2-compare-row" key={row[0]}>{row.map((cell, index) => <span className={index === 1 ? "v2-compare-us" : ""} key={`${row[0]}-${index}`}>{cell}</span>)}</div>)}
      <div className="v2-compare-row pages-compare-price"><span>Starting price</span><span className="v2-compare-us">{price[0]}</span><span>{price[1]}</span></div>
      <div className="v2-compare-row v2-compare-footer"><span>{footer}</span><span className="v2-compare-us"><Link href={PRIMARY_CTA_HREF}>{PRIMARY_CTA_LABEL}</Link></span><span /></div>
    </div>
  );
}

type FitSide = { title: string; intro: string; items: readonly string[] };

/** "Honest fit check": both sides as checklists so they read as equals. */
export function FitCheck({ competitor, ours, theirs }: { competitor: string; ours: FitSide; theirs: FitSide }) {
  return (
    <div className="pages-split">
      <div className="pages-split-copy"><div className="v2-stripes" /><h3>{ours.title}</h3><p>{ours.intro}</p><CheckList items={ours.items} /></div>
      <article className="pages-fair-card pages-fit-card"><span>Where {competitor} is strong</span><h3>{theirs.title}</h3><p>{theirs.intro}</p><CheckList items={theirs.items} /></article>
    </div>
  );
}

type Decision = { title: string; items: readonly string[] };

/** "Which one should you pick?": icon badge, heading, short checkmark bullets. */
export function DecisionCards({ competitor, ours, theirs, undecided }: { competitor: string; ours: Decision; theirs: Decision; undecided: Decision }) {
  const cards = [
    { key: "ours", badge: "Pick InboxJoy", Icon: BadgeCheck, ...ours },
    { key: "theirs", badge: `Pick ${competitor}`, Icon: ArrowLeftRight, ...theirs },
    { key: "undecided", badge: "Still deciding", Icon: Scale, ...undecided },
  ];
  return (
    <div className="pages-card-grid pages-decision-grid">
      {cards.map(({ key, badge, Icon, title, items }) => (
        <article className={`pages-decision-card${key === "ours" ? " is-ours" : ""}`} key={key}>
          <span className="pages-decision-badge"><Icon aria-hidden="true" size={15} strokeWidth={2.2} />{badge}</span>
          <h3>{title}</h3>
          <CheckList items={items} />
        </article>
      ))}
    </div>
  );
}
