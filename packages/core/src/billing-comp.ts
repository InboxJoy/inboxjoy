import { schema, type InboxJoyDb } from "@inboxjoy/db";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { isLifetimeSubscriptionRow } from "./billing-lifetime.js";
import { releasePlanBlockedSends } from "./billing-release.js";

// Founder-granted free ("comp") subscriptions. A comp is just a row in the
// existing `subscriptions` table with no `dodo_subscription_id` — entitlement
// keeps flowing through the single existing hasSendingEntitlement()/worker SQL
// path (both key on status/trial_end/updated_at only). This file never touches
// can-send.ts or the Dodo upsert path; it only writes rows those paths already
// understand.

// Accepts either the pooled db or a transaction handle, matching the pattern
// in ./affiliate.ts.
export type CompDb = Pick<InboxJoyDb, "select" | "insert" | "delete" | "transaction">;

// Dodo subscription statuses that mean a customer is still actually being
// billed by Dodo. Mirrors providerSubscriptionIsLive() in ./index.ts.
const LIVE_DODO_STATUSES = new Set(["active", "trialing", "on_hold", "paused"]);

function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  result.setUTCMonth(result.getUTCMonth() + months);
  return result;
}

export type WorkspaceSubscriptionDescription = {
  exists: boolean;
  status: string | null;
  productId: string | null;
  hasDodoSubscription: boolean;
  isComp: boolean;
  isLifetime: boolean;
  nextBillingDate: Date | null;
  trialEnd: Date | null;
  cancelAtPeriodEnd: boolean;
};

export async function describeWorkspaceSubscription(db: CompDb, workspaceId: string): Promise<WorkspaceSubscriptionDescription> {
  const [row] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, workspaceId)).limit(1);
  if (!row) {
    return {
      exists: false,
      status: null,
      productId: null,
      hasDodoSubscription: false,
      isComp: false,
      isLifetime: false,
      nextBillingDate: null,
      trialEnd: null,
      cancelAtPeriodEnd: false,
    };
  }
  return {
    exists: true,
    status: row.status,
    productId: row.productId,
    hasDodoSubscription: row.dodoSubscriptionId !== null,
    isComp: row.metadata?.comp === true,
    isLifetime: isLifetimeSubscriptionRow(row),
    nextBillingDate: row.nextBillingDate,
    trialEnd: row.trialEnd,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
  };
}

export type GrantCompSubscriptionInput = {
  workspaceId: string;
  months: number;
  force?: boolean;
  now?: Date;
};

export type GrantCompSubscriptionResult =
  | { granted: true; endsAt: Date }
  | { granted: false; reason: "live_dodo_subscription" | "lifetime_license" };

export async function grantCompSubscription(db: CompDb, input: GrantCompSubscriptionInput): Promise<GrantCompSubscriptionResult> {
  const now = input.now ?? new Date();
  if (!Number.isInteger(input.months) || input.months < 1) throw new Error("A comp must last a whole number of months, at least 1.");
  const endsAt = addMonths(now, input.months);

  return db.transaction(async (tx) => {
    const [existing] = await tx.select({
      dodoSubscriptionId: schema.subscriptions.dodoSubscriptionId,
      status: schema.subscriptions.status,
      metadata: schema.subscriptions.metadata,
    }).from(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, input.workspaceId)).limit(1);

    // A paid lifetime license already outranks any comp; replacing it would
    // turn a paid-forever workspace into one that expires.
    if (!input.force && existing?.status === "active" && isLifetimeSubscriptionRow(existing)) {
      return { granted: false, reason: "lifetime_license" as const };
    }

    // Refuse when the customer is still being billed by Dodo, unless forced —
    // the next Dodo webhook would otherwise overwrite the comp (see
    // dodoSubscriptionUpsertWhere() in ./index.ts).
    if (!input.force && existing?.dodoSubscriptionId && LIVE_DODO_STATUSES.has(existing.status)) {
      return { granted: false, reason: "live_dodo_subscription" as const };
    }

    const metadata = {
      comp: true,
      compMonths: input.months,
      compGrantedAt: now.toISOString(),
      compEndsAt: endsAt.toISOString(),
    };

    await tx.insert(schema.subscriptions).values({
      id: randomUUID(),
      workspaceId: input.workspaceId,
      status: "active",
      productId: null,
      nextBillingDate: endsAt,
      trialEnd: null,
      cancelAtPeriodEnd: true,
      dodoSubscriptionId: null,
      dodoCustomerId: null,
      // Setting providerUpdatedAt to "now" means an older, late-arriving Dodo
      // payload (providerUpdatedAt < now) fails dodoSubscriptionUpsertWhere()'s
      // freshness check and cannot overwrite the comp; a genuinely newer live
      // Dodo subscription still can (the customer became a real payer).
      providerUpdatedAt: now,
      metadata,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: schema.subscriptions.workspaceId,
      set: {
        status: "active",
        productId: null,
        nextBillingDate: endsAt,
        trialEnd: null,
        cancelAtPeriodEnd: true,
        dodoSubscriptionId: null,
        // dodoCustomerId is intentionally left out of `set` so an existing
        // Dodo customer id on the row survives the grant unchanged.
        providerUpdatedAt: now,
        metadata,
        updatedAt: now,
      },
    });

    await tx.delete(schema.billingCheckoutIntents).where(eq(schema.billingCheckoutIntents.workspaceId, input.workspaceId));
    // Campaign email parked while the workspace had no license goes out now.
    await releasePlanBlockedSends(tx, input.workspaceId, now);

    return { granted: true as const, endsAt };
  });
}

export async function expireCompSubscriptions(db: Pick<InboxJoyDb, "execute">, now: Date = new Date()): Promise<number> {
  const result = await db.execute(sql`
    UPDATE subscriptions
    SET status = 'expired', updated_at = ${now}
    WHERE status = 'active'
      AND dodo_subscription_id IS NULL
      AND metadata->>'comp' = 'true'
      AND next_billing_date IS NOT NULL
      AND next_billing_date < ${now}
  `);
  return result.rowCount ?? 0;
}
