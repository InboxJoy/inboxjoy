// Founder-run CLI for granting a free ("comp") subscription to a workspace by
// owner email, with no charge. Run via
// the billing-admin wrapper script, which execs
// `node dist/scripts/billing-admin.js <subcommand...>` inside the api
// container -- never against production from a local checkout.
import { loadAppEnv } from "@inboxjoy/config";
import { describeWorkspaceSubscription, grantCompSubscription } from "@inboxjoy/core";
import { createDb, createPgPool, type InboxJoyDb } from "@inboxjoy/db";

import { resolveWorkspaceIdByOwnerEmail } from "./resolve-workspace.js";

function usage(message?: string): never {
  if (message) console.error(`${message}\n`);
  console.error([
    "Usage:",
    "  billing-admin status <owner-email>",
    "  billing-admin comp <owner-email> <months> [--force]",
  ].join("\n"));
  process.exit(1);
}

function planLabel(productId: string | null, env: ReturnType<typeof loadAppEnv>): string {
  if (!productId) return "(none)";
  if (env.DODO_PRODUCT_LIFETIME && productId === env.DODO_PRODUCT_LIFETIME) return "lifetime";
  return `unknown (${productId})`;
}

async function runStatus(db: InboxJoyDb, env: ReturnType<typeof loadAppEnv>, args: string[]): Promise<void> {
  const [ownerEmail] = args;
  if (!ownerEmail) usage("status requires <owner-email>");

  const workspaceId = await resolveWorkspaceIdByOwnerEmail(db, ownerEmail);
  const description = await describeWorkspaceSubscription(db, workspaceId);

  console.log(`Workspace: ${workspaceId}`);
  if (!description.exists) {
    console.log("No subscription row for this workspace (free, never subscribed).");
    return;
  }
  console.log(`Status: ${description.status}`);
  console.log(`Plan: ${planLabel(description.productId, env)}`);
  console.log(`Comp: ${description.isComp ? "yes" : "no"}`);
  console.log(`Lifetime license: ${description.isLifetime ? "yes" : "no"}`);
  console.log(`Has Dodo subscription: ${description.hasDodoSubscription ? "yes" : "no"}`);
  console.log(`Next billing / comp end date: ${description.nextBillingDate?.toISOString() ?? "(none)"}`);
  console.log(`Trial end: ${description.trialEnd?.toISOString() ?? "(none)"}`);
  console.log(`Cancel at period end: ${description.cancelAtPeriodEnd ? "yes" : "no"}`);
}

async function runComp(db: InboxJoyDb, args: string[]): Promise<void> {
  const [ownerEmail, monthsArg, ...rest] = args;
  const months = Number(monthsArg);
  if (!ownerEmail || !Number.isInteger(months) || months < 1) {
    usage("comp requires <owner-email> <months> [--force]");
  }
  const force = rest.includes("--force");

  const workspaceId = await resolveWorkspaceIdByOwnerEmail(db, ownerEmail);
  const result = await grantCompSubscription(db, { workspaceId, months, force });

  if (!result.granted && result.reason === "lifetime_license") {
    console.error([
      `Refused: workspace ${workspaceId} (${ownerEmail}) already has a paid lifetime license.`,
      "A comp would replace it with one that expires. Rerun with --force only if that is intended.",
    ].join("\n"));
    process.exit(1);
  }

  if (!result.granted) {
    console.error([
      `Refused: workspace ${workspaceId} (${ownerEmail}) still has a live Dodo subscription.`,
      "Cancel the customer's subscription in the Dodo dashboard first, or rerun with --force to override.",
    ].join("\n"));
    process.exit(1);
  }

  console.log(`Granted a ${months}-month comp for ${ownerEmail} (workspace ${workspaceId}). Ends ${result.endsAt.toISOString()}.`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command) usage();

  const env = loadAppEnv();
  const pool = createPgPool(env.DATABASE_URL, { max: 2, applicationName: "inboxjoy-billing-admin" });
  const db = createDb(pool);

  try {
    if (command === "status") return await runStatus(db, env, args);
    if (command === "comp") return await runComp(db, args);
    usage(`Unknown command: ${command}`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
