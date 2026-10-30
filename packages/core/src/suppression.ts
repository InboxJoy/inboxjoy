import { schema, type InboxJoyDb } from "@inboxjoy/db";
import { and, eq } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";

import { cascadeSuppression } from "./index.js";
import { retryTransaction } from "./transaction-retry.js";

export type ApplySuppressionInput = {
  workspaceId: string;
  normalizedEmail: string;
  email: string;
  reason: string;
  source: string;
  contactId?: string;
  signedTokenHash?: string;
  userAgent?: string;
  ipHash?: string;
};

// The one suppression path shared by the one-click footer link, a reply opt-out
// arriving by provider webhook (API) and a reply opt-out polled over IMAP
// (worker): suppression row, contact suppressed, every live enrollment across all
// campaigns stopped, pending messages cancelled. It lived as a closure inside
// app.ts, which is why the worker could not reach it and SMTP opt-outs were
// never suppressed.
export async function applySuppression(
  db: InboxJoyDb,
  input: ApplySuppressionInput,
): Promise<typeof schema.suppressions.$inferSelect> {
  return retryTransaction(() => db.transaction(async (tx) => {
    const contactFilters = [
      eq(schema.contacts.workspaceId, input.workspaceId),
      eq(schema.contacts.normalizedEmail, input.normalizedEmail),
    ];
    if (input.contactId) contactFilters.push(eq(schema.contacts.id, input.contactId));
    const [contact] = await tx.select().from(schema.contacts).where(and(...contactFilters)).limit(1);

    const emailHash = createHash("sha256").update(input.normalizedEmail).digest("hex");
    let [suppression] = await tx.insert(schema.suppressions).values({
      id: randomUUID(),
      workspaceId: input.workspaceId,
      email: input.email,
      normalizedEmail: input.normalizedEmail,
      emailHash,
      reason: input.reason,
      source: input.source,
      evidence: input.signedTokenHash ? { signedTokenHash: input.signedTokenHash } : {},
    }).onConflictDoNothing().returning();
    if (!suppression) {
      [suppression] = await tx.select().from(schema.suppressions).where(and(
        eq(schema.suppressions.workspaceId, input.workspaceId),
        eq(schema.suppressions.normalizedEmail, input.normalizedEmail),
      )).limit(1);
    }
    if (!suppression) throw new Error("Could not create suppression record");

    if (contact) {
      // Shared with the suppressions.add operation so both paths cascade
      // identically -- two copies of this is how the manual path silently
      // stopped short of stopping enrollments.
      await cascadeSuppression(tx, { workspaceId: input.workspaceId, contactId: contact.id, reason: input.reason });

      if (input.signedTokenHash) {
        await tx.insert(schema.unsubscribes).values({
          id: randomUUID(),
          workspaceId: input.workspaceId,
          contactId: contact.id,
          suppressionId: suppression.id,
          signedTokenHash: input.signedTokenHash,
          userAgent: input.userAgent,
          ipHash: input.ipHash,
        }).onConflictDoNothing();
      }
    }

    return suppression;
  }));
}
