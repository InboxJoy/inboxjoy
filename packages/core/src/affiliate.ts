import { schema, type InboxJoyDb } from "@inboxjoy/db";
import { and, eq, inArray, lte, ne, sql } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";

export const AFFILIATE_DEFAULT_COMMISSION_PERCENT = 30;
export const AFFILIATE_DEFAULT_COMMISSION_MONTHS = 12;
export const AFFILIATE_HOLD_DAYS = 30;
export const AFFILIATE_COOKIE_NAME = "ij_ref";
export const AFFILIATE_COOKIE_DAYS = 60;
export const affiliateCodePattern = /^[a-z0-9]{4,32}$/;

// Accepts either the pooled db or a transaction handle (both expose the same
// query-builder surface), matching how other shared operations in this package
// take their db parameter. "execute" is needed for the advisory lock that
// serializes concurrent payment/refund webhooks for the same payment id.
export type AffiliateDb = Pick<InboxJoyDb, "select" | "selectDistinct" | "insert" | "update" | "transaction" | "execute">;

const CODE_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const CODE_LENGTH = 8;
const MAX_CODE_ATTEMPTS = 5;

export type AffiliateCodeInfo = {
  code: string;
  clicks: number;
  commissionPercent: number;
  commissionMonths: number;
};

function randomCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let code = "";
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    code += CODE_ALPHABET[bytes[index]! % CODE_ALPHABET.length];
  }
  return code;
}

function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  result.setUTCMonth(result.getUTCMonth() + months);
  return result;
}

export function normalizeAffiliateCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return affiliateCodePattern.test(normalized) ? normalized : null;
}

export async function ensureAffiliateCode(db: AffiliateDb, workspaceId: string): Promise<AffiliateCodeInfo> {
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
    const [existing] = await db.select().from(schema.affiliateCodes).where(eq(schema.affiliateCodes.workspaceId, workspaceId)).limit(1);
    if (existing) {
      return {
        code: existing.code,
        clicks: existing.clicks,
        commissionPercent: existing.commissionPercent ?? AFFILIATE_DEFAULT_COMMISSION_PERCENT,
        commissionMonths: existing.commissionMonths ?? AFFILIATE_DEFAULT_COMMISSION_MONTHS,
      };
    }
    // onConflictDoNothing without a target covers both races: another request
    // creating this workspace's row, and a random code colliding with a
    // different workspace's code. Either way we loop and re-select above.
    const inserted = await db.insert(schema.affiliateCodes).values({ id: randomUUID(), workspaceId, code: randomCode() }).onConflictDoNothing().returning();
    if (inserted[0]) {
      return {
        code: inserted[0].code,
        clicks: inserted[0].clicks,
        commissionPercent: inserted[0].commissionPercent ?? AFFILIATE_DEFAULT_COMMISSION_PERCENT,
        commissionMonths: inserted[0].commissionMonths ?? AFFILIATE_DEFAULT_COMMISSION_MONTHS,
      };
    }
  }
  const [existing] = await db.select().from(schema.affiliateCodes).where(eq(schema.affiliateCodes.workspaceId, workspaceId)).limit(1);
  if (!existing) throw new Error("Unable to create an affiliate code for this workspace.");
  return {
    code: existing.code,
    clicks: existing.clicks,
    commissionPercent: existing.commissionPercent ?? AFFILIATE_DEFAULT_COMMISSION_PERCENT,
    commissionMonths: existing.commissionMonths ?? AFFILIATE_DEFAULT_COMMISSION_MONTHS,
  };
}

export async function recordAffiliateClick(db: AffiliateDb, code: string): Promise<boolean> {
  const normalized = normalizeAffiliateCode(code);
  if (!normalized) return false;
  const updated = await db.update(schema.affiliateCodes)
    .set({ clicks: sql`${schema.affiliateCodes.clicks} + 1`, updatedAt: new Date() })
    .where(eq(schema.affiliateCodes.code, normalized))
    .returning({ id: schema.affiliateCodes.id });
  return updated.length > 0;
}

export async function attributeReferral(db: AffiliateDb, input: { code: string; referredWorkspaceId: string }): Promise<"attributed" | "ignored"> {
  const normalized = normalizeAffiliateCode(input.code);
  if (!normalized) return "ignored";

  const [affiliate] = await db.select({ workspaceId: schema.affiliateCodes.workspaceId }).from(schema.affiliateCodes).where(eq(schema.affiliateCodes.code, normalized)).limit(1);
  if (!affiliate) return "ignored";
  if (affiliate.workspaceId === input.referredWorkspaceId) return "ignored";

  const [referredOwner] = await db.select({ userId: schema.memberships.userId })
    .from(schema.memberships)
    .where(and(
      eq(schema.memberships.workspaceId, input.referredWorkspaceId),
      eq(schema.memberships.role, "owner"),
      eq(schema.memberships.status, "active"),
    ))
    .orderBy(schema.memberships.createdAt)
    .limit(1);
  if (referredOwner) {
    const [sharedMembership] = await db.select({ id: schema.memberships.id })
      .from(schema.memberships)
      .where(and(
        eq(schema.memberships.workspaceId, affiliate.workspaceId),
        eq(schema.memberships.userId, referredOwner.userId),
      ))
      .limit(1);
    if (sharedMembership) return "ignored";
  }

  const [existingReferral] = await db.select({ id: schema.affiliateReferrals.id }).from(schema.affiliateReferrals).where(eq(schema.affiliateReferrals.referredWorkspaceId, input.referredWorkspaceId)).limit(1);
  if (existingReferral) return "ignored";

  const inserted = await db.insert(schema.affiliateReferrals).values({
    id: randomUUID(),
    affiliateWorkspaceId: affiliate.workspaceId,
    referredWorkspaceId: input.referredWorkspaceId,
    code: normalized,
  }).onConflictDoNothing({ target: schema.affiliateReferrals.referredWorkspaceId }).returning({ id: schema.affiliateReferrals.id });

  return inserted[0] ? "attributed" : "ignored";
}

// Both affiliate-payment functions take the same advisory lock, keyed on the
// dodo payment id, before reading or writing anything. A payment and its
// refund can arrive as two concurrent webhook transactions; without this lock
// they can interleave (both read "no commission yet", both decide
// independently) and the refund-before-payment handling below would race.
function affiliatePaymentLock(dodoPaymentId: string) {
  return sql`select pg_advisory_xact_lock(hashtextextended(${`affiliate-payment:${dodoPaymentId}`}, 0))`;
}

export async function recordAffiliateCommission(db: AffiliateDb, input: { referredWorkspaceId: string; dodoPaymentId: string; amountCents: number; currency: string; paidAt: Date }): Promise<"recorded" | "recorded_reversed" | "skipped"> {
  if (input.amountCents <= 0) return "skipped";

  await db.execute(affiliatePaymentLock(input.dodoPaymentId));

  const [referral] = await db.select().from(schema.affiliateReferrals).where(eq(schema.affiliateReferrals.referredWorkspaceId, input.referredWorkspaceId)).limit(1);
  if (!referral) return "skipped";

  const [affiliate] = await db.select().from(schema.affiliateCodes).where(eq(schema.affiliateCodes.workspaceId, referral.affiliateWorkspaceId)).limit(1);
  const effectivePercent = affiliate?.commissionPercent ?? AFFILIATE_DEFAULT_COMMISSION_PERCENT;
  const effectiveMonths = affiliate?.commissionMonths ?? AFFILIATE_DEFAULT_COMMISSION_MONTHS;

  const windowStart = referral.firstPaidAt ?? input.paidAt;
  const windowEnd = addMonths(windowStart, effectiveMonths);
  if (input.paidAt.getTime() > windowEnd.getTime()) return "skipped";

  const commissionCents = Math.floor((input.amountCents * effectivePercent) / 100);
  const availableAt = new Date(input.paidAt.getTime() + AFFILIATE_HOLD_DAYS * 86_400_000);

  // A refund can arrive before the payment webhook it refunds. When this
  // payment id is already marked refunded, record the commission as reversed
  // from the start instead of briefly going "pending" -- the end state must
  // match the in-order flow (record pending, then reverse), not hand out a
  // hold period on money that is already gone.
  const [refundMarker] = await db.select({ dodoPaymentId: schema.affiliateRefundedPayments.dodoPaymentId })
    .from(schema.affiliateRefundedPayments)
    .where(eq(schema.affiliateRefundedPayments.dodoPaymentId, input.dodoPaymentId))
    .limit(1);

  const inserted = await db.insert(schema.affiliateCommissions).values({
    id: randomUUID(),
    referralId: referral.id,
    affiliateWorkspaceId: referral.affiliateWorkspaceId,
    dodoPaymentId: input.dodoPaymentId,
    paymentAmountCents: input.amountCents,
    currency: input.currency,
    commissionPercent: effectivePercent,
    commissionCents,
    availableAt,
    ...(refundMarker ? { status: "reversed" as const } : {}),
  }).onConflictDoNothing({ target: schema.affiliateCommissions.dodoPaymentId }).returning({ id: schema.affiliateCommissions.id });

  if (!inserted[0]) return "skipped";

  // Unconditional, the same as the in-order flow: the referral is marked paid
  // off the payment itself, independent of whether its commission ended up
  // pending or (because of a same-payment refund already on file) reversed.
  if (referral.status !== "paid") {
    await db.update(schema.affiliateReferrals)
      .set({ status: "paid", firstPaidAt: referral.firstPaidAt ?? input.paidAt, updatedAt: new Date() })
      .where(eq(schema.affiliateReferrals.id, referral.id));
  }

  return refundMarker ? "recorded_reversed" : "recorded";
}

export type ReverseAffiliateCommissionResult = {
  // Whether a pending commission row for this payment id was flipped to reversed.
  reversed: boolean;
  // Set when the commission for this payment id was already paid out, so the
  // refund could not be clawed back automatically -- the caller should alert
  // someone to follow up manually.
  alreadyPaid: { commissionId: string; commissionCents: number; currency: string; affiliateWorkspaceId: string } | null;
};

export async function reverseAffiliateCommission(db: AffiliateDb, input: { dodoPaymentId: string }): Promise<ReverseAffiliateCommissionResult> {
  await db.execute(affiliatePaymentLock(input.dodoPaymentId));

  // Record the refund marker before touching any commission row. This must
  // happen whether or not a commission row exists yet, so a payment.succeeded
  // for this payment id -- already processed, or still to arrive -- can
  // always find it and record (or has recorded) the commission as reversed.
  await db.insert(schema.affiliateRefundedPayments).values({ dodoPaymentId: input.dodoPaymentId }).onConflictDoNothing();

  const updated = await db.update(schema.affiliateCommissions)
    .set({ status: "reversed", updatedAt: new Date() })
    .where(and(eq(schema.affiliateCommissions.dodoPaymentId, input.dodoPaymentId), ne(schema.affiliateCommissions.status, "paid")))
    .returning({ id: schema.affiliateCommissions.id });

  if (updated.length > 0) return { reversed: true, alreadyPaid: null };

  const [alreadyPaidRow] = await db.select({
    id: schema.affiliateCommissions.id,
    commissionCents: schema.affiliateCommissions.commissionCents,
    currency: schema.affiliateCommissions.currency,
    affiliateWorkspaceId: schema.affiliateCommissions.affiliateWorkspaceId,
  }).from(schema.affiliateCommissions)
    .where(and(eq(schema.affiliateCommissions.dodoPaymentId, input.dodoPaymentId), eq(schema.affiliateCommissions.status, "paid")))
    .limit(1);

  return {
    reversed: false,
    alreadyPaid: alreadyPaidRow
      ? { commissionId: alreadyPaidRow.id, commissionCents: alreadyPaidRow.commissionCents, currency: alreadyPaidRow.currency, affiliateWorkspaceId: alreadyPaidRow.affiliateWorkspaceId }
      : null,
  };
}

export async function setAffiliateCommission(db: AffiliateDb, input: { workspaceId: string; percent: number | null; months: number | null }): Promise<void> {
  if (input.percent !== null && (!Number.isInteger(input.percent) || input.percent < 0 || input.percent > 100)) {
    throw new Error("Commission percent must be between 0 and 100.");
  }
  if (input.months !== null && (!Number.isInteger(input.months) || input.months < 1 || input.months > 120)) {
    throw new Error("Commission months must be between 1 and 120.");
  }
  await ensureAffiliateCode(db, input.workspaceId);
  await db.update(schema.affiliateCodes)
    .set({ commissionPercent: input.percent, commissionMonths: input.months, updatedAt: new Date() })
    .where(eq(schema.affiliateCodes.workspaceId, input.workspaceId));
}

export type AffiliatePayoutDue = {
  workspaceId: string;
  ownerEmail: string | null;
  code: string;
  currency: string;
  dueCents: number;
  commissionCount: number;
};

export async function listAffiliatePayoutsDue(db: AffiliateDb, now: Date = new Date()): Promise<AffiliatePayoutDue[]> {
  const rows = await db.select({
    workspaceId: schema.affiliateCommissions.affiliateWorkspaceId,
    currency: schema.affiliateCommissions.currency,
    dueCents: sql<number>`sum(${schema.affiliateCommissions.commissionCents})`.mapWith(Number),
    commissionCount: sql<number>`count(*)`.mapWith(Number),
  }).from(schema.affiliateCommissions)
    .where(and(eq(schema.affiliateCommissions.status, "pending"), lte(schema.affiliateCommissions.availableAt, now)))
    .groupBy(schema.affiliateCommissions.affiliateWorkspaceId, schema.affiliateCommissions.currency);

  if (!rows.length) return [];

  const workspaceIds = [...new Set(rows.map((row) => row.workspaceId))];

  const codes = await db.select({ workspaceId: schema.affiliateCodes.workspaceId, code: schema.affiliateCodes.code })
    .from(schema.affiliateCodes)
    .where(inArray(schema.affiliateCodes.workspaceId, workspaceIds));
  const codeByWorkspace = new Map(codes.map((row) => [row.workspaceId, row.code]));

  const owners = await db.select({
    workspaceId: schema.memberships.workspaceId,
    email: schema.users.email,
    createdAt: schema.memberships.createdAt,
  }).from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .where(and(
      inArray(schema.memberships.workspaceId, workspaceIds),
      eq(schema.memberships.role, "owner"),
      eq(schema.memberships.status, "active"),
    ));
  const ownerByWorkspace = new Map<string, { email: string; createdAt: Date }>();
  for (const owner of owners) {
    const current = ownerByWorkspace.get(owner.workspaceId);
    if (!current || owner.createdAt < current.createdAt) {
      ownerByWorkspace.set(owner.workspaceId, { email: owner.email, createdAt: owner.createdAt });
    }
  }

  return rows.map((row) => ({
    workspaceId: row.workspaceId,
    ownerEmail: ownerByWorkspace.get(row.workspaceId)?.email ?? null,
    code: codeByWorkspace.get(row.workspaceId) ?? "",
    currency: row.currency,
    dueCents: row.dueCents,
    commissionCount: row.commissionCount,
  }));
}

export async function markAffiliateCommissionsPaid(db: AffiliateDb, input: { workspaceId: string; now?: Date }): Promise<{ paidCents: number; commissionCount: number }> {
  const now = input.now ?? new Date();
  const updated = await db.update(schema.affiliateCommissions)
    .set({ status: "paid", paidAt: now, updatedAt: now })
    .where(and(
      eq(schema.affiliateCommissions.affiliateWorkspaceId, input.workspaceId),
      eq(schema.affiliateCommissions.status, "pending"),
      lte(schema.affiliateCommissions.availableAt, now),
    ))
    .returning({ commissionCents: schema.affiliateCommissions.commissionCents });

  return {
    paidCents: updated.reduce((sum, row) => sum + row.commissionCents, 0),
    commissionCount: updated.length,
  };
}
