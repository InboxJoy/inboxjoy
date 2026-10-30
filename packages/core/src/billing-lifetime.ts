import { schema, type InboxJoyDb } from "@inboxjoy/db";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { releasePlanBlockedSends } from "./billing-release.js";

// Lifetime license: a one-time Dodo payment instead of a subscription. Like a
// comp (./billing-comp.ts) it is a row in the existing `subscriptions` table
// with no `dodo_subscription_id`, status "active" and no end date, so
// entitlement keeps flowing through the single hasSendingEntitlement()/worker
// SQL path unchanged. `metadata.lifetime` marks the row so tier mapping, comp
// grants and Dodo subscription webhooks leave it alone. A full refund or a lost
// dispute moves it to "refunded", which is not a paid status.

export const LIFETIME_REVOKED_STATUS = "refunded";

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function dateValue(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function isLifetimeSubscriptionRow(row: { metadata?: Record<string, unknown> | null } | null | undefined): boolean {
  return row?.metadata?.lifetime === true;
}

// True when a Dodo payment bought the lifetime product. Subscription renewals
// carry a subscription_id and never count, whatever their cart says.
export function isLifetimePayment(rawPayment: unknown, lifetimeProductId: string | undefined): boolean {
  if (!lifetimeProductId) return false;
  const payment = objectValue(rawPayment);
  if (stringValue(payment.subscription_id)) return false;
  const cart = payment.product_cart;
  return Array.isArray(cart) && cart.some((item) => objectValue(item).product_id === lifetimeProductId);
}

export function lifetimePaymentWorkspaceId(rawPayment: unknown): string | undefined {
  const metadata = objectValue(objectValue(rawPayment).metadata);
  return stringValue(metadata.workspaceId) ?? stringValue(metadata.workspace_id);
}

// A payment that still entitles its workspace: succeeded (when the provider
// reports a status) and not fully refunded.
export function lifetimePaymentStillValid(rawPayment: unknown): boolean {
  const payment = objectValue(rawPayment);
  const status = stringValue(payment.status);
  if (status && status !== "succeeded") return false;
  return payment.refund_status !== "full";
}

// Picks the newest valid lifetime payment for a workspace from a provider
// listing. A payment tagged with another workspace never matches; an untagged
// one matches only through the workspace's own Dodo customer id.
export function findWorkspaceLifetimePayment(
  candidates: unknown[],
  input: { workspaceId: string; lifetimeProductId: string | undefined; dodoCustomerId?: string | null },
): Record<string, unknown> | undefined {
  return candidates.map(objectValue)
    .filter((payment) => isLifetimePayment(payment, input.lifetimeProductId) && lifetimePaymentStillValid(payment) && stringValue(payment.payment_id))
    .filter((payment) => {
      const workspaceId = lifetimePaymentWorkspaceId(payment);
      if (workspaceId) return workspaceId === input.workspaceId;
      return Boolean(input.dodoCustomerId && stringValue(objectValue(payment.customer).customer_id) === input.dodoCustomerId);
    })
    .sort((left, right) => (dateValue(right.created_at)?.getTime() ?? 0) - (dateValue(left.created_at)?.getTime() ?? 0))[0];
}

export type GrantLifetimeLicenseInput = {
  workspaceId: string;
  productId: string;
  payment: unknown;
  now?: Date;
};

export type GrantLifetimeLicenseResult = { granted: boolean; dodoPaymentId: string };

export async function grantLifetimeLicense(db: Pick<InboxJoyDb, "insert" | "execute">, input: GrantLifetimeLicenseInput): Promise<GrantLifetimeLicenseResult> {
  const payment = objectValue(input.payment);
  const dodoPaymentId = stringValue(payment.payment_id);
  if (!dodoPaymentId) throw new Error("Lifetime payment is missing its payment_id.");
  const now = input.now ?? new Date();
  const paidAt = dateValue(payment.created_at) ?? now;
  const metadata = { lifetime: true, dodoPaymentId, lifetimePaidAt: paidAt.toISOString() };

  const persisted = await db.insert(schema.subscriptions).values({
    id: randomUUID(),
    workspaceId: input.workspaceId,
    status: "active",
    productId: input.productId,
    dodoCustomerId: stringValue(objectValue(payment.customer).customer_id) ?? null,
    dodoSubscriptionId: null,
    nextBillingDate: null,
    trialEnd: null,
    cancelAtPeriodEnd: false,
    providerUpdatedAt: paidAt,
    metadata,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: schema.subscriptions.workspaceId,
    set: {
      status: "active",
      productId: input.productId,
      dodoCustomerId: sql`COALESCE(excluded.dodo_customer_id, ${schema.subscriptions.dodoCustomerId})`,
      dodoSubscriptionId: null,
      nextBillingDate: null,
      trialEnd: null,
      cancelAtPeriodEnd: false,
      providerUpdatedAt: paidAt,
      metadata,
      updatedAt: now,
    },
    // A refunded payment never grants again (a webhook replay or a stale
    // provider listing), and a license already granted for it stays as is.
    // Only lifetime rows carry metadata.dodoPaymentId.
    where: sql`(${schema.subscriptions.metadata}->>'dodoPaymentId') IS DISTINCT FROM ${dodoPaymentId}`,
  }).returning({ id: schema.subscriptions.id });

  // Campaign email parked while the workspace had no license goes out now.
  if (persisted.length > 0) await releasePlanBlockedSends(db, input.workspaceId, now);
  return { granted: persisted.length > 0, dodoPaymentId };
}

// Ends the lifetime license bought by this payment. Returns the affected
// workspace, or undefined when the payment was not a lifetime purchase.
export async function revokeLifetimeLicense(db: Pick<InboxJoyDb, "execute">, input: { dodoPaymentId: string; now?: Date }): Promise<string | undefined> {
  const now = input.now ?? new Date();
  const result = await db.execute<{ workspace_id: string }>(sql`
    UPDATE subscriptions
    SET status = ${LIFETIME_REVOKED_STATUS}, updated_at = ${now}
    WHERE metadata->>'lifetime' = 'true'
      AND metadata->>'dodoPaymentId' = ${input.dodoPaymentId}
      AND status = 'active'
    RETURNING workspace_id
  `);
  return result.rows[0]?.workspace_id;
}
