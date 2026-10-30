import { schema, type InboxJoyDb } from "@inboxjoy/db";
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";

export type InvitationRow = typeof schema.invitations.$inferSelect;

const workspaceIdSchema = z.string().uuid();

// An invitation link carries `<workspaceId>.<secret>`; only the SHA-256 of the
// whole token is stored. Returns the workspace the token names, or null when
// the value cannot be an invitation token (so it is never looked up).
export function invitationTokenWorkspaceId(token: unknown): string | null {
  if (typeof token !== "string" || token.length > 200) return null;
  const workspaceId = token.split(".", 1)[0]!;
  return workspaceIdSchema.safeParse(workspaceId).success ? workspaceId : null;
}

// The invitation a link points at, whatever its state (accepted, expired, sent
// to another address): callers decide what each state means. null for a
// malformed, unknown or revoked token.
export async function findInvitationByToken(db: InboxJoyDb, token: unknown): Promise<InvitationRow | null> {
  const workspaceId = invitationTokenWorkspaceId(token);
  if (!workspaceId) return null;
  const tokenHash = createHash("sha256").update(token as string).digest("hex");
  const [invitation] = await db.select().from(schema.invitations)
    .where(and(eq(schema.invitations.workspaceId, workspaceId), eq(schema.invitations.tokenHash, tokenHash)))
    .limit(1);
  return invitation ?? null;
}
