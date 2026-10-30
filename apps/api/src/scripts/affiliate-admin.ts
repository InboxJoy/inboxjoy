// Founder-run CLI for the affiliate program: set a workspace's commission
// terms, list what is currently owed, and mark a workspace's commissions as
// paid out. Run via the affiliate-admin wrapper script,
// which execs `node dist/scripts/affiliate-admin.js <subcommand...>` inside
// the api container -- never against production from a local checkout.
import { loadAppEnv } from "@inboxjoy/config";
import { listAffiliatePayoutsDue, markAffiliateCommissionsPaid, setAffiliateCommission } from "@inboxjoy/core";
import { createDb, createPgPool, type InboxJoyDb } from "@inboxjoy/db";

import { resolveWorkspaceIdByOwnerEmail } from "./resolve-workspace.js";

function usage(message?: string): never {
  if (message) console.error(`${message}\n`);
  console.error([
    "Usage:",
    "  affiliate-admin set-commission <owner-email> <percent|default> [months|default]",
    "  affiliate-admin owed",
    "  affiliate-admin mark-paid <owner-email>",
  ].join("\n"));
  process.exit(1);
}

function parsePercent(value: string): number | null {
  if (value === "default") return null;
  const percent = Number(value);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    usage('percent must be a number between 0 and 100, or "default"');
  }
  return percent;
}

function parseMonths(value: string | undefined): number | null {
  if (value === undefined || value === "default") return null;
  const months = Number(value);
  if (!Number.isInteger(months) || months <= 0) {
    usage('months must be a positive integer, or "default"');
  }
  return months;
}

// markAffiliateCommissionsPaid does not return a currency, so this formats
// in the workspace's own minor units without a currency symbol -- the admin
// output is a plain number, not a locale-formatted price.
function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

function formatAmount(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${formatCents(cents)} ${currency}`;
  }
}

async function runSetCommission(db: InboxJoyDb, args: string[]): Promise<void> {
  const [ownerEmail, percentArg, monthsArg] = args;
  if (!ownerEmail || percentArg === undefined) {
    usage("set-commission requires <owner-email> <percent|default> [months|default]");
  }
  const percent = parsePercent(percentArg);
  const months = parseMonths(monthsArg);

  const workspaceId = await resolveWorkspaceIdByOwnerEmail(db, ownerEmail);
  await setAffiliateCommission(db, { workspaceId, percent, months });
  console.log(`Set commission for ${ownerEmail} (workspace ${workspaceId}): percent=${percent ?? "default"} months=${months ?? "default"}`);
}

async function runOwed(db: InboxJoyDb): Promise<void> {
  const rows = await listAffiliatePayoutsDue(db);
  if (rows.length === 0) {
    console.log("No affiliate payouts due.");
    return;
  }
  console.log(["Email", "Code", "Amount", "Commissions"].join("\t"));
  for (const row of rows) {
    console.log([
      row.ownerEmail ?? "(unknown)",
      row.code,
      formatAmount(row.dueCents, row.currency),
      String(row.commissionCount),
    ].join("\t"));
  }
}

async function runMarkPaid(db: InboxJoyDb, args: string[]): Promise<void> {
  const [ownerEmail] = args;
  if (!ownerEmail) usage("mark-paid requires <owner-email>");

  const workspaceId = await resolveWorkspaceIdByOwnerEmail(db, ownerEmail);
  const result = await markAffiliateCommissionsPaid(db, { workspaceId });
  console.log(`Marked ${result.commissionCount} commission(s) paid for ${ownerEmail}: ${formatCents(result.paidCents)}`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command) usage();

  const env = loadAppEnv();
  const pool = createPgPool(env.DATABASE_URL, { max: 2, applicationName: "inboxjoy-affiliate-admin" });
  const db = createDb(pool);

  try {
    if (command === "set-commission") return await runSetCommission(db, args);
    if (command === "owed") return await runOwed(db);
    if (command === "mark-paid") return await runMarkPaid(db, args);
    usage(`Unknown command: ${command}`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
